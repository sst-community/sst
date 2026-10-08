import { defineSuite } from "./suite.mjs";

defineSuite({
  name: "Astro 7",
  fixtureDir: "fixture-astro7",
  importName: "@sst-community/astro-sst",
  polyfills: false,
  fetchFile: "custom-fetch",
});
