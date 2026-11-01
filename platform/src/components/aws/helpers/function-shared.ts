import { RandomBytes } from "@pulumi/random";
import type { s3 } from "@pulumi/aws";
import { perRun } from "../../../util/lazy";

// What an app creates once and its functions share, whichever `Function`
// creates them: the 4.x one or the V5 one. Each run of the program creates
// them again.

/**
 * The key links are encrypted with, for every function in the app.
 */
export const linkEncryptionKey = perRun(
  () => new RandomBytes("LambdaEncryptionKey", { length: 32 }),
);

/**
 * The code of the dev stub, uploaded once for each region and stub by the
 * first function in `sst dev` that needs it, by `<region>:<stub's bundle>`.
 * Every live function in that region is created from it.
 */
export const devStubCode = perRun(
  () => new Map<string, Promise<s3.BucketObjectv2>>(),
);
