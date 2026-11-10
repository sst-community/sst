import { describe, expect, it } from "vitest";
import { Output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const pulumi = mockPulumi();

// Where SST 4's component turned an arg with `.apply`, a transform function
// written for it calls `.apply` on what it's given, so SST 5's gives an
// output there too, from a plain config as well; and where SST 4 gave a plain
// value or nothing, it gives that
describe("A transform function is given an output where SST 4's was", () => {
  it("for a queue's timeouts", async () => {
    const { Queue } = await import("../../../src/components/aws/queue");
    let seen: any;
    new Queue("Jobs", {
      visibilityTimeout: "2 minutes",
      transform: { queue: (args) => void (seen = args) },
    });
    await pulumi.settle();
    for (const key of ["visibilityTimeoutSeconds", "delaySeconds"])
      expect(Output.isInstance(seen[key]), key).toBe(true);
    expect(await pulumi.resolve(seen.visibilityTimeoutSeconds)).toBe(120);
  });

  it("for a function's timeout and memory", async () => {
    const { Function } = await import("../../../src/components/aws/function");
    let seen: any;
    new Function("Api", {
      handler: "src/api.handler",
      timeout: "30 seconds",
      transform: { function: (args) => void (seen = args) },
    });
    await pulumi.settle();
    for (const key of ["timeout", "memorySize"])
      expect(Output.isInstance(seen[key]), key).toBe(true);
    expect(await pulumi.resolve(seen.timeout)).toBe(30);
  });

  it("for a function URL's invoke mode", async () => {
    const { Function } = await import("../../../src/components/aws/function");
    let seen: any;
    new Function("Web", {
      handler: "src/web.handler",
      url: true,
      transform: { url: (args) => void (seen = args) },
    });
    await pulumi.settle();
    expect(Output.isInstance(seen.invokeMode)).toBe(true);
  });

  it("for a load balancer's internal", async () => {
    const { Alb } = await import("../../../src/components/aws/alb");
    let seen: any;
    new Alb("Lb", {
      vpc: {
        id: "vpc-1",
        publicSubnets: ["subnet-a"],
        privateSubnets: ["subnet-b"],
      },
      listeners: [{ port: 80, protocol: "http" }],
      transform: { loadBalancer: (args) => void (seen = args) },
    });
    await pulumi.settle();
    expect(Output.isInstance(seen.internal)).toBe(true);
    expect(await pulumi.resolve(seen.internal)).toBe(false);
  });

  it("for a bucket notification's lists", async () => {
    const { Bucket } = await import("../../../src/components/aws/bucket");
    let seen: any;
    new Bucket("Files", {
      transform: { notification: (args) => void (seen = args) },
    }).notify({
      notifications: [{ name: "Created", function: "src/created.handler" }],
    });
    await pulumi.settle();
    for (const key of ["lambdaFunctions", "queues", "topics"])
      expect(Output.isInstance(seen[key]), key).toBe(true);
  });
});

describe("A transform function is given what SST 4's gave, where that's no output", () => {
  it("a queue's redrive policy is nothing without a dead-letter queue", async () => {
    const { Queue } = await import("../../../src/components/aws/queue");
    let seen: any;
    new Queue("Jobs", { transform: { queue: (args) => void (seen = args) } });
    await pulumi.settle();
    expect(seen.redrivePolicy).toBeUndefined();
  });

  it("a user pool client's callback URLs and providers are SST's defaults as they are, when unset", async () => {
    const { CognitoUserPoolClient } = await import(
      "../../../src/components/aws/cognito-user-pool-client"
    );
    let seen: any;
    new CognitoUserPoolClient("Web", {
      userPool: "us-east-1_abc",
      transform: { client: (args) => void (seen = args) },
    });
    await pulumi.settle();
    expect(seen.callbackUrls).toEqual(["https://example.com"]);
    expect(seen.supportedIdentityProviders).toEqual(["COGNITO"]);
  });

  // SST 4 made the image inside an `apply`
  it("an image's cache lists are lists, and nothing with the cache off", async () => {
    const { Function } = await import("../../../src/components/aws/function");
    const seen: Record<string, any> = {};
    for (const [name, container] of [
      ["Cached", true],
      ["Uncached", { cache: false }],
    ] as const)
      new Function(name, {
        handler: "functions/src/functions/api.handler",
        runtime: "python3.12",
        python: { container },
        transform: { image: (args) => void (seen[name] = args) },
      });
    await pulumi.settle();
    for (const key of ["cacheFrom", "cacheTo"]) {
      expect(Array.isArray(seen.Cached[key]), key).toBe(true);
      expect(seen.Uncached[key], key).toBeUndefined();
    }
  });
});
