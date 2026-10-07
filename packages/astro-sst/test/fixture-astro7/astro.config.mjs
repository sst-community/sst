import { defineConfig } from "astro/config";
// The test suite installs the packed adapter under this name.
import aws from "@sst-community/astro-sst";

export default defineConfig({
  output: "server",
  trailingSlash: "never",
  outDir: process.env.OUT_DIR ?? "dist",
  // Set to "custom-fetch" to build with src/custom-fetch.ts as the app's
  // fetch handler.
  ...(process.env.FETCH_FILE && { fetchFile: process.env.FETCH_FILE }),
  adapter: aws({ responseMode: process.env.RESPONSE_MODE ?? "buffer" }),
});
