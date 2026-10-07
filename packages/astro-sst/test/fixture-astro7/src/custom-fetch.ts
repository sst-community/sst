import { FetchState, astro } from "astro/fetch";

export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/from-fetch") {
      return new Response("handled by src/custom-fetch.ts");
    }
    return astro(new FetchState(request));
  },
};
