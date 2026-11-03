/**
 * How each V5 component takes over from the 4.x component it replaces, so
 * that changing `sst.aws.Queue` to `sst.aws.v5.Queue` keeps what's already
 * deployed.
 *
 * The V5 components don't know about any of this. When the 4.x components are
 * removed, this folder goes with them.
 */
import "./alb";
import "./analog";
import "./apigateway-websocket";
import "./apigatewayv1";
import "./apigatewayv2";
import "./app-sync";
import "./astro";
import "./aurora";
import "./auth";
import "./bucket";
import "./bus";
import "./cdn";
import "./cluster";
import "./cognito-identity-pool";
import "./cognito-user-pool";
import "./cognito-user-pool-client";
import "./cron";
import "./cron-v2";
import "./dns-validated-certificate";
import "./dsql";
import "./dynamo";
import "./efs";
import "./email";
import "./function";
import "./https-redirect";
import "./mysql";
import "./nextjs";
import "./nuxt";
import "./postgres";
import "./queue";
import "./react";
import "./realtime";
import "./redis";
import "./remix";
import "./router";
import "./service";
import "./sns-topic";
import "./solid-start";
import "./static-site";
import "./step-functions";
import "./svelte-kit";
import "./tan-stack-start";
import "./task";
import "./vpc";
import "./workflow";
