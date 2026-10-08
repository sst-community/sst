import type { APIRoute } from "astro";

// Sends one chunk, then fails.
export const GET: APIRoute = () => {
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new Error("failed partway"));
      sent = true;
      controller.enqueue(new TextEncoder().encode("first chunk"));
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain" } });
};
