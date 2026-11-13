import path from "path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as pulumiSdk from "@pulumi/pulumi";
import { mockPulumi } from "../../../src/testing/mock";

// SST's AWS components in a program Pulumi runs on its own, which sets up
// SST's provider as the stack's config sets up AWS's. Cloudflare's and
// Vercel's are in cloudflare/plain-setup.test.ts.

// The `sst` package, which such a program has SST's components from. This
// repo's tests have none.
vi.mock("../../../src/components/sst-package", () => ({
  sstPackage: () => ({
    dir: path.resolve(__dirname, "../../../.."),
    name: "sst",
    version: "5.0.0-test",
  }),
}));

const pulumi = mockPulumi({ plain: true });

describe("SST's provider for AWS, in a Pulumi program", () => {
  let Router: typeof import("../../../src/components/aws/router").Router;
  let Assets: typeof import("../../../src/components/aws/assets").Assets;
  const config = pulumiSdk.runtime.allConfig();

  beforeAll(async () => {
    ({ Router } = await import("../../../src/components/aws/router"));
    ({ Assets } = await import("../../../src/components/aws/assets"));
  });

  beforeEach(() => pulumi.reset());
  afterEach(() => pulumiSdk.runtime.setAllConfig(config, []));

  const sstProviders = () =>
    pulumi.resources.filter((r) => r.type === "pulumi:providers:sst");

  it("takes the stack's roles for the providers SST makes for a region", async () => {
    // A domain's certificate is in us-east-1, and so are the lookups SST's
    // provider makes for it
    pulumiSdk.runtime.setConfig("aws:region", "us-west-2");
    pulumiSdk.runtime.setConfig(
      "aws:assumeRoles",
      JSON.stringify([{ roleArn: "arn:aws:iam::222222222222:role/deploy" }]),
    );
    new Assets("Assets");
    new Router("Web", { domain: "web.example.com" });
    await pulumi.settle();

    const roles = JSON.stringify([
      { roleArn: "arn:aws:iam::222222222222:role/deploy" },
    ]);
    const providers = Object.fromEntries(
      sstProviders().map((r) => [r.name, r.inputs]),
    );
    expect(providers.sst).toEqual(
      expect.objectContaining({
        awsRegion: "us-west-2",
        awsAssumeRoles: roles,
      }),
    );
    const east = providers["sst-AwsProvider.sst.us-east-1"];
    expect(east).toEqual(
      expect.objectContaining({
        awsRegion: "us-east-1",
        awsAssumeRoles: roles,
      }),
    );
  });
});
