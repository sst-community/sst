import { createApp } from "astro/app/entrypoint";
import type {
  APIGatewayProxyEventV2,
  CloudFrontRequestEvent,
} from "aws-lambda";
import { convertFrom, convertTo } from "../lib/event-mapper.js";
import { debug } from "../lib/logger.js";
import {
  createRequest,
  prerenderedErrorPageFetch,
} from "../lib/entrypoint-utils.js";

const app = createApp();

export async function handler(
  event: APIGatewayProxyEventV2 | CloudFrontRequestEvent,
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

  // Buffer response back to Cloudfront
  const convertedResponse = await convertTo({
    type: internalEvent.type,
    response,
    cookies: Array.from(app.setCookieHeaders(response)),
  });

  debug("response", convertedResponse);
  return convertedResponse;
}
