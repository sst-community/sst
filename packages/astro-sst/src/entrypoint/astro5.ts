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
  clientAddress,
  createRequest,
  prerenderedErrorPageFetch,
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
    const request = createRequest(internalEvent);

    // Astro matches the route itself, so it can redirect a trailing slash
    // or render the 404 page.
    const response = await app.render(request, {
      clientAddress: clientAddress(internalEvent),
      prerenderedErrorPageFetch,
    });

    // Stream response back to Cloudfront
    const convertedResponse = await convertTo({
      type: internalEvent.type,
      response,
      responseStream,
      cookies: Array.from(app.setCookieHeaders(response)),
      acceptEncoding: internalEvent.headers["accept-encoding"],
    });

    debug("response", convertedResponse);
  }

  async function bufferHandler(
    event: APIGatewayProxyEventV2 | CloudFrontRequestEvent
  ) {
    debug("event", event);

    const internalEvent = convertFrom(event);
    const request = createRequest(internalEvent);

    // Astro matches the route itself, so it can redirect a trailing slash
    // or render the 404 page.
    const response = await app.render(request, {
      clientAddress: clientAddress(internalEvent),
      prerenderedErrorPageFetch,
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
