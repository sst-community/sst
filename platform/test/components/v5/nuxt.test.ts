import { nitroSiteTests } from "./nitro-site.suite";

nitroSiteTests({
  name: "Nuxt",
  file: "nuxt",
  output: ".output",
  config: "nuxt.config.ts",
  base: (base: string) => `export default { app: { baseURL: '${base}' } };`,
});
