import type { APIRoute } from "astro";

// A binary type that isn't on any short list of binary types.
export const GET: APIRoute = () =>
  new Response(new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80]), {
    headers: { "content-type": "image/avif" },
  });
