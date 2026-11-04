import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type AiClass =
  | typeof import("../../../../src/components/cloudflare/ai").Ai
  | typeof import("../../../../src/components/cloudflare/v5/ai").Ai;

describe("Ai", () => {
  let Original: typeof import("../../../../src/components/cloudflare/ai").Ai;
  let Ai: typeof import("../../../../src/components/cloudflare/v5/ai").Ai;
  let OriginalWorker: typeof import("../../../../src/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/v5/worker").Worker;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/ai")).Ai;
    Ai = (await import("../../../../src/components/cloudflare/v5/ai")).Ai;
    OriginalWorker = (
      await import("../../../../src/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/v5/worker"))
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

  // It creates nothing in Cloudflare: only the component, and the binding of
  // a Worker it's linked to
  describe("takes over a deployed Ai", () => {
    pulumi.takeoverCases<AiClass, AiClass>({
      original: () => Original,
      v5: () => Ai,
      provider: "cloudflare",
      cases: {
        "an AI binding": {
          create: (Ai, opts) => new Ai("MyAi", {}, opts),
          check: () => {
            expect(pulumi.resources.map((r) => r.type)).toContain(
              "sst:cloudflare:Ai",
            );
            expect(
              pulumi.resources.filter(
                (r) => r.custom && !r.type.startsWith("pulumi:providers:"),
              ),
            ).toEqual([]);
          },
        },
        // The worker is the 5.0 one both times: what it's given is the AI
        // binding
        "an AI binding a worker is linked to": {
          create: (Ai, opts) => {
            const ai = new Ai("MyAi", {}, opts);
            new Worker("MyWorker", { handler, link: [ai] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({ type: "ai", name: "MyAi" }),
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const ai = new Original("MyAi");
        new OriginalWorker("MyWorker", { handler, link: [ai] });
      },
      () => {
        const ai = new Ai("MyAi");
        new Worker("MyWorker", { handler, link: [ai] });
      },
    );
    expect(result).toMatchObject({ unclaimed: [], changed: [], revealed: [] });
    expect(bindingsOf().find((b) => b.type === "ai")).toEqual({
      type: "ai",
      name: "MyAi",
    });
  });

  it("links the AI binding, with no properties", async () => {
    const link = new Ai("MyAi").link();
    await pulumi.settle();
    expect(
      await new Promise((resolve) => output(link.properties).apply(resolve)),
    ).toEqual({});
    expect(link.include).toEqual([
      { type: "cloudflare.binding", binding: "aiBindings", properties: {} },
    ]);
  });

  it("refuses a transform, as it creates nothing", () => {
    expect(() => new Ai("MyAi", { transform: { model: {} } } as any)).toThrow(
      /"model" is not something you can transform in the "MyAi"/,
    );
  });
});
