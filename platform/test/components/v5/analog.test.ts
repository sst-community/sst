import { nitroSiteTests } from "./nitro-site.suite";

nitroSiteTests({
  name: "Analog",
  file: "analog",
  output: "dist/analog",
  config: "vite.config.ts",
  base: (base: string) => `export default { base: '${base}' };`,
});
