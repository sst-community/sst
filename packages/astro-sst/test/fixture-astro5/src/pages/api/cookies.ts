import type { APIRoute } from "astro";

export const GET: APIRoute = ({ cookies }) => {
  cookies.set("a", "1");
  cookies.set("b", "2");
  return new Response("ok");
};
