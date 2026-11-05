import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../../helpers/graph";

// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";
const migrations = [{ tag: "v1", newSqliteClasses: ["Counter"] }];

const pulumi = mockPulumi();

type DurableObjectClass =
  | typeof import("../../../fixtures/v4/components/cloudflare/durable-object").DurableObject
  | typeof import("../../../../src/components/cloudflare/durable-object").DurableObject;

describe("DurableObject", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/durable-object").DurableObject;
  let DurableObject: typeof import("../../../../src/components/cloudflare/durable-object").DurableObject;
  let OriginalWorker: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;

  beforeAll(async () => {
    Original = (
      await import("../../../fixtures/v4/components/cloudflare/durable-object")
    ).DurableObject;
    DurableObject = (
      await import("../../../../src/components/cloudflare/durable-object")
    ).DurableObject;
    OriginalWorker = (
      await import("../../../fixtures/v4/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/worker"))
      .Worker;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  // Cloudflare's API, which a Worker with Durable Object migrations reads
  // its current migration tag from: none of its scripts are deployed
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
      String(url).startsWith("https://api.cloudflare.com/")
        ? new Response(JSON.stringify({ success: true, result: [] }))
        : realFetch(url, init)) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const bindingsOf = (name: string) =>
    resource(name).inputs.bindings as Record<string, any>[];
  const binding = {
    type: "durable_object_namespace",
    name: "Counter",
    className: "Counter",
  };

  // Each case deploys the 4.x DurableObject, then the same thing as the V5
  // one. It creates nothing in Cloudflare, so what's checked is the
  // component, and the binding a worker linked to it gets.
  describe("takes over a deployed DurableObject", () => {
    pulumi.takeoverCases<DurableObjectClass, DurableObjectClass>({
      original: () => Original,
      v5: () => DurableObject,
      provider: "cloudflare",
      check: () =>
        expect(
          pulumi.resources.filter(
            (r) => r.type === "sst:cloudflare:DurableObject",
          ),
        ).toHaveLength(1),
      cases: {
        "a durable object": (DurableObject, opts) => {
          new DurableObject("Counter", { className: "Counter" }, opts);
        },
        "a durable object a worker is linked to": {
          original: (opts) => {
            const counter = new Original(
              "Counter",
              { className: "Counter" },
              opts,
            );
            new OriginalWorker("Api", {
              handler,
              link: [counter],
              migrations,
            });
          },
          v5: (opts) => {
            const counter = new DurableObject(
              "Counter",
              { className: "Counter" },
              opts,
            );
            new Worker("Api", { handler, link: [counter], migrations });
          },
          check: () => expect(bindingsOf("ApiScript")).toContainEqual(binding),
        },
        // A stage can move the Durable Object and keep the 4.x Worker
        "a durable object linked to a worker that stays on SST 4": {
          original: (opts) => {
            const counter = new Original(
              "Counter",
              { className: "Counter" },
              opts,
            );
            new OriginalWorker("Api", { handler, link: [counter] });
          },
          v5: (opts) => {
            const counter = new DurableObject(
              "Counter",
              { className: "Counter" },
              opts,
            );
            new OriginalWorker("Api", { handler, link: [counter] });
          },
          check: () => expect(bindingsOf("ApiScript")).toContainEqual(binding),
        },
      },
    });
  });

  it("gives a worker linked to it a binding to its class, and its class name", async () => {
    const counter = new DurableObject("Counter", { className: "Counter" });
    new Worker("Api", {
      handler,
      link: [counter],
      migrations: [{ tag: "v1", newSqliteClasses: [counter.className] }],
    });
    await pulumi.settle();
    expect(bindingsOf("ApiScript")).toEqual([
      expect.objectContaining({ name: "SST_RESOURCE_App" }),
      binding,
    ]);
    expect(resource("ApiScript").inputs.migrations).toEqual({
      newTag: "v1",
      steps: [{ newSqliteClasses: ["Counter"] }],
    });
  });

  it("creates nothing", async () => {
    new DurableObject("Counter", { className: "Counter" });
    await pulumi.settle();
    expect(pulumi.resources.map((r) => r.type)).toEqual([
      "sst:cloudflare:DurableObject",
    ]);
  });
});
