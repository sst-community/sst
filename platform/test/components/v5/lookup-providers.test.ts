import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComponentResourceOptions } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

// A component given an AWS provider of its own makes each lookup with it. A
// lookup reads its provider from its options' `provider` or `parent`, not
// from a component's `providers`, so one given the component's options, or
// none, goes to the stack's default provider: another region or account than
// the component's, and none at all in a program whose only AWS provider is
// its own. `lookups.test.ts` finds a lookup given no options; this finds one
// given the wrong ones, as `Function`'s were.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-providers-"));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
write("src/index.ts", "export const handler = async () => {};\n");
write("site/index.html", "<p>hi</p>\n");

// Each lookup the mock is asked for, and the provider it went to
const lookups: { token: string; provider: string }[] = [];
const pulumi = mockPulumi({
  root,
  // The key a function's links are encrypted with
  state: (args) =>
    args.type === "random:index/randomBytes:RandomBytes"
      ? { base64: Buffer.alloc(32, 1).toString("base64") }
      : {},
  call: (args) => {
    lookups.push({ token: args.token, provider: args.provider ?? "" });
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return {
        names: ["eu-west-1a", "eu-west-1b"],
        zoneIds: ["euw1-az1", "euw1-az2"],
      };
    return undefined;
  },
});

const QUEUE_ARN = "arn:aws:sqs:eu-west-1:123456789012:orders";

type Aws = typeof import("../../../src/components/aws");
// What each case builds, given the options with the component's own provider
const cases: Record<
  string,
  (aws: Aws, opts: ComponentResourceOptions) => void
> = {
  Function: ({ Function, Bucket }, opts) => {
    const files = new Bucket("Files", {}, opts);
    new Function(
      "Fn",
      { handler: "src/index.handler", url: true, link: [files] },
      opts,
    ).addEnvironment({ KEY: "value" });
  },
  "Bucket, with CloudFront access and a queue notified": ({ Bucket }, opts) => {
    new Bucket("Assets", { access: "cloudfront" }, opts).notify({
      notifications: [{ name: "Orders", queue: QUEUE_ARN }],
    });
  },
  "Bus, with a queue subscribed": ({ Bus }, opts) => {
    new Bus("Events", {}, opts).subscribeQueue("Orders", QUEUE_ARN);
  },
  "SnsTopic, with a queue subscribed": ({ SnsTopic }, opts) => {
    new SnsTopic("Topic", {}, opts).subscribeQueue("Orders", QUEUE_ARN);
  },
  CronV2: ({ CronV2 }, opts) => {
    new CronV2(
      "Job",
      { function: "src/index.handler", schedule: "rate(1 minute)" },
      opts,
    );
  },
  CognitoIdentityPool: ({ CognitoIdentityPool }, opts) => {
    new CognitoIdentityPool("Identities", {}, opts);
  },
  "Vpc, with an EC2 NAT and a bastion": ({ Vpc }, opts) => {
    new Vpc("Net", { nat: "ec2", bastion: true }, opts);
  },
  OpenSearch: ({ OpenSearch }, opts) => {
    new OpenSearch("Search", {}, opts);
  },
  ApiGatewayRest: ({ ApiGatewayRest }, opts) => {
    new ApiGatewayRest("Api", { cors: false }, opts);
  },
  StaticSite: ({ StaticSite }, opts) => {
    new StaticSite("Site", { path: "site" }, opts);
  },
};

describe("A component given an AWS provider of its own", () => {
  let aws: Aws;
  beforeAll(async () => {
    aws = await import("../../../src/components/aws");
  });
  beforeEach(() => {
    pulumi.reset();
    lookups.length = 0;
  });

  it.each(Object.keys(cases))("makes each lookup with it: %s", async (name) => {
    const { Provider } = await import("@pulumi/aws");
    const own = new Provider("Own", { region: "eu-west-1" });
    cases[name](aws, { providers: { aws: own } });
    await pulumi.settle();
    const awsLookups = lookups.filter((l) => l.token.startsWith("aws:"));
    expect(awsLookups.length).toBeGreaterThan(0);
    expect(
      awsLookups.filter((l) => !/::Own::/.test(l.provider)).map((l) => l.token),
    ).toEqual([]);
  });
});
