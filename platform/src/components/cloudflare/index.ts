export * from "./worker";
export * from "./kv";
export * from "./d1";
export * from "./bucket";
export * from "./hyperdrive";
export * from "./ai";
export * from "./rate-limit";
export * from "./queue";
export * from "./cron";
export * from "./workflow";
export * from "./durable-object";
export * from "./static-site";
export * from "./astro";
export * from "./react-router";
export * from "./tan-stack-start";
export * from "./dns";
export * from "./account-id";
export { binding } from "./binding";
// SST 4's names that SST 5 doesn't have, which say what to write
export { StaticSiteV2, Auth, x } from "./sst4";

// How SST 5's components take over from SST 4's
import "./takeover/index";
