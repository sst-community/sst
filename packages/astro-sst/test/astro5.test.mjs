import { defineSuite } from "./suite.mjs";

defineSuite({
  name: "Astro 5",
  fixtureDir: "fixture-astro5",
  importName: "astro-sst",
  polyfills: true,
});
