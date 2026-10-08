import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]), {
    headers: { "content-type": "image/png" },
  });
