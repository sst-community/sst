// The `sst` global: what SST's components share, and the components for each
// provider. A file imports the same from `sst/components` and from each
// group, like `sst/components/aws`. A new group goes here, in groups.ts, in
// the platform's manifest (`sst.modules` in package.json) and in the vitest
// alias (testing/vitest.ts), and tests check that they agree.
export * from "./core.js";
export * as aws from "./aws/index.js";
export * as cloudflare from "./cloudflare/index.js";
export * as vercel from "./vercel/index.js";
