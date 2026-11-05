// SST 4's `sst.aws`, frozen: its components from these fixtures, and what
// it shares with SST 5's from the platform.
export * from "./alb";
export * from "./analog";
export * from "./apigatewayv1";
export * from "./apigatewayv2";
export * from "./apigateway-websocket";
export * from "./app-sync";
export * from "./astro";
export * from "./aurora";
export * from "./auth";
export * from "./bucket";
export * from "./bus";
export * from "./cluster";
export * from "./cognito-identity-pool";
export * from "./cognito-user-pool";
export * from "./cron";
export * from "./cron-v2";
export * from "../../../../../src/components/aws/dns";
export * from "./dsql";
export * from "./dynamo";
export * from "./efs";
export * from "./email";
export * from "./function";
export * from "./kinesis-stream";
export * from "./microvm";
export * from "./nextjs";
export * from "./opencontrol";
export * from "./open-search";
export * from "./postgres";
export * from "./mysql";
export * from "./queue";
export * from "./realtime";
export * from "./react";
export * from "./redis";
export * from "./remix";
export * from "./router";
export * from "./service";
export * from "./sns-topic";
export * from "./solid-start";
export * from "./step-functions";
export * from "./tan-stack-start";
export * from "./task";
export * from "./nuxt";
export * from "./static-site";
export * from "./svelte-kit";
export * from "./vector";
export * from "./vpc";
export * from "./workflow";
export { linkable } from "../../../../../src/components/aws/linkable";
export {
  permission,
  iamStatements,
} from "../../../../../src/components/aws/permission";
export { functionPart } from "../../../../../src/components/aws/helpers/function-part";
export { iamEdit } from "../../../../../src/components/aws/iam-edit";

// internal components
export * from "./cdn";
export * from "./dns-validated-certificate";
