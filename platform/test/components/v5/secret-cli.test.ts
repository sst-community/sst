import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumiSdk from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { mockPulumi } from "../../../src/testing/mock";
import { rejectionsOf } from "../../helpers/rejections";

// A Secret in an SST app, whose value SST's CLI gives the program from what
// `sst secret set` stored. A Pulumi program's are in secret.test.ts.

const pulumi = mockPulumi();

type Module = typeof import("../../../src/components/secret");

describe("Secret, in an SST app", () => {
  let Secret: Module["Secret"];
  const config = pulumiSdk.runtime.allConfig();

  beforeAll(async () => {
    ({ Secret } = await import("../../../src/components/secret"));
  });

  beforeEach(() => pulumi.reset());

  afterEach(() => {
    pulumiSdk.runtime.setAllConfig(config, []);
    delete process.env.SST_SECRET_StripeKey;
  });

  const valueOf = async (secret: InstanceType<Module["Secret"]>) => {
    new aws.ssm.Parameter("Param", {
      type: "SecureString",
      value: secret.value,
    });
    await pulumi.settle();
    const param = pulumi.resources.find((r) => r.name === "Param");
    if (!param) throw new Error("No Param was created");
    return param.inputs.value;
  };

  it("is the one SST's CLI gives it", async () => {
    process.env.SST_SECRET_StripeKey = "sk_live_123";
    const value = await valueOf(new Secret("StripeKey", "sk_test_123"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_live_123" }));
  });

  it("doesn't read the stack's config", async () => {
    pulumiSdk.runtime.setAllConfig(
      { ...config, "project:StripeKey": "from-the-config" },
      ["project:StripeKey"],
    );
    const value = await valueOf(new Secret("StripeKey", "sk_test_123"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_test_123" }));
  });

  it("says to set it with sst secret set when it has no value", async () => {
    const failures = await rejectionsOf(async () => {
      const secret = new Secret("StripeKey");
      new aws.ssm.Parameter("Param", {
        type: "SecureString",
        value: secret.value,
      });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toBe(
      "Set a value for StripeKey with `sst secret set StripeKey <value>`",
    );
  });
});
