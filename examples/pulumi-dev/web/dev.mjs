// The frontend's dev server: the page, with the API's URL from the stack
import { readFile } from "node:fs/promises";
import http from "node:http";

const port = Number(process.env.PORT ?? 5173);
http
  .createServer(async (request, response) => {
    if (request.url === "/config.js") {
      response.setHeader("content-type", "text/javascript");
      return response.end(`window.API_URL = ${JSON.stringify(process.env.API_URL)};`);
    }
    response.setHeader("content-type", "text/html");
    response.end(await readFile(new URL("index.html", import.meta.url)));
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
