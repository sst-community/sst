import type { APIRoute } from "astro";

export const GET: APIRoute = ({ cookies }) => {
  cookies.set("a", "1", { maxAge: 3600, httpOnly: true, sameSite: "lax" });
  cookies.set("b", "2");
  return new Response("ok");
};
