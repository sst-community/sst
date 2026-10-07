import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(null, { status: 204, headers: { "x-empty": "yes" } });
