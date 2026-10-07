import fs from "fs/promises";
import path from "path";
import type { InternalEvent } from "./event-mapper.js";

export async function existsAsync(input: string) {
  return fs
    .access(input)
    .then(() => true)
    .catch(() => false);
}

export function createRequest(internalEvent: InternalEvent) {
  const requestUrl = internalEvent.url;
  const requestProps = {
    method: internalEvent.method,
    headers: internalEvent.headers,
    body: ["GET", "HEAD"].includes(internalEvent.method)
      ? undefined
      : internalEvent.body,
  };
  return new Request(requestUrl, requestProps);
}

/**
 * Passed to Astro's render(), which calls it for a prerendered error page
 * when a request ends in a 404 or 500. sst.aws.Astro copies 404.html next to
 * the handler, so that's read from disk. Anything else is fetched, as Astro
 * does by default.
 */
export async function prerenderedErrorPageFetch(url: string) {
  if (
    path.posix.basename(new URL(url).pathname) === "404.html" &&
    (await existsAsync("404.html"))
  ) {
    return new Response(await fs.readFile("404.html"), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return fetch(url);
}
