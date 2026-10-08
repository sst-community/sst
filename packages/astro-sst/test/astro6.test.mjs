import { defineSuite } from "./suite.mjs";

defineSuite({
  name: "Astro 6",
  fixtureDir: "fixture-astro6",
  importName: "astro-sst",
  polyfills: false,
});
