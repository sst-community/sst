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

  function defineFn() {
    return class Fn extends component("acme:index:Fn", {
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
