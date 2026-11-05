import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

const NAMESPACE = "cloudflare:index/workersKvNamespace:WorkersKvNamespace";
// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type KvClass =
  | typeof import("../../../fixtures/v4/components/cloudflare/kv").Kv
  | typeof import("../../../../src/components/cloudflare/kv").Kv;

describe("Kv", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/kv").Kv;
  let Kv: typeof import("../../../../src/components/cloudflare/kv").Kv;
  let OriginalWorker: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;
  let lookup: typeof import("../../../../src/components/cloudflare/helpers/lookup");

  beforeAll(async () => {
    Original = (await import("../../../fixtures/v4/components/cloudflare/kv"))
      .Kv;
    Kv = (await import("../../../../src/components/cloudflare/kv")).Kv;
    OriginalWorker = (
      await import("../../../fixtures/v4/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/worker"))
      .Worker;
    lookup = await import(
      "../../../../src/components/cloudflare/helpers/lookup"
    );
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

  // 4.x's `get` looks the namespace up beside the component, with the
  // component's options. V5 looks the same namespace up inside it, which
  // this can't match: a lookup has no aliases. Nothing is deployed for a
  // lookup, so nothing is deleted.
  const lookedUp = [`${NAMESPACE}::MyKvNamespace`];

  describe("takes over a deployed Kv", () => {
    pulumi.takeoverCases<KvClass, KvClass>({
      original: () => Original,
      v5: () => Kv,
      provider: "cloudflare",
      cases: {
        "a namespace": {
          create: (Kv, opts) => new Kv("MyKv", {}, opts),
          check: () =>
            expect(resource("MyKvNamespace")).toMatchObject({
              kind: "register",
              type: NAMESPACE,
            }),
        },
        "a namespace in another account": (Kv, opts) =>
          new Kv("MyKv", { accountId: "other-account" }, opts),
        "a namespace transformed": (Kv, opts) =>
          new Kv(
            "MyKv",
            { transform: { namespace: { title: "my-namespace" } } },
            opts,
          ),
        "a namespace transformed with a function": (Kv, opts) =>
          new Kv(
            "MyKv",
            {
              transform: {
                namespace: (args) => {
                  args.title = "my-namespace";
                },
              },
            },
            opts,
          ),
        "a namespace referenced with get": {
          create: (Kv, opts) =>
            Kv.get(
              "MyKv",
              { namespaceId: "a1b2c3", accountId: "my-account" },
              opts,
            ),
          unclaimed: lookedUp,
          check: () =>
            expect(resource("MyKvNamespace")).toMatchObject({
              kind: "read",
              options: { id: "my-account/a1b2c3" },
            }),
        },
        // The worker is the 5.0 one both times: what it's given is the
        // namespace's binding
        "a namespace a worker is linked to": {
          create: (Kv, opts) => {
            const kv = new Kv("MyKv", {}, opts);
            new Worker("MyWorker", { handler, link: [kv] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({
              type: "kv_namespace",
              name: "MyKv",
              namespaceId: "MyKvNamespace_id",
            }),
        },
        "a namespace referenced with get that a worker is linked to": {
          create: (Kv, opts) => {
            const kv = Kv.get(
              "MyKv",
              { namespaceId: "a1b2c3", accountId: "my-account" },
              opts,
            );
            new Worker("MyWorker", { handler, link: [kv] });
          },
          unclaimed: lookedUp,
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // to the namespace as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const kv = new Original("MyKv");
        new OriginalWorker("MyWorker", { handler, link: [kv] });
      },
      () => {
        const kv = new Kv("MyKv");
        new Worker("MyWorker", { handler, link: [kv] });
      },
    );
    expect(result).toMatchObject({
      unclaimed: [],
      changed: [],
      revealed: [],
    });
    expect(bindingsOf().find((b) => b.type === "kv_namespace")).toEqual({
      type: "kv_namespace",
      name: "MyKv",
      namespaceId: "MyKvNamespace_id",
    });
  });

  it("creates a namespace named for the app, in the account", async () => {
    const kv = new Kv("MyKv", { accountId: "my-account" });
    await pulumi.settle();
    expect(resource("MyKvNamespace").inputs).toMatchObject({
      accountId: "my-account",
      title: expect.stringMatching(/^app-test-mykvnamespace-/),
    });
    expect(kv.nodes.namespace).toBeDefined();
    const id = await new Promise((resolve) => kv.namespaceId.apply(resolve));
    expect(id).toBe("MyKvNamespace_id");
  });

  it("links its namespace id", async () => {
    const kv = new Kv("MyKv");
    const link = kv.link();
    await pulumi.settle();
    const value = (v: any) =>
      new Promise((resolve) => output(v).apply(resolve));
    expect(await value(link.properties)).toEqual({
      namespaceId: "MyKvNamespace_id",
    });
    expect(link.include).toHaveLength(1);
    expect(link.include![0]).toMatchObject({
      type: "cloudflare.binding",
      binding: "kvNamespaceBindings",
    });
  });

  describe("an existing namespace", () => {
    it("is looked up in its account by get", async () => {
      Kv.get("MyKv", { namespaceId: output("a1b2c3"), accountId: "acct" });
      await pulumi.settle();
      expect(resource("MyKvNamespace")).toMatchObject({
        kind: "read",
        type: NAMESPACE,
        options: { id: "acct/a1b2c3" },
      });
    });

    it("is looked up by its id in existing, with the account in front", async () => {
      new Kv("MyKv", { accountId: "acct", existing: { namespace: "a1b2c3" } });
      new Kv("Other", { existing: { namespace: "acct/d4e5f6" } });
      await pulumi.settle();
      expect(resource("MyKvNamespace").options.id).toBe("acct/a1b2c3");
      expect(resource("OtherNamespace").options.id).toBe("acct/d4e5f6");
      expect(
        pulumi.resources.filter((r) => r.kind === "register" && r.custom),
      ).toEqual([]);
    });

    it("is used as it is when it's the resource", async () => {
      const { WorkersKvNamespace } = await import("@pulumi/cloudflare");
      const namespace = new WorkersKvNamespace("Shared", {
        accountId: "acct",
        title: "shared",
      });
      const kv = new Kv("MyKv", { existing: { namespace } });
      await pulumi.settle();
      expect(kv.nodes.namespace).toBe(namespace);
      expect(pulumi.resources.map((r) => r.name)).not.toContain(
        "MyKvNamespace",
      );
    });

    it("refuses a transform next to it", () => {
      expect(
        () =>
          new Kv("MyKv", {
            existing: { namespace: "a1b2c3" },
            transform: { namespace: { title: "x" } },
          }),
      ).toThrow(/is given an existing "namespace"/);
    });
  });

  it("refuses the deprecated id, saying what to use", () => {
    const kv = new Kv("MyKv");
    expect(() => (kv as any).id).toThrow(
      `"id" isn't a property of the "MyKv" KV namespace. Use "namespaceId", which is the same value.`,
    );
  });

  it("gives a looked-up resource's own id, without its account", async () => {
    const value = (v: any) =>
      new Promise((resolve) => output(v).apply(resolve));
    expect(await value(lookup.ownId("acct/a1b2c3"))).toBe("a1b2c3");
    expect(await value(lookup.ownId("a1b2c3"))).toBe("a1b2c3");
    expect(await value(lookup.lookupId("acct", "a1b2c3"))).toBe("acct/a1b2c3");
    expect(await value(lookup.lookupId("acct", "a1b2c3", "default"))).toBe(
      "acct/a1b2c3/default",
    );
    expect(await value(lookup.lookupId("acct", "other/a1b2c3"))).toBe(
      "other/a1b2c3",
    );
    // What an id with its account leaves out is added after it
    expect(
      await value(lookup.lookupId("acct", "other/my-bucket", "default")),
    ).toBe("other/my-bucket/default");
    expect(
      await value(lookup.lookupId("acct", "other/my-bucket/eu", "default")),
    ).toBe("other/my-bucket/eu");
  });
});
