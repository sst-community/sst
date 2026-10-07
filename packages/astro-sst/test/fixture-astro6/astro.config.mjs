import { defineConfig } from "astro/config";
// The test suite installs the packed adapter under this name.
import aws from "astro-sst";

export default defineConfig({
  output: "server",
  trailingSlash: "never",
  outDir: process.env.OUT_DIR ?? "dist",
  adapter: aws({ responseMode: process.env.RESPONSE_MODE ?? "buffer" }),
});
