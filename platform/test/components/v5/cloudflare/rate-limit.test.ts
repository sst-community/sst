import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type RateLimitClass =
  | typeof import("../../../fixtures/v4/components/cloudflare/rate-limit").RateLimit
  | typeof import("../../../../src/components/cloudflare/rate-limit").RateLimit;

const args = {
  namespaceId: 1001,
  limit: 100,
  period: "1 minute" as const,
};

describe("RateLimit", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/rate-limit").RateLimit;
  let RateLimit: typeof import("../../../../src/components/cloudflare/rate-limit").RateLimit;
  let OriginalWorker: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;

  beforeAll(async () => {
    Original = (
      await import("../../../fixtures/v4/components/cloudflare/rate-limit")
    ).RateLimit;
    RateLimit = (
      await import("../../../../src/components/cloudflare/rate-limit")
    ).RateLimit;
    OriginalWorker = (
      await import("../../../fixtures/v4/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/worker"))
      .Worker;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const bindingsOf = (name = "MyWorkerScript") =>
    resource(name).inputs.bindings as Record<string, any>[];
  const value = (v: any) => new Promise((resolve) => output(v).apply(resolve));

  // It creates nothing in Cloudflare: only the component, and the binding of
  // a Worker it's linked to
  describe("takes over a deployed RateLimit", () => {
    pulumi.takeoverCases<RateLimitClass, RateLimitClass>({
      original: () => Original,
      v5: () => RateLimit,
      provider: "cloudflare",
      cases: {
        "a rate limit": {
          create: (RateLimit, opts) => new RateLimit("MyRateLimit", args, opts),
          check: () => {
            expect(pulumi.resources.map((r) => r.type)).toContain(
              "sst:cloudflare:RateLimit",
            );
            expect(
              pulumi.resources.filter(
                (r) => r.custom && !r.type.startsWith("pulumi:providers:"),
              ),
            ).toEqual([]);
          },
        },
        "a rate limit of outputs": (RateLimit, opts) =>
          new RateLimit(
            "MyRateLimit",
            {
              namespaceId: output(1002),
              limit: output(10),
              period: output("10 seconds" as const),
            },
            opts,
          ),
        // The worker is the 5.0 one both times: what it's given is the rate
        // limit's binding
        "a rate limit a worker is linked to": {
          create: (RateLimit, opts) => {
            const rateLimit = new RateLimit("MyRateLimit", args, opts);
            new Worker("MyWorker", { handler, link: [rateLimit] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({
              type: "ratelimit",
              name: "MyRateLimit",
              namespaceId: "1001",
              simple: { limit: 100, period: 60 },
            }),
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // to the rate limit as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const rateLimit = new Original("MyRateLimit", args);
        new OriginalWorker("MyWorker", { handler, link: [rateLimit] });
      },
      () => {
        const rateLimit = new RateLimit("MyRateLimit", args);
        new Worker("MyWorker", { handler, link: [rateLimit] });
      },
    );
    expect(result).toMatchObject({ unclaimed: [], changed: [], revealed: [] });
    expect(bindingsOf().find((b) => b.type === "ratelimit")).toEqual({
      type: "ratelimit",
      name: "MyRateLimit",
      namespaceId: "1001",
      simple: { limit: 100, period: 60 },
    });
  });

  it("gives its namespace, limit and period in seconds", async () => {
    const rateLimit = new RateLimit("MyRateLimit", {
      ...args,
      period: "10 seconds",
    });
    await pulumi.settle();
    expect(await value(rateLimit.namespaceId)).toBe("1001");
    expect(await value(rateLimit.limit)).toBe(100);
    expect(await value(rateLimit.period)).toBe(10);
    expect(await value(rateLimit.link().properties)).toEqual({});
  });

  it("takes a period written another way that's the same", async () => {
    const rateLimit = new RateLimit("MyRateLimit", {
      ...args,
      period: "60 seconds" as any,
    });
    await pulumi.settle();
    expect(await value(rateLimit.period)).toBe(60);
  });

  describe("refuses, naming the component", () => {
    it.each([
      ["a namespace that isn't a positive integer", { namespaceId: 0 }],
      ["a namespace that isn't a number", { namespaceId: "1001" }],
      ["a fraction for a namespace", { namespaceId: 1.5 }],
    ])("%s", (_, given) => {
      expect(
        () => new RateLimit("MyRateLimit", { ...args, ...(given as any) }),
      ).toThrow(
        `The "namespaceId" of the "MyRateLimit" rate limit has to be a positive integer.`,
      );
    });

    it("a limit that isn't a positive integer", () => {
      expect(
        () => new RateLimit("MyRateLimit", { ...args, limit: -1 }),
      ).toThrow(
        `The "limit" of the "MyRateLimit" rate limit has to be a positive integer.`,
      );
    });

    it.each(["30 seconds", "1 hour", "a minute", "10seconds", 60])(
      "a period of %s",
      (period) => {
        expect(
          () =>
            new RateLimit("MyRateLimit", { ...args, period: period as any }),
        ).toThrow(
          `The "period" of the "MyRateLimit" rate limit has to be "10 seconds" or "1 minute".`,
        );
      },
    );
  });
});
