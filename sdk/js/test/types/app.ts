// What an app's code, or a package's handler, imports from `sst`.
// scripts/types.ts type-checks it against the built SDK without
// skipLibCheck, under NodeNext and bundler.
import { Resource, RealtimeAuthHandler, VectorClient } from "sst";
import { Resource as NodeResource } from "sst/resource";
import { bus } from "sst/aws/bus";
import { realtime } from "sst/aws/realtime";
import { auth } from "sst/aws/auth";
import { client } from "sst/aws/client";

export const used = [
  Resource.App.name,
  NodeResource.App.stage,
  RealtimeAuthHandler,
  VectorClient,
  bus.publish,
  realtime.authorizer,
  auth,
  client,
];
