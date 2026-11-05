import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { type TakeoverWay, mockPulumi } from "../../../helpers/graph";

const DATABASE = "cloudflare:index/d1Database:D1Database";
// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type D1Class =
  | typeof import("../../../fixtures/v4/components/cloudflare/d1").D1
  | typeof import("../../../../src/components/cloudflare/d1").D1;

describe("D1", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/d1").D1;
  let D1: typeof import("../../../../src/components/cloudflare/d1").D1;
  let OriginalWorker: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;

  beforeAll(async () => {
    Original = (await import("../../../fixtures/v4/components/cloudflare/d1"))
      .D1;
    D1 = (await import("../../../../src/components/cloudflare/d1")).D1;
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

  // 4.x's `get` looks the database up beside the component. V5 looks the
  // same database up inside it, which this can't match: a lookup has no
  // aliases. Nothing is deployed for a lookup, so nothing is deleted. 4.x's
  // `get` also left the component itself at the top of the app, without the
  // options it was given; V5 gives them to it, so inside another component
  // it's inside that one. A component has nothing in Cloudflare behind it.
  const lookedUp = (way: TakeoverWay) => [
    `${DATABASE}::MyD1Database`,
    ...(way === "inside another component" ? ["sst:cloudflare:D1::MyD1"] : []),
  ];

  describe("takes over a deployed D1", () => {
    pulumi.takeoverCases<D1Class, D1Class>({
      original: () => Original,
      v5: () => D1,
      provider: "cloudflare",
      cases: {
        "a database": {
          create: (D1, opts) => new D1("MyD1", {}, opts),
          check: () =>
            expect(resource("MyD1Database")).toMatchObject({
              kind: "register",
              type: DATABASE,
            }),
        },
        "a database in another account": (D1, opts) =>
          new D1("MyD1", { accountId: "other-account" }, opts),
        "a database transformed": (D1, opts) =>
          new D1(
            "MyD1",
            {
              transform: {
                database: {
                  primaryLocationHint: "weur",
                  readReplication: { mode: "auto" },
                },
              },
            },
            opts,
          ),
        "a database transformed with a function": (D1, opts) =>
          new D1(
            "MyD1",
            {
              transform: {
                database: (args) => {
                  args.name = "my-database";
                },
              },
            },
            opts,
          ),
        "a database referenced with get": {
          create: (D1, opts) =>
            D1.get(
              "MyD1",
              { databaseId: "a1b2c3", accountId: "my-account" },
              opts,
            ),
          unclaimed: lookedUp,
          check: () =>
            expect(resource("MyD1Database")).toMatchObject({
              kind: "read",
              options: { id: "my-account/a1b2c3" },
            }),
        },
        // The worker is the 5.0 one both times: what it's given is the
        // database's binding
        "a database a worker is linked to": {
          create: (D1, opts) => {
            const db = new D1("MyD1", {}, opts);
            new Worker("MyWorker", { handler, link: [db] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({
              type: "d1",
              name: "MyD1",
              id: "MyD1Database_id",
            }),
        },
        "a database referenced with get that a worker is linked to": {
          create: (D1, opts) => {
            const db = D1.get("MyD1", { databaseId: "a1b2c3" }, opts);
            new Worker("MyWorker", { handler, link: [db] });
          },
          unclaimed: lookedUp,
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // to the database as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const db = new Original("MyD1");
        new OriginalWorker("MyWorker", { handler, link: [db] });
      },
      () => {
        const db = new D1("MyD1");
        new Worker("MyWorker", { handler, link: [db] });
      },
    );
    expect(result).toMatchObject({ unclaimed: [], changed: [], revealed: [] });
    expect(bindingsOf().find((b) => b.type === "d1")).toEqual({
      type: "d1",
      name: "MyD1",
      id: "MyD1Database_id",
    });
  });

  it("creates a database named for the app, in the account", async () => {
    const db = new D1("MyD1", { accountId: "my-account" });
    await pulumi.settle();
    expect(resource("MyD1Database").inputs).toMatchObject({
      accountId: "my-account",
      name: expect.stringMatching(/^app-test-myd1database-/),
    });
    const id = await new Promise((resolve) => db.databaseId.apply(resolve));
    expect(id).toBe("MyD1Database_id");
  });

  it("links its database id", async () => {
    const link = new D1("MyD1").link();
    await pulumi.settle();
    const value = (v: any) =>
      new Promise((resolve) => output(v).apply(resolve));
    expect(await value(link.properties)).toEqual({
      databaseId: "MyD1Database_id",
    });
    expect(link.include![0]).toMatchObject({
      type: "cloudflare.binding",
      binding: "d1DatabaseBindings",
    });
  });

  describe("an existing database", () => {
    it("is looked up in its account by get, with the component's options", async () => {
      const { Parent } = await parentClass();
      const parent = new Parent("Parent");
      D1.get(
        "MyD1",
        { databaseId: output("a1b2c3"), accountId: "acct" },
        { parent },
      );
      await pulumi.settle();
      expect(resource("MyD1Database")).toMatchObject({
        kind: "read",
        type: DATABASE,
        options: { id: "acct/a1b2c3" },
      });
      expect(resource("MyD1").parent).toMatch(/::Parent$/);
    });

    it("is looked up by its id in existing, with the account in front", async () => {
      new D1("MyD1", { accountId: "acct", existing: { database: "a1b2c3" } });
      await pulumi.settle();
      expect(resource("MyD1Database").options.id).toBe("acct/a1b2c3");
    });

    it("refuses the deprecated get with the id alone, showing the call to write", () => {
      expect(() => (D1.get as any)("MyD1", "a1b2c3")).toThrow(
        `D1.get("MyD1", ...) takes the database's ID in an object: sst.cloudflare.D1.get("MyD1", { databaseId: "a1b2c3" }).`,
      );
    });
  });
});

// A component to put another inside
async function parentClass() {
  const { ComponentResource } = await import("@pulumi/pulumi");
  class Parent extends ComponentResource {
    constructor(name: string) {
      super("test:Parent", name);
    }
  }
  return { Parent };
}
