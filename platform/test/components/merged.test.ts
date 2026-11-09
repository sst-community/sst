import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

// What the program tells the core it merged, as `sst migrate --check` runs it
const merged: any[] = [];
const pulumi = mockPulumi({
  move: true,
  preview: true,
  cli: (method, args) => {
    if (method !== "Move.Merged") return undefined;
    merged.push(args);
    return {};
  },
});

type Module = typeof import("../../src/components/parts-component");

describe("An object transform merged where SST 4's replaced the arg, while the stage moves", () => {
  let component: Module["component"];
  let keptByMerge: typeof import("../../src/components/transform").keptByMerge;

  beforeAll(async () => {
    ({ component } = await import("../../src/components/parts-component"));
    ({ keptByMerge } = await import("../../src/components/transform"));
  });

  beforeEach(() => {
    pulumi.reset();
    merged.length = 0;
  });

  // One of SST's: SST 4 had no other components
  function defineFn(type = "sst:aws:TestFn") {
    return class Fn extends component(type, {
      function: aws.lambda.Function,
    }) {
      constructor(name: string, args: { transform?: any } = {}) {
        super(name, args);
        this.part("function", {
          role: "arn:aws:iam::123456789012:role/fn",
          timeout: 3,
          loggingConfig: { logFormat: "JSON", logGroup: "/fn" },
          environment: { variables: output({ SST_KEY: "k", A: "1" }) },
          tags: { owner: "sst" },
        });
      }
    };
  }

  it("says which of SST's settings the merge keeps, for each arg set as an object", async () => {
    const Fn = defineFn();
    new Fn("Api", {
      transform: {
        function: {
          timeout: 10,
          loggingConfig: { applicationLogLevel: "DEBUG" },
          environment: { variables: { B: "2" } },
          tags: { owner: "me" },
        },
      },
    });
    await pulumi.settle();

    expect(merged).toEqual([
      {
        urn: expect.stringMatching(/::ApiFunction$/),
        fields: [
          { field: "loggingConfig", kept: ["logFormat", "logGroup"] },
          { field: "environment", kept: ["variables.SST_KEY", "variables.A"] },
        ],
      },
    ]);
  });

  it("says nothing for a function, or an object that sets everything SST's did", async () => {
    const Fn = defineFn();
    new Fn("A", {
      transform: {
        function: (args: any) => {
          args.timeout = 10;
        },
      },
    });
    new Fn("B", {
      transform: {
        function: { loggingConfig: { logFormat: "Text", logGroup: "/b" } },
      },
    });
    new Fn("C");
    await pulumi.settle();

    expect(merged).toEqual([]);
  });

  it("says nothing for an app's or a package's own component, which SST 4 didn't have", async () => {
    const Fn = defineFn("acme:index:Fn");
    new Fn("Api", {
      transform: {
        function: { loggingConfig: { applicationLogLevel: "DEBUG" } },
      },
    });
    await pulumi.settle();
    expect(merged).toEqual([]);
  });

  it("unsets a setting the object sets to undefined, as SST 4 did, keeping nothing of it", async () => {
    const Fn = defineFn();
    new Fn("Api", {
      transform: {
        function: {
          timeout: undefined,
          loggingConfig: { logGroup: undefined },
        },
      },
    });
    await pulumi.settle();

    const fn = pulumi.resources.find((r) => r.name === "ApiFunction")!;
    expect(fn.inputs.timeout).toBeUndefined();
    expect(fn.inputs.loggingConfig).toEqual({ logFormat: "JSON" });
    expect(merged).toEqual([
      {
        urn: expect.stringMatching(/::ApiFunction$/),
        fields: [{ field: "loggingConfig", kept: ["logFormat"] }],
      },
    ]);
  });

  it("keeps nothing of a default that isn't a plain object, as the merge replaces it", async () => {
    const asset = new (await import("@pulumi/pulumi")).asset.StringAsset("x");
    const kept = await pulumi.resolve(
      keptByMerge(
        { later: Promise.resolve({ a: 1, b: 2 }), code: asset, list: [1, 2] },
        { later: { b: 3 }, code: { x: 1 }, list: { 0: 5 } },
      ),
    );
    expect(kept).toEqual([]);
  });

  it("doesn't say it keeps a setting that's an output of nothing, as ifSet() gives", async () => {
    const kept = await pulumi.resolve(
      keptByMerge(
        { scaling: { target: 50, cooldown: output(undefined), metric: "cpu" } },
        { scaling: { target: 70 } },
      ),
    );
    expect(kept).toEqual([{ field: "scaling", kept: ["metric"] }]);
  });

  it("sends nothing when the stage isn't moving", async () => {
    const cli = (globalThis as any).$cli;
    cli.move = false;
    try {
      const Fn = defineFn();
      new Fn("Api", {
        transform: {
          function: { loggingConfig: { applicationLogLevel: "DEBUG" } },
        },
      });
      await pulumi.settle();
    } finally {
      cli.move = true;
    }
    expect(merged).toEqual([]);
  });

  it("reads a default that's an output once it resolves", async () => {
    const kept = await pulumi.resolve(
      keptByMerge(
        { config: output({ a: 1, nested: { b: 2, c: 3 } }), plain: "x" },
        { config: { nested: { b: 5 } }, plain: { y: 1 } },
      ),
    );
    expect(kept).toEqual([{ field: "config", kept: ["a", "nested.c"] }]);
  });
});

describe("A function part's object transform, while the stage moves", () => {
  beforeEach(() => {
    pulumi.reset();
    merged.length = 0;
  });

  it("is said of the function the component creates", async () => {
    const { Cron } = await import("../../src/components/aws/cron");
    new Cron("Nightly", {
      schedule: "rate(1 day)",
      function: { handler: "src/job.handler", environment: { A: "1" } },
      transform: { function: { environment: { B: "2" } } },
    });
    await pulumi.settle();

    expect(merged).toContainEqual({
      urn: expect.stringMatching(
        /sst:aws:CronV2\$sst:aws:Function::NightlyFunction$/,
      ),
      fields: [{ field: "environment", kept: ["A"] }],
    });
  });
});
