import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { unknown as pulumiUnknown } from "@pulumi/pulumi/output";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi();

describe("check", () => {
  let checks: typeof import("../../src/components/check");
  let Queue: typeof import("../../src/components/aws/v5/queue").Queue;

  beforeAll(async () => {
    checks = await import("../../src/components/check");
    Queue = (await import("../../src/components/aws/v5/queue")).Queue;
  });
  beforeEach(() => pulumi.reset());
  afterEach(() => checks.resetChecks());
  beforeEach(() => checks.resetChecks());

  it("is turned on before any component", () => {
    new Queue("Early");
    expect(() => checks.check({ name: "late" })).toThrow(
      /at the top of run\(\)/,
    );
  });

  it("sees a secret as its value, and a wire unknown as unknown", () => {
    expect(
      checks.markUnknowns({
        key: {
          "4dabf18193072939515e22adb298388d":
            "1b47061264138c4ac30d75fd1eb44270",
          value: "s3cret",
        },
        name: "04da6b54-80e4-46f7-96ec-b56ff0331ba9",
      }),
    ).toEqual({ key: "s3cret", name: checks.unknown });
  });

  // A deploy with no preview first stops before anything is registered, and
  // the CLI runs it again with one
  it("stops a deploy that has no preview first", () => {
    process.env.SST_PREVIEW_FIRST = "";
    try {
      expect(() => checks.check({ name: "any" })).toThrow(
        /has checks, so its deploys run a preview first/,
      );
    } finally {
      process.env.SST_PREVIEW_FIRST = "1";
    }
  });

  it("needs a name", () => {
    expect(() => checks.check({} as any)).toThrow(/needs a "name"/);
  });

  it("stops at what it finds in a resource, with how to fix it", async () => {
    checks.check({
      name: "no-fifo",
      resource: (r) =>
        r.type === "aws:sqs/queue:Queue" && r.props.fifoQueue
          ? { message: `${r.name} is a FIFO queue`, fix: "Use a standard one." }
          : undefined,
    });
    await expect(
      checks.checkResource("aws:sqs/queue:Queue", "Orders", {
        fifoQueue: true,
      }),
    ).rejects.toThrow(
      /The "no-fifo" check found a problem with the aws:sqs\/queue:Queue "Orders":\n- Orders is a FIFO queue\n  Use a standard one\./,
    );
    await expect(
      checks.checkResource("aws:sqs/queue:Queue", "Orders", {
        fifoQueue: false,
      }),
    ).resolves.toBeUndefined();
  });

  // In a preview, a value that isn't known yet is given as `unknown`, not
  // left out, so a check can tell it from a value that's missing
  it("is given what isn't known yet as unknown", async () => {
    let seen: Record<string, unknown> | undefined;
    checks.check({
      name: "sees",
      resource: (r) => {
        seen = r.props;
      },
    });
    await checks.checkResource("aws:sqs/queue:Queue", "Orders", {
      name: output(pulumiUnknown as unknown as string),
      tags: { team: output(pulumiUnknown as unknown as string), app: "shop" },
      fifoQueue: output(true),
    });
    expect(seen).toEqual({
      name: checks.unknown,
      tags: { team: checks.unknown, app: "shop" },
      fifoQueue: true,
    });
    // a check can report it
    checks.resetChecks();
    checks.check({
      name: "needs-a-name",
      resource: (r) =>
        r.props.name === checks.unknown
          ? "its name isn't known yet"
          : undefined,
    });
    await expect(
      checks.checkResource("aws:sqs/queue:Queue", "Orders", {
        name: output(pulumiUnknown as unknown as string),
      }),
    ).rejects.toThrow(/its name isn't known yet/);
  });

  it("looks at a provider function the program calls", async () => {
    checks.check({
      name: "one-region",
      invoke: (i) =>
        i.token === "aws:index/getRegion:getRegion" &&
        i.args.region !== "us-east-1"
          ? [`it asks for ${i.args.region}`, { message: "a second finding" }]
          : undefined,
    });
    await expect(
      checks.checkInvoke("aws:index/getRegion:getRegion", {
        region: "eu-west-1",
      }),
    ).rejects.toThrow(/- it asks for eu-west-1\n- a second finding/);
  });

  // A component's args are SST's, which Pulumi never sees
  it("looks at a component's args when it's created", () => {
    checks.check({
      name: "no-dlq",
      component: (c) =>
        c.type === "sst:aws:Queue" && c.args.dlq
          ? `${c.name} has a DLQ`
          : undefined,
    });
    expect(
      () =>
        new Queue("Orders", { dlq: "arn:aws:sqs:us-east-1:123456789012:dlq" }),
    ).toThrow(
      /The "no-dlq" check found a problem with the sst:aws:Queue "Orders":\n- Orders has a DLQ/,
    );
    expect(() => new Queue("Other")).not.toThrow();
  });

  it("keeps its names for the state", () => {
    checks.check({ name: "first" });
    const second = { name: "second" };
    checks.check(second);
    checks.check(second);
    expect(checks.checkNames()).toEqual(["first", "second"]);
  });

  // Under mock(), a check looks at each resource as it's registered, as in a
  // deploy, and what it finds is kept for the test
  it("runs under mock()", async () => {
    checks.check({
      name: "no-queues",
      resource: (r) =>
        r.type === "aws:sqs/queue:Queue" ? "no queues here" : undefined,
    });
    new Queue("Orders");
    await pulumi.settle();
    expect(pulumi.findings.filter((f) => f.includes('"OrdersQueue"'))).toEqual([
      'The "no-queues" check found a problem with the aws:sqs/queue:Queue "OrdersQueue":\n- no queues here',
    ]);
  });
});
