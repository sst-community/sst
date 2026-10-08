import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudFrontHeaders,
} from "aws-lambda";
import type { ResponseStream } from "./types";
import { splitCookiesString } from "set-cookie-parser";
import { isBinaryResponse } from "./binary.js";
import zlib from "zlib";

export type InternalEvent = {
  readonly type: "v1" | "v2" | "cf";
  readonly method: string;
  readonly queryString: string;
  readonly rawPath: string;
  readonly url: string;
  readonly body: Buffer;
  readonly headers: Record<string, string>;
  readonly remoteAddress: string;
};

type InternalResultInput = {
  readonly type: "v1" | "v2" | "cf";
  response: Response;
  responseStream?: ResponseStream;
  cookies?: string[];
  // The request's Accept-Encoding, which says whether a stream can be gzipped
  acceptEncoding?: string;
};

type InternalResult = {
  readonly type: "v1" | "v2" | "cf";
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
  isBase64Encoded: boolean;
};

type InternalStreamingResult = {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: ReadableStream | null;
  responseStream: ResponseStream;
  isBase64Encoded: boolean;
  acceptEncoding?: string;
};

function isApigV2Event(event: any): event is APIGatewayProxyEventV2 {
  return event.version === "2.0";
}

function isApigV1Event(event: any): event is APIGatewayProxyEvent {
  return event.version === undefined && !isCfEvent(event);
}

function isCfEvent(event: any): event is CloudFrontRequestEvent {
  return event.Records !== undefined;
}

export function convertFrom(
  event: APIGatewayProxyEventV2 | APIGatewayProxyEvent | CloudFrontRequestEvent
) {
  let iEvent: Omit<InternalEvent, "url">;
  if (isCfEvent(event)) {
    iEvent = convertFromCfEvent(event);
  } else if (isApigV2Event(event)) {
    iEvent = convertFromApigV2Event(event);
  } else if (isApigV1Event(event)) {
    iEvent = convertFromApigV1Event(event);
  } else {
    throw new Error("Unsupported event type");
  }

  // Fix host header
  if (iEvent.headers["x-forwarded-host"]) {
    iEvent.headers.host = iEvent.headers["x-forwarded-host"];
  }

  // Build URL
  const scheme = iEvent.headers["x-forwarded-protocol"] || "https";
  const url = new URL(
    iEvent.queryString
      ? `${iEvent.rawPath}?${iEvent.queryString}`
      : iEvent.rawPath,
    `${scheme}://${iEvent.headers.host}`
  ).toString();

  return { ...iEvent, url } satisfies InternalEvent;
}

function convertFromApigV1Event(event: APIGatewayProxyEvent) {
  const { path, body, httpMethod, requestContext, isBase64Encoded } = event;
  const headers = normalizeApigV1Headers(event);
  return {
    type: "v1" as const,
    method: httpMethod,
    rawPath: path,
    queryString: normalizeApigV1QueryParams(event),
    body: Buffer.from(body ?? "", isBase64Encoded ? "base64" : "utf8"),
    headers,
    remoteAddress: requestContext.identity.sourceIp,
  };
}

function convertFromApigV2Event(event: APIGatewayProxyEventV2) {
  const { rawPath, rawQueryString, requestContext } = event;
  return {
    type: "v2" as const,
    method: requestContext.http.method,
    rawPath,
    queryString: rawQueryString,
    body: normalizeApigV2Body(event),
    headers: normalizeApigV2Headers(event),
    remoteAddress: requestContext.http.sourceIp,
  };
}

function convertFromCfEvent(event: CloudFrontRequestEvent) {
  const { method, uri, querystring, body, clientIp } =
    event.Records[0].cf.request;
  return {
    type: "cf" as const,
    method,
    rawPath: uri,
    queryString: querystring,
    body: Buffer.from(
      body?.data ?? "",
      body?.encoding === "base64" ? "base64" : "utf8"
    ),
    headers: normalizeCfHeaders(event),
    remoteAddress: clientIp,
  };
}

export async function convertTo({
  type,
  response,
  responseStream,
  cookies: appCookies,
  acceptEncoding,
}: InternalResultInput) {
  // Parse headers (except cookies)
  const headers: { [key: string]: string } = Array.from(
    response.headers.entries()
  )
    .filter(([key]) => key !== "set-cookie")
    .reduce((headers, [key, value]) => {
      headers[key] = value;
      return headers;
    }, {} as { [key: string]: string });

  // Set-Cookie values are passed on as they are. Parsing them and writing
  // them out again turned Max-Age into "maxAge", which browsers ignore.
  const cookies = [
    ...splitCookiesString(response.headers.getSetCookie() ?? undefined),
    ...(appCookies ?? []),
  ];

  // Bytes are sent as base64, and aren't gzipped when streamed.
  const isBase64Encoded = isBinaryResponse(headers);

  // Build streaming result
  if (type === "v2" && responseStream) {
    return convertToApigV2StreamingResult({
      statusCode: response.status,
      headers,
      body: response.body,
      cookies,
      responseStream,
      isBase64Encoded,
      acceptEncoding,
    });
  }

  // Build non-streaming result
  const result = {
    type,
    statusCode: response.status,
    headers,
    cookies,
    isBase64Encoded,
    body: isBase64Encoded
      ? Buffer.from(await response.arrayBuffer()).toString("base64")
      : await response.text(),
  };
  if (type === "v2") {
    return convertToApigV2Result(result);
  } else if (type === "v1") {
    return convertToApigV1Result(result);
  } else if (type === "cf") {
    return convertToCfResult(result);
  }
  throw new Error("Unsupported event type");
}

function convertToApigV1Result({
  headers,
  statusCode,
  body,
  isBase64Encoded,
  cookies,
}: InternalResult): APIGatewayProxyResult {
  const multiValueHeaders: Record<string, string[]> = {};
  if (cookies.length > 0) {
    multiValueHeaders["set-cookie"] = cookies;
  }

  const response: APIGatewayProxyResult = {
    statusCode,
    headers,
    multiValueHeaders,
    body,
    isBase64Encoded,
  };

  return response;
}

function convertToApigV2Result({
  headers,
  statusCode,
  body,
  isBase64Encoded,
  cookies,
}: InternalResult): APIGatewayProxyResultV2 {
  const response: APIGatewayProxyResultV2 = {
    statusCode,
    headers,
    cookies: cookies.length > 0 ? cookies : undefined,
    body,
    isBase64Encoded,
  };

  return response;
}

function convertToApigV2StreamingResult({
  statusCode,
  headers,
  cookies,
  body,
  responseStream,
  isBase64Encoded,
  acceptEncoding,
}: InternalStreamingResult) {
  const gzipped =
    !!body && !body.locked && !isBase64Encoded && acceptsGzip(acceptEncoding);
  if (gzipped) {
    headers["content-encoding"] = "gzip";
    // The app's length is the uncompressed one.
    delete headers["content-length"];
  }

  const metadata = {
    statusCode,
    headers,
    // Lambda sends each cookie as its own Set-Cookie header. Joined into one
    // header, several cookies arrived as one broken cookie.
    ...(cookies.length > 0 && { cookies }),
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);
  // Lambda sends the status and headers just before the first write. Write
  // nothing now, so they go out even if the body turns out to be empty.
  responseStream.write("");

  if (!body) {
    responseStream.end();
    return;
  }

  if (body.locked) {
    responseStream.write(
      "Fatal error: Response body is locked. " +
        `This can happen when the response was already read (for example through 'response.json()' or 'response.text()').`
    );
    responseStream.end();
    return;
  }

  const reader = body.getReader();

  if (responseStream.destroyed) {
    reader.cancel();
    return;
  }

  // Settles when the response has been sent, and rejects when the body
  // fails, so the handler rejects and Lambda's runtime reports the error.
  // Ending the response stream with the error instead makes the runtime
  // reject a promise nothing awaits, and Node exits.
  let fail: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const sent = new Promise<void>((resolve) => {
    responseStream.once("finish", resolve);
  });

  let streamToWrite: ResponseStream | zlib.Gzip;
  if (gzipped) {
    const gzip = zlib.createGzip();
    gzip.pipe(responseStream);
    streamToWrite = gzip;
  } else {
    streamToWrite = responseStream;
  }

  const cancel = (error?: Error) => {
    streamToWrite.off("close", cancel);
    streamToWrite.off("error", cancel);

    // If the reader has already been interrupted with an error earlier,
    // then it will appear here, it is useless, but it needs to be catch.
    reader.cancel(error).catch(() => {});

    if (gzipped) {
      // Unpipe the gzip stream to ensure no more data is written
      (streamToWrite as zlib.Gzip).unpipe(responseStream);

      if (error) {
        // Without an error: its listeners are gone, so the error would be
        // thrown out of the process.
        streamToWrite.destroy();
      } else {
        // In case there's no error, just close the gzip stream
        streamToWrite.end();
      }
    }
    if (error) fail(error);
  };

  streamToWrite.on("close", cancel);
  streamToWrite.on("error", cancel);

  next();
  return Promise.race([sent, failed]);
  async function next() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        if (gzipped) {
          const writer = streamToWrite as zlib.Gzip;
          const result = writer.write(value, () => {
            writer.flush(zlib.constants.Z_SYNC_FLUSH);
          });
          if (!result) {
            writer.once("drain", next);
            return;
          }
        } else {
          if (!streamToWrite.write(value)) {
            streamToWrite.once("drain", next);
            return;
          }
        }
      }

      streamToWrite.end();
    } catch (error) {
      cancel(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function convertToCfResult({
  statusCode,
  headers,
  cookies,
  body,
  isBase64Encoded,
}: InternalResult): CloudFrontRequestResult {
  const combinedHeaders = Object.entries(headers).reduce(
    (headers, [key, value]) => {
      headers[key.toLowerCase()] = [{ key, value }];
      return headers;
    },
    {} as CloudFrontHeaders
  );
  if (cookies.length > 0) {
    combinedHeaders["set-cookie"] = cookies.map((value) => ({
      key: "set-cookie",
      value,
    }));
  }

  const response: CloudFrontRequestResult = {
    // No statusDescription: CloudFront gives the standard one, which "OK"
    // was for every status.
    status: statusCode.toString(),
    headers: combinedHeaders,
    bodyEncoding: isBase64Encoded ? "base64" : "text",
    body: body,
  };

  return response;
}

function normalizeApigV2Headers({ headers, cookies }: APIGatewayProxyEventV2) {
  const combinedHeaders: Record<string, string> = {};

  if (Array.isArray(cookies)) {
    combinedHeaders["cookie"] = cookies.join("; ");
  }

  for (const [key, value] of Object.entries(headers ?? {})) {
    combinedHeaders[key.toLowerCase()] = value!;
  }

  return combinedHeaders;
}

function normalizeApigV2Body({
  body,
  isBase64Encoded,
}: APIGatewayProxyEventV2): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  } else if (typeof body === "string") {
    return Buffer.from(body, isBase64Encoded ? "base64" : "utf8");
  } else if (typeof body === "object") {
    return Buffer.from(JSON.stringify(body));
  }
  return Buffer.from("", "utf8");
}

function normalizeApigV1QueryParams({
  multiValueQueryStringParameters,
  queryStringParameters,
}: APIGatewayProxyEvent) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(
    multiValueQueryStringParameters ?? {}
  )) {
    if (value !== undefined) {
      for (const v of value) {
        params.append(key, v);
      }
    }
  }
  for (const [key, value] of Object.entries(queryStringParameters ?? {})) {
    if (value !== undefined) {
      params.append(key, value);
    }
  }
  const value = params.toString();
  return value ?? "";
}

function normalizeApigV1Headers({
  multiValueHeaders,
  headers,
}: APIGatewayProxyEvent) {
  const combinedHeaders: Record<string, string> = {};

  for (const [key, values] of Object.entries(multiValueHeaders ?? {})) {
    if (values) {
      combinedHeaders[key.toLowerCase()] = values.join(",");
    }
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value) {
      combinedHeaders[key.toLowerCase()] = value;
    }
  }

  return combinedHeaders;
}

function normalizeCfHeaders(event: CloudFrontRequestEvent) {
  const combinedHeaders: Record<string, string> = {};

  for (const [key, values] of Object.entries(
    event.Records[0].cf.request.headers
  )) {
    for (const { value } of values) {
      if (value) {
        combinedHeaders[key.toLowerCase()] = value;
      }
    }
  }

  return combinedHeaders;
}

/**
 * Whether Accept-Encoding allows gzip: "gzip", or else "*", with a q-value
 * above 0.
 */
export function acceptsGzip(acceptEncoding = "") {
  const q: Record<string, number> = {};
  for (const entry of acceptEncoding.toLowerCase().split(",")) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim());
    if (!coding) continue;
    const value = params.find((param) => param.startsWith("q="));
    q[coding] = value ? parseFloat(value.slice(2)) : 1;
  }
  return (q["gzip"] ?? q["*"] ?? 0) > 0;
}
