import fs from "fs/promises";
import type { SSRManifest } from "astro";
import type {
  APIGatewayProxyEventV2,
  CloudFrontRequestEvent,
} from "aws-lambda";
import * as astroNode from "astro/app/node";
import type { IntegrationConfig } from "../lib/build-meta";
import { convertFrom, convertTo } from "../lib/event-mapper.js";
import { debug } from "../lib/logger.js";
import type { ResponseStream } from "../lib/types";
import {
  build404Url,
  createRequest,
  existsAsync,
  streamError,
} from "../lib/entrypoint-utils.js";

// The Astro 5 entrypoint. Astro 6 and later use buffer.ts and stream.ts.
const { NodeApp } = astroNode;

// Astro 5 supports Node 18, which lacks globals Astro uses. Astro 6 removed
// applyPolyfills, and this package is type-checked against Astro 7, so it's
// looked up rather than imported by name.
(astroNode as { applyPolyfills?: () => void }).applyPolyfills?.();

export function createExports(
  manifest: SSRManifest,
  { responseMode }: IntegrationConfig
) {
  debug("handlerInit", responseMode);

  const isStreaming = responseMode === "stream";
  const app = new NodeApp(manifest);

  async function streamHandler(
    event: APIGatewayProxyEventV2,
    responseStream: ResponseStream
  ) {
    debug("event", event);

    const internalEvent = convertFrom(event);
    let request = createRequest(internalEvent);
    let routeData = app.match(request);
    if (!routeData) {
      // handle prerendered 404
      if (await existsAsync("404.html")) {
        return streamError(
          404,
          await fs.readFile("404.html", "utf-8"),
          responseStream
        );
      }

      // handle server-side 404
      request = createRequest({
        ...internalEvent,
        url: build404Url(internalEvent.url),
      });
      routeData = app.match(request);
      if (!routeData) {
        return streamError(404, "Not found", responseStream);
      }
    }

    const response = await app.render(request, {
      routeData,
      clientAddress:
        internalEvent.headers["x-forwarded-for"] || internalEvent.remoteAddress,
    });

    // Stream response back to Cloudfront
    const convertedResponse = await convertTo({
      type: internalEvent.type,
      response,
      responseStream,
      cookies: Array.from(app.setCookieHeaders(response)),
    });

    debug("response", convertedResponse);
  }

  async function bufferHandler(
    event: APIGatewayProxyEventV2 | CloudFrontRequestEvent
  ) {
    debug("event", event);

    const internalEvent = convertFrom(event);
    let request = createRequest(internalEvent);
    let routeData = app.match(request);
    if (!routeData) {
      // handle prerendered 404
      if (await existsAsync("404.html")) {
        return convertTo({
          type: internalEvent.type,
          response: new Response(await fs.readFile("404.html", "utf-8"), {
            status: 404,
            headers: {
              "Content-Type": "text/html",
            },
          }),
        });
      }

      // handle server-side 404
      request = createRequest({
        ...internalEvent,
        url: build404Url(internalEvent.url),
      });
      routeData = app.match(request);
      if (!routeData) {
        return convertTo({
          type: internalEvent.type,
          response: new Response("Not found", { status: 404 }),
        });
      }
    }

    // Process request
    const response = await app.render(request, {
      routeData,
      clientAddress:
        internalEvent.headers["x-forwarded-for"] || internalEvent.remoteAddress,
    });

    // Buffer response back to Cloudfront
    const convertedResponse = await convertTo({
      type: internalEvent.type,
      response,
      cookies: Array.from(app.setCookieHeaders(response)),
    });

    debug("response", convertedResponse);
    return convertedResponse;
  }

  return {
    // https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
    handler: isStreaming
      ? awslambda.streamifyResponse(streamHandler)
      : bufferHandler,
  };
}
