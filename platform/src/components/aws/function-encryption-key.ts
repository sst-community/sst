import { RandomBytes } from "@pulumi/random";
import { lazy } from "../../util/lazy.js";

// Preserve the shared key's resource identity for existing Function deployments.
export const functionEncryptionKey = lazy(
  () =>
    new RandomBytes("LambdaEncryptionKey", {
      length: 32,
    }),
);
