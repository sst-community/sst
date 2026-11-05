import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output, secret } from "@pulumi/pulumi";
import { mockPulumi } from "../../../helpers/graph";

const CONFIG = "cloudflare:index/hyperdriveConfig:HyperdriveConfig";
// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type HyperdriveClass =
  | typeof import("../../../fixtures/v4/components/cloudflare/hyperdrive").Hyperdrive
  | typeof import("../../../../src/components/cloudflare/hyperdrive").Hyperdrive;

// The origin, with the password as most apps give it: a secret
const origin = () => ({
  database: "app",
  host: "db.example.com",
  password: secret("hunter2"),
  scheme: "postgres" as const,
  user: "postgres",
});

describe("Hyperdrive", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/hyperdrive").Hyperdrive;
  let Hyperdrive: typeof import("../../../../src/components/cloudflare/hyperdrive").Hyperdrive;
  let OriginalWorker: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;

  beforeAll(async () => {
    Original = (
      await import("../../../fixtures/v4/components/cloudflare/hyperdrive")
    ).Hyperdrive;
    Hyperdrive = (
      await import("../../../../src/components/cloudflare/hyperdrive")
    ).Hyperdrive;
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

  // 4.x's `get` looks the config up beside the component. V5 looks the same
  // config up inside it, which this can't match: a lookup has no aliases.
  // Nothing is deployed for a lookup, so nothing is deleted.
  const lookedUp = [`${CONFIG}::MyDatabaseHyperdrive`];

  describe("takes over a deployed Hyperdrive", () => {
    pulumi.takeoverCases<HyperdriveClass, HyperdriveClass>({
      original: () => Original,
      v5: () => Hyperdrive,
      provider: "cloudflare",
      cases: {
        "a config": {
          create: (Hyperdrive, opts) =>
            new Hyperdrive("MyDatabase", { origin: origin() }, opts),
          check: () =>
            expect(resource("MyDatabaseHyperdrive")).toMatchObject({
              kind: "register",
              type: CONFIG,
            }),
        },
        "a config for MySQL in another account": (Hyperdrive, opts) =>
          new Hyperdrive(
            "MyDatabase",
            {
              accountId: "other-account",
              origin: { ...origin(), scheme: "mysql", port: 3306 },
            },
            opts,
          ),
        // SST 4 kept the origin in plain text in the state when the password
        // was a plain string. It's marked secret: nothing in Cloudflare
        // changes. See "keeps the origin secret" below.
        "a config with a plain password": (Hyperdrive, opts) =>
          new Hyperdrive(
            "MyDatabase",
            { origin: { ...origin(), password: "hunter2" } },
            opts,
          ),
        "a config without caching": (Hyperdrive, opts) =>
          new Hyperdrive(
            "MyDatabase",
            { origin: origin(), caching: false },
            opts,
          ),
        "a config with caching, mTLS and a connection limit": (
          Hyperdrive,
          opts,
        ) =>
          new Hyperdrive(
            "MyDatabase",
            {
              origin: origin(),
              caching: {
                maxAge: "30 minutes",
                staleWhileRevalidate: "30 seconds",
              },
              mtls: { caCertificateId: "ca-cert", sslmode: "verify-full" },
              connectionLimit: 20,
            },
            opts,
          ),
        "a config with an access token": (Hyperdrive, opts) =>
          new Hyperdrive(
            "MyDatabase",
            {
              origin: {
                ...origin(),
                accessClientId: "client.access",
                accessClientSecret: secret("access-secret"),
              },
            },
            opts,
          ),
        "a config transformed": (Hyperdrive, opts) =>
          new Hyperdrive(
            "MyDatabase",
            {
              origin: origin(),
              transform: { hyperdrive: { name: "my-hyperdrive" } },
            },
            opts,
          ),
        "a config referenced with get": {
          create: (Hyperdrive, opts) =>
            Hyperdrive.get(
              "MyDatabase",
              { hyperdriveId: "a1b2c3", accountId: "my-account" },
              opts,
            ),
          unclaimed: lookedUp,
          check: () =>
            expect(resource("MyDatabaseHyperdrive")).toMatchObject({
              kind: "read",
              options: { id: "my-account/a1b2c3" },
            }),
        },
        // The worker is the 5.0 one both times: what it's given is the
        // config's binding
        "a config a worker is linked to": {
          create: (Hyperdrive, opts) => {
            const hyperdrive = new Hyperdrive(
              "MyDatabase",
              { origin: origin() },
              opts,
            );
            new Worker("MyWorker", { handler, link: [hyperdrive] });
          },
          check: () =>
            expect(bindingsOf()).toContainEqual({
              type: "hyperdrive",
              name: "MyDatabase",
              id: "MyDatabaseHyperdrive_id",
            }),
        },
        "a config referenced with get that a worker is linked to": {
          create: (Hyperdrive, opts) => {
            const hyperdrive = Hyperdrive.get(
              "MyDatabase",
              { hyperdriveId: "a1b2c3" },
              opts,
            );
            new Worker("MyWorker", { handler, link: [hyperdrive] });
          },
          unclaimed: lookedUp,
        },
      },
    });
  });

  // An app switches the Worker and what it's linked to: the Worker is bound
  // to the config as SST 4's was
  it("binds a worker the way SST 4's did", async () => {
    const result = await pulumi.takesOver(
      () => {
        const hyperdrive = new Original("MyDatabase", { origin: origin() });
        new OriginalWorker("MyWorker", { handler, link: [hyperdrive] });
      },
      () => {
        const hyperdrive = new Hyperdrive("MyDatabase", { origin: origin() });
        new Worker("MyWorker", { handler, link: [hyperdrive] });
      },
    );
    expect(result).toMatchObject({ unclaimed: [], changed: [], revealed: [] });
    expect(bindingsOf().find((b) => b.type === "hyperdrive")).toEqual({
      type: "hyperdrive",
      name: "MyDatabase",
      id: "MyDatabaseHyperdrive_id",
    });
  });

  // SST 4 kept it in plain text when the password was a plain string. Made
  // secret, it's kept encrypted in the state, which changes nothing in
  // Cloudflare.
  it("keeps the origin secret, whatever the password is", async () => {
    const args = { origin: { ...origin(), password: "hunter2" } };
    new Original("MyDatabase", args);
    await pulumi.settle();
    const before = pulumi.graph();
    pulumi.reset();
    new Hyperdrive("MyDatabase", args);
    await pulumi.settle();
    expect(pulumi.compare(before)).toMatchObject({
      unclaimed: [],
      changed: [],
      revealed: [],
      hidden: ["database", "host", "password", "scheme", "user"].map(
        (field) => `MyDatabaseHyperdrive.origin.${field}`,
      ),
    });
  });

  it("creates a config named for the app, with its origin kept secret", async () => {
    const hyperdrive = new Hyperdrive("MyDatabase", {
      accountId: "my-account",
      origin: { ...origin(), password: "hunter2" },
      connectionLimit: 20,
    });
    await pulumi.settle();
    const { inputs } = resource("MyDatabaseHyperdrive");
    expect(inputs).toMatchObject({
      accountId: "my-account",
      name: expect.stringMatching(/^app-test-mydatabasehyperdrive-/),
      originConnectionLimit: 20,
    });
    // A secret is recorded with its value under `value`
    expect(inputs.origin).toMatchObject({
      value: { host: "db.example.com", password: "hunter2" },
    });
    expect(inputs).not.toHaveProperty("caching");
    expect(await value(hyperdrive.id)).toBe("MyDatabaseHyperdrive_id");
    expect(await value(hyperdrive.name)).toBe(inputs.name);
  });

  it("turns caching off, or into seconds", async () => {
    new Hyperdrive("Off", { origin: origin(), caching: false });
    new Hyperdrive("On", {
      origin: origin(),
      caching: output({ maxAge: "1 hour" as const }),
    });
    await pulumi.settle();
    expect(resource("OffHyperdrive").inputs.caching).toEqual({
      disabled: true,
    });
    expect(resource("OnHyperdrive").inputs.caching).toEqual({ maxAge: 3600 });
  });

  // 4.x replaced a nested object in an object transform; 5.0 merges it
  it("merges an object transform into the origin", async () => {
    new Hyperdrive("MyDatabase", {
      origin: origin(),
      transform: { hyperdrive: { origin: { port: 6543 } } },
    });
    await pulumi.settle();
    expect(resource("MyDatabaseHyperdrive").inputs.origin).toMatchObject({
      value: { host: "db.example.com", port: 6543, password: "hunter2" },
    });
  });

  it("links its id", async () => {
    const link = new Hyperdrive("MyDatabase", {
      origin: origin(),
    }).link();
    await pulumi.settle();
    expect(await value(link.properties)).toEqual({
      id: "MyDatabaseHyperdrive_id",
    });
    expect(link.include![0]).toMatchObject({
      type: "cloudflare.binding",
      binding: "hyperdriveBindings",
    });
  });

  describe("an existing config", () => {
    it("is looked up in its account by get", async () => {
      Hyperdrive.get("MyDatabase", {
        hyperdriveId: output("a1b2c3"),
        accountId: "acct",
      });
      await pulumi.settle();
      expect(resource("MyDatabaseHyperdrive")).toMatchObject({
        kind: "read",
        type: CONFIG,
        options: { id: "acct/a1b2c3" },
      });
    });

    it("refuses settings next to it", () => {
      expect(
        () =>
          new Hyperdrive("MyDatabase", {
            origin: origin(),
            caching: false,
            existing: { hyperdrive: "a1b2c3" },
          }),
      ).toThrow(
        `The "MyDatabase" Hyperdrive is given an existing "hyperdrive", which it uses the way it is. Remove "origin", "caching" from its args.`,
      );
    });
  });
});
