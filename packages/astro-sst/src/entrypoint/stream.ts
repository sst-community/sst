import { createApp } from "astro/app/entrypoint";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { convertFrom, convertTo } from "../lib/event-mapper.js";
import { debug } from "../lib/logger.js";
import type { ResponseStream } from "../lib/types";
import {
  createRequest,
  prerenderedErrorPageFetch,
} from "../lib/entrypoint-utils.js";

const app = createApp();

async function streamHandler(
  event: APIGatewayProxyEventV2,
  responseStream: ResponseStream,
) {
  debug("event", event);

  const internalEvent = convertFrom(event);
  const request = createRequest(internalEvent);

  // Astro matches the route itself, so it can redirect a trailing slash,
  // hand the request to src/fetch.ts, or render the 404 page.
  const response = await app.render(request, {
    clientAddress:
      internalEvent.headers["x-forwarded-for"] || internalEvent.remoteAddress,
    prerenderedErrorPageFetch,
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

// https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html
export const handler = awslambda.streamifyResponse(streamHandler);
