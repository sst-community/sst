import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
// @ts-ignore Generated next to the server output by `builder.generateServerInstance`
import { server } from "../server.js";
// @ts-ignore Written by the adapter when it runs
import prerenderedFiles from "./prerendered-file-list.js";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { clientAddress, convertFrom } from "./event-mapper.js";
import { debug } from "./logger.js";

// The Lambda Node.js runtime sets this global.
declare const awslambda: {
  streamifyResponse(
    handler: (
      event: APIGatewayProxyEventV2,
      responseStream: Writable,
      context: Context
    ) => Promise<void>
  ): unknown;
  HttpResponseStream: {
    from(
      responseStream: Writable,
      metadata: {
        statusCode: number;
        headers: Record<string, string>;
        cookies?: string[];
      }
    ): Writable;
  };
};

await server.init({ env: process.env as Record<string, string | undefined> });

// Used when `adapter({ streaming: true })` is set. A streamed response only
// works behind a Lambda function URL, which sends API Gateway v2 events.
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    debug("event", event);

    const internalEvent = convertFrom(event);

    // Set correct host header
    if (internalEvent.headers["x-forwarded-host"]) {
      internalEvent.headers.host = internalEvent.headers["x-forwarded-host"];
    }

    // Check request is for prerendered file
    if (internalEvent.method === "GET") {
      const filePath = isPrerenderedFile(internalEvent.rawPath);
      if (filePath) {
        const writer = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 200,
          headers: {
            "content-type": "text/html",
            "cache-control":
              "public, max-age=0, s-maxage=31536000, must-revalidate",
          },
        });
        writer.end(fs.readFileSync(path.join("prerendered", filePath)));
        return;
      }
    }

    // Process request
    const requestUrl = `https://${internalEvent.headers.host}${internalEvent.url}`;
    const request = new Request(requestUrl, {
      method: internalEvent.method,
      headers: internalEvent.headers,
      body: ["GET", "HEAD"].includes(internalEvent.method)
        ? undefined
        : new Uint8Array(internalEvent.body),
    });
    const response: Response = await server.respond(request, {
      getClientAddress: () => clientAddress(internalEvent),
    });
    debug("response", response);

    // Cookies go in `cookies`. A function URL drops `set-cookie` headers.
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") headers[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    const writer = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: response.status,
      headers,
      ...(cookies.length > 0 && { cookies }),
    });

    // Lambda sends the status and headers just before the first write, so make
    // one now, whether or not the body turns out to have anything in it. An
    // empty write sends no body bytes, which matters for a 204, a 304 and a
    // HEAD response.
    writer.write("");

    if (response.body) {
      for await (const chunk of response.body) {
        // The client is gone: leaving the loop cancels the response body.
        if (writer.destroyed) break;
        // Wait for the stream to drain, so a large body isn't held in memory.
        if (!writer.write(chunk)) await drained(writer);
      }
    }
    writer.end();
  }
);

// Settles when the stream can take more data, or when it has closed.
function drained(writer: Writable) {
  return new Promise<void>((resolve) => {
    const done = () => {
      writer.off("drain", done);
      writer.off("close", done);
      resolve();
    };
    writer.once("drain", done);
    writer.once("close", done);
  });
}

function isPrerenderedFile(uri: string) {
  // remove leading and trailing slashes
  uri = uri.replace(/^\/|\/$/g, "");

  if (uri === "") {
    return prerenderedFiles.includes("index.html") ? "index.html" : undefined;
  }

  if (prerenderedFiles.includes(uri)) {
    return uri;
  }
  if (prerenderedFiles.includes(uri + "/index.html")) {
    return uri + "/index.html";
  }
  if (prerenderedFiles.includes(uri + ".html")) {
    return uri + ".html";
  }
}
