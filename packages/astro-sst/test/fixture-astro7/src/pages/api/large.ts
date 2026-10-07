import type { APIRoute } from "astro";

// 200 numbered lines of 16 KB, sent one at a time.
export const GET: APIRoute = () => {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i === 200) return controller.close();
      const line = `${String(i++).padStart(4, "0")} ${"x".repeat(16 * 1024)}\n`;
      controller.enqueue(new TextEncoder().encode(line));
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain" } });
};
