import type { APIRoute } from "astro";

export const GET: APIRoute = ({ redirect }) =>
  redirect("/ssr?name=redirected", 302);
