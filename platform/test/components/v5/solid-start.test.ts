import { nitroSiteTests } from "./nitro-site.suite";

nitroSiteTests({
  name: "SolidStart",
  file: "solid-start",
  output: ".output",
  config: "app.config.ts",
  base: (base: string) => `export default { baseURL: "${base}" };`,
});
