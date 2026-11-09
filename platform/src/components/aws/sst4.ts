import { leftOutComponent, renamedComponent } from "../sst4";

// SST 4's components that SST 5 doesn't have under the same name. Each fails
// with what to write, where it would fail with "is not a constructor".

/** @deprecated SST 4's name: it's `sst.aws.ApiGatewayRest` in SST 5. */
export const ApiGatewayV1 = renamedComponent(
  "sst.aws.ApiGatewayV1",
  "sst.aws.ApiGatewayRest",
);

/** @deprecated SST 4's name: it's `sst.aws.ApiGatewayHttp` in SST 5. */
export const ApiGatewayV2 = renamedComponent(
  "sst.aws.ApiGatewayV2",
  "sst.aws.ApiGatewayHttp",
);

/** @deprecated SST 4's name: it's `sst.aws.Cron` in SST 5. */
export const CronV2 = renamedComponent("sst.aws.CronV2", "sst.aws.Cron");

/** @deprecated SST 4's, which SST 5 doesn't have. */
export const Vector = leftOutComponent(
  "sst.aws.Vector",
  "Keep vectors in a vector database of their own. A stage deployed with it moves its vectors there and removes it with SST 4 first.",
);

/** @deprecated SST 4's, which SST 5 doesn't have. */
export const OpenControl = leftOutComponent(
  "sst.aws.OpenControl",
  "Run OpenControl outside of SST. A stage deployed with it removes it with SST 4 first.",
);
