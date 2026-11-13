import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumiSdk from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { mockPulumi } from "../../../src/testing/mock";
import { rejectionsOf } from "../../helpers/rejections";

// A Secret in a program Pulumi runs on its own, which has no CLI to give it
// the stage's secrets: its value is the stack's config. An SST app's are in
// secret-cli.test.ts.

const pulumi = mockPulumi({ plain: true });

type Module = typeof import("../../../src/components/secret");

describe("Secret, in a Pulumi program", () => {
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

  // The stack's config, as `pulumi config set --secret` keeps it, under the
  // project's name
  const setSecret = (name: string, value: string) =>
    pulumiSdk.runtime.setAllConfig(
      { ...pulumiSdk.runtime.allConfig(), [`app:${name}`]: value },
      [`app:${name}`],
    );

  // The secret's value, as a resource that takes it has it
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

  it("is the stack's secret config of the same name", async () => {
    setSecret("StripeKey", "sk_live_123");
    const value = await valueOf(new Secret("StripeKey"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_live_123" }));
  });

  it("takes the stack's config over its placeholder", async () => {
    setSecret("StripeKey", "sk_live_123");
    const value = await valueOf(new Secret("StripeKey", "sk_test_123"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_live_123" }));
  });

  it("takes its placeholder when the stack's config has none", async () => {
    const value = await valueOf(new Secret("StripeKey", "sk_test_123"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_test_123" }));
  });

  it("doesn't read SST_SECRET_, which only SST's CLI sets", async () => {
    process.env.SST_SECRET_StripeKey = "from-the-environment";
    const value = await valueOf(new Secret("StripeKey", "sk_test_123"));
    expect(value).toEqual(expect.objectContaining({ value: "sk_test_123" }));
  });

  it("links its value", async () => {
    setSecret("StripeKey", "sk_live_123");
    const secret = new Secret("StripeKey");
    new aws.ssm.Parameter("Param", {
      type: "SecureString",
      value: secret.getSSTLink().properties.value,
    });
    await pulumi.settle();
    const param = pulumi.resources.find((r) => r.name === "Param")!;
    expect(param.inputs.value).toEqual(
      expect.objectContaining({ value: "sk_live_123" }),
    );
  });

  it("says to set it in the stack's config when it has no value", async () => {
    const failures = await rejectionsOf(async () => {
      const secret = new Secret("StripeKey");
      new aws.ssm.Parameter("Param", {
        type: "SecureString",
        value: secret.value,
      });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toBe(
      "Set a value for StripeKey in the stack's config, with `pulumi config set --secret StripeKey <value>`",
    );
  });
});
