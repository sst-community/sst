import type { APIRoute } from "astro";

export const GET: APIRoute = ({ url }) =>
  Response.json({ query: Object.fromEntries(url.searchParams) });

export const POST: APIRoute = async ({ request, clientAddress }) =>
  Response.json({
    method: request.method,
    contentType: request.headers.get("content-type"),
    body: await request.text(),
    ip: clientAddress,
  });
