import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const LOCAL_ENDPOINT = "127.0.0.1:3000";
const DEFAULT_WAIT_MS = 1000;
const MAX_WAIT_MS = 5000;
const EVENT_INTERVAL_MS = 200;
const EVENT_COUNT = 3;

// Lambda supplies both the host and port. Binding to localhost or assuming a
// fixed port in the cloud prevents the runtime from reaching this server.
const listenAddress = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? LOCAL_ENDPOINT;
const endpoint = new URL(`http://${listenAddress}`);
const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
// URL.port normalizes :80 to an empty string; keep the explicit runtime port.
const port = Number(listenAddress.slice(listenAddress.lastIndexOf(":") + 1));
if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("AWS_LAMBDA_HTTP_ENDPOINT must contain a host and port");
}

let activeRequests = 0;

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  activeRequests++;
  let finished = false;
  const controller = new AbortController();
  const finish = () => {
    if (finished) return;
    finished = true;
    activeRequests--;
    controller.abort();
  };
  response.once("finish", finish);
  response.once("close", finish);

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      json(response, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(process.env.GREETING ?? "Hello from a Lambda Web Function");
      return;
    }

    if (url.pathname === "/json") {
      json(response, 200, { runtime: process.version, activeRequests });
      return;
    }

    if (url.pathname === "/wait") {
      const duration = Number(url.searchParams.get("ms") ?? DEFAULT_WAIT_MS);
      if (
        !Number.isInteger(duration) ||
        duration < 0 ||
        duration > MAX_WAIT_MS
      ) {
        json(response, 400, {
          error: `ms must be an integer between 0 and ${MAX_WAIT_MS}`,
        });
        return;
      }
      const id = url.searchParams.get("id") ?? "request";
      const started = Date.now();
      await delay(duration, undefined, { signal: controller.signal });
      json(response, 200, {
        id,
        elapsedMs: Date.now() - started,
        activeRequests,
      });
      return;
    }

    if (url.pathname === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      response.flushHeaders();
      for (let count = 1; count <= EVENT_COUNT; count++) {
        response.write(
          `id: ${count}\nevent: tick\ndata: ${JSON.stringify({ count })}\n\n`,
        );
        await delay(EVENT_INTERVAL_MS, undefined, {
          signal: controller.signal,
        });
      }
      response.end("event: done\ndata: complete\n\n");
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error(error);
    if (!response.headersSent)
      json(response, 500, { error: "Internal server error" });
    else response.destroy();
  }
});

server.listen(port, hostname, () => {
  console.log(`Listening on http://${hostname}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
