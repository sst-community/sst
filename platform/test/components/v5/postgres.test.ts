import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output, secret } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const INSTANCE = "aws:rds/instance:Instance";
const PROXY = "aws:rds/proxy:Proxy";
const VERSION = "sst:sst:Version::MyDatabaseVersion";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === PROXY) return { endpoint: `${args.name}.proxy.example.com` };
    if (args.type !== INSTANCE) return {};
    // A database that's looked up has what it was created with
    if (args.id)
      return {
        identifier: args.id,
        endpoint: "shared.db.example.com:5432",
        port: 5432,
        username: "postgres",
        dbName: "shared",
        tagsAll: {
          "sst:component-version": "2",
          "sst:lookup:password": "secret-id",
        },
      };
    return { endpoint: `${args.name}.db.example.com:5432`, port: 5432 };
  },
  call: (args) => {
    if (args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion")
      return {
        secretString: JSON.stringify({
          username: "postgres",
          password: "stored-password",
        }),
      };
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
    return undefined;
  },
});

const vpc = { subnets: ["subnet-1", "subnet-2"] };

type PostgresClass =
  | typeof import("../../../src/components/aws/postgres").Postgres
  | typeof import("../../../src/components/aws/v5/postgres").Postgres;

describe("Postgres", () => {
  let OriginalPostgres: typeof import("../../../src/components/aws/postgres").Postgres;
  let Postgres: typeof import("../../../src/components/aws/v5/postgres").Postgres;
  let OriginalVpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Vpc: typeof import("../../../src/components/aws/v5/vpc").Vpc;

  beforeAll(async () => {
    OriginalVpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Vpc = (await import("../../../src/components/aws/v5/vpc")).Vpc;
    OriginalPostgres = (await import("../../../src/components/aws/postgres")).Postgres;
    Postgres = (await import("../../../src/components/aws/v5/postgres"))
      .Postgres;
    await import("../../../src/components/aws/takeover/postgres");
    await import("../../../src/components/aws/takeover/vpc");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name).sort();

  // Each case deploys the 4.x Postgres, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs: a database that's replaced loses its data. The one thing that goes
  // is the version marker the 4.x Postgres writes, which has nothing in AWS
  // behind it.
  describe("takes over a deployed Postgres", () => {
    pulumi.takeoverCases({
      original: () => OriginalPostgres,
      v5: () => Postgres,
      unclaimed: [VERSION],
      // In `sst dev` with `dev` set, neither creates the database
      check: () =>
        // @ts-ignore
        global.$dev ||
        expect(resource("MyDatabaseInstance").type).toBe(INSTANCE),
      cases: {
        "default database": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc }, opts);
        },
        "every setting": (Postgres, opts) => {
          new Postgres(
            "MyDatabase",
            {
              vpc,
              version: "16.4",
              username: "admin",
              password: "Passw0rd!",
              database: "acme",
              instance: "m7g.xlarge",
              storage: "100 GB",
              multiAz: true,
              blueGreen: true,
            },
            opts,
          );
        },
        "storage in terabytes": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc, storage: "2 TB" }, opts);
        },
        "blue/green with the smallest storage": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc, blueGreen: true }, opts);
        },
        "settings given as outputs": (Postgres, opts) => {
          new Postgres(
            "MyDatabase",
            {
              vpc: output({ subnets: [output("subnet-1"), "subnet-2"] }),
              version: output("15"),
              username: output("admin"),
              password: output("Passw0rd!"),
              database: output("acme"),
              instance: output("t4g.small"),
              storage: output("50 GB" as const),
              multiAz: output(true),
              blueGreen: output(false),
            },
            opts,
          );
        },
        "a proxy": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc, proxy: true }, opts);
        },
        "a proxy with additional credentials": (Postgres, opts) => {
          new Postgres(
            "MyDatabase",
            {
              vpc,
              proxy: {
                credentials: [
                  { username: "metabase", password: "Passw0rd!" },
                  { username: "app_user", password: output("S3cret") },
                  { username: "Reporting", password: "Passw0rd!" },
                ],
              },
            },
            opts,
          );
        },
        "a proxy with no additional credentials": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc, proxy: {} }, opts);
        },
        "read replicas": (Postgres, opts) => {
          new Postgres("MyDatabase", { vpc, replicas: 2 }, opts);
        },
        "read replicas with a chosen version": (Postgres, opts) => {
          new Postgres(
            "MyDatabase",
            { vpc, replicas: 1, version: "17.2" },
            opts,
          );
        },
        transforms: (Postgres, opts) => {
          new Postgres(
            "MyDatabase",
            {
              vpc,
              proxy: true,
              transform: {
                subnetGroup: { description: "custom" },
                parameterGroup: (args) => {
                  args.description = "tuned";
                },
                instance: (args, opts) => {
                  args.backupRetentionPeriod = 30;
                  args.identifier = "custom-identifier";
                  opts.protect = true;
                },
                proxy: { idleClientTimeout: 600, requireTls: true },
              },
            },
            opts,
          );
        },
        // The 4.x Postgres created a component for the pane `sst dev` shows
        // in every deploy. The V5 one reports the pane in `sst dev` alone.
        "dev args outside of sst dev": {
          create: (Postgres, opts) => {
            new Postgres(
              "MyDatabase",
              {
                vpc,
                dev: { username: "postgres", password: "password", port: 5433 },
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", VERSION],
          check: () => expect(pulumi.reportOf("MyDatabase")).toBeUndefined(),
        },
        "dev args in sst dev": {
          create: (Postgres, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Postgres(
              "MyDatabase",
              { vpc, dev: { password: "password", port: 5433 } },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", VERSION],
          // The component itself reports the pane, in its outputs
          changed: [["MyDatabase", ["outputs"]]],
          check: () =>
            expect(pulumi.reportOf("MyDatabase")).toHaveProperty("dev"),
        },
        // The 4.x dev command kept it secret in its outputs, and so does the
        // V5 pane
        "a secret dev password in sst dev": {
          create: (Postgres, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Postgres(
              "MyDatabase",
              { vpc, dev: { password: secret("password") } },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", VERSION],
          changed: [["MyDatabase", ["outputs"]]],
        },
        "a database referenced with get": (Postgres, opts) => {
          Postgres.get("MyDatabase", { id: "app-dev-mydatabase" }, opts);
        },
        "a database and proxy referenced with get": (Postgres, opts) => {
          Postgres.get(
            "MyDatabase",
            {
              id: "app-dev-mydatabase",
              proxyId: "app-dev-mydatabase-proxy",
            },
            opts,
          );
        },
        "a database in the private subnets of a Vpc": {
          create: (Postgres, opts) => {
            new Postgres(
              "MyDatabase",
              { vpc: new OriginalVpc("MyVpc"), proxy: true },
              opts,
            );
          },
          check: () =>
            expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual([
              "MyVpcPrivateSubnet1_id",
              "MyVpcPrivateSubnet2_id",
            ]),
        },
        "in a Vpc switched with it": {
          original: (opts) =>
            new OriginalPostgres(
              "MyDatabase",
              { vpc: new OriginalVpc("MyVpc"), proxy: true },
              opts,
            ),
          v5: (opts) =>
            new Postgres(
              "MyDatabase",
              { vpc: new Vpc("MyVpc"), proxy: true },
              opts,
            ),
          // Both version markers, with nothing in AWS behind them
          unclaimed: [VERSION, "sst:sst:Version::MyVpcVersion"],
        },
        // V5 merges an object transform into the defaults. 4.x
        // replaced a nested object whole, so tags set this way took the place
        // of the ones SST sets. Those come back: the one thing that changes.
        "an object transform that sets tags": {
          create: (Postgres, opts) => {
            new Postgres(
              "MyDatabase",
              { vpc, transform: { instance: { tags: { team: "data" } } } },
              opts,
            );
          },
          changed: [["MyDatabaseInstance", ["tags"]]],
          check: () =>
            expect(resource("MyDatabaseInstance").inputs.tags).toEqual({
              team: "data",
              "sst:component-version": "2",
              "sst:lookup:password": "MyDatabaseSecret_id",
            }),
        },
      },
    });

    it("keeps the secrets under their new names", async () => {
      const create = (Postgres: PostgresClass) =>
        new Postgres("MyDatabase", {
          vpc,
          proxy: { credentials: [{ username: "metabase", password: "x" }] },
        });

      create(OriginalPostgres);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(original.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "MyDatabaseProxySecret",
          "MyDatabaseProxySecretVersion",
          "MyDatabaseProxySecretmetabase",
          "MyDatabaseProxySecretVersionmetabase",
        ]),
      );

      pulumi.reset();
      create(Postgres);
      await pulumi.settle();
      expect(names()).toEqual(
        expect.arrayContaining([
          "MyDatabaseSecret",
          "MyDatabaseSecretVersion",
          "MyDatabaseProxySecretMetabase",
          "MyDatabaseProxySecretVersionMetabase",
        ]),
      );
      expect(pulumi.takeover(original)).toEqual({
        unclaimed: [VERSION],
        changed: [],
        unordered: [],
        revealed: [],
      });
    });
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    it("creates nothing and reports a pane when dev is set", async () => {
      const database = new Postgres("MyDatabase", {
        vpc,
        username: "admin",
        database: "acme",
        dev: { host: "127.0.0.1", port: 5433, password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Postgres"]);
      expect(
        await pulumi.resolve([
          database.host,
          database.port,
          database.username,
          database.password,
          database.database,
          database.id,
          database.proxyId,
        ]),
      ).toEqual([
        "127.0.0.1",
        5433,
        "admin",
        "local",
        "acme",
        "placeholder",
        "placeholder",
      ]);
      // The pane `sst dev` shows, titled with the component's name
      expect(pulumi.reportOf("MyDatabase")).toEqual({
        contract: 1,
        dev: {
          command: "sst print-and-not-quit",
          autostart: true,
          links: [],
          environment: {
            SST_DEV_COMMAND_MESSAGE: [
              "Make sure your local PostgreSQL server is using:",
              "",
              '  username: "admin"',
              '  password: "local"',
              '  database: "acme"',
              "",
              'Listening on "127.0.0.1:5433"...',
            ].join("\n"),
          },
        },
      });
    });

    it("says there's no password in its pane, given an empty one", async () => {
      const database = new Postgres("MyDatabase", {
        vpc,
        dev: { password: output("") },
      });
      await pulumi.settle();

      expect(
        pulumi.reportOf("MyDatabase")?.dev.environment.SST_DEV_COMMAND_MESSAGE,
      ).toContain('password: "\x1b[38;5;8m[no password]\x1b[0m"');
      expect(await pulumi.resolve(database.password)).toBe("");
    });

    it("uses the dev username and database, and the top-level password", async () => {
      const database = new Postgres("MyDatabase", {
        vpc,
        password: "top-level",
        dev: { username: "local-user", database: "local" },
      });
      await pulumi.settle();

      expect(
        await pulumi.resolve([
          database.host,
          database.port,
          database.username,
          database.password,
          database.database,
        ]),
      ).toEqual(["localhost", 5432, "local-user", "top-level", "local"]);
    });

    // The core reads it decrypted, as it read SST 4's `DevCommand`
    it("keeps a secret password secret in the state", async () => {
      new Postgres("MyDatabase", { vpc, dev: { password: secret("local") } });
      await pulumi.settle();

      const message =
        pulumi.reportOf("MyDatabase")?.dev.environment.SST_DEV_COMMAND_MESSAGE;
      expect(message).toMatchObject({
        "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
      });
      expect(message.value).toContain('password: "local"');
    });

    it("needs a password to connect with", () => {
      expect(() => new Postgres("MyDatabase", { vpc, dev: {} })).toThrow(
        /You must provide the password to connect to your locally running Postgres/,
      );
    });

    it("needs dev as a plain value", () => {
      expect(
        () => new Postgres("MyDatabase", { vpc, dev: output({}) as any }),
      ).toThrow(/The "dev" of the "MyDatabase" database has to be a plain value/);
    });

    it("explains why nodes are missing", async () => {
      const database = new Postgres("MyDatabase", {
        vpc,
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect(() => database.nodes.instance).toThrow(
        /Cannot access `nodes.instance` of "MyDatabase" in `sst dev`/,
      );
    });

    it("deploys the database when dev isn't set", async () => {
      new Postgres("MyDatabase", { vpc });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === INSTANCE)).toBe(true);
      expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
    });

    // `dev` says what `sst dev` connects to, whatever a deploy does
    it("connects to the local database in place of an existing one", async () => {
      const database = new Postgres("MyDatabase", {
        vpc,
        existing: { instance: "app-dev-mydatabase" },
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Postgres"]);
      expect(await pulumi.resolve([database.host, database.password])).toEqual(
        ["localhost", "local"],
      );
    });
  });

  it("uses an existing database with dev args outside of sst dev", async () => {
    const database = new Postgres("MyDatabase", {
      vpc,
      existing: { instance: "app-dev-mydatabase" },
      dev: { password: "local" },
    });
    await pulumi.settle();

    expect(resource("MyDatabaseInstance").kind).toBe("read");
    expect(await pulumi.resolve(database.host)).toBe("shared.db.example.com");
    expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
  });

  // 4.x asked for the password in `sst dev` alone
  it("deploys with dev args that have no password", async () => {
    new Postgres("MyDatabase", { vpc, dev: { port: 5433 } });
    await pulumi.settle();

    expect(pulumi.resources.some((r) => r.type === INSTANCE)).toBe(true);
    expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
  });

  it("creates the database with its defaults", async () => {
    const database = new Postgres("MyDatabase", { vpc });
    await pulumi.settle();

    expect(resource("MyDatabaseInstance").inputs).toMatchObject({
      dbName: "app",
      engine: "postgres",
      engineVersion: "17",
      instanceClass: "db.t4g.micro",
      username: "postgres",
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      multiAz: false,
      storageEncrypted: true,
      storageType: "gp3",
      backupRetentionPeriod: 7,
      blueGreenUpdate: { enabled: false },
      tags: {
        "sst:component-version": "2",
        "sst:lookup:password": "MyDatabaseSecret_id",
      },
    });
    expect(resource("MyDatabaseInstance").options).toMatchObject({
      deleteBeforeReplace: true,
      ignoreChanges: expect.arrayContaining(["engineVersion"]),
    });
    expect(resource("MyDatabaseParameterGroup").inputs.family).toBe("postgres17");
    expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual(
      vpc.subnets,
    );
    expect(
      await pulumi.resolve([database.host, database.port, database.database]),
    ).toEqual(["MyDatabaseInstance.db.example.com", 5432, "app"]);
  });

  it("follows the engine version once one is chosen", async () => {
    new Postgres("MyDatabase", { vpc, version: "16.4", replicas: 1 });
    await pulumi.settle();

    for (const name of ["MyDatabaseInstance", "MyDatabaseReplica0"])
      expect(resource(name).options.ignoreChanges ?? []).not.toContain(
        "engineVersion",
      );
    expect(
      resource("MyDatabaseParameterGroup").options.ignoreChanges ?? [],
    ).not.toContain("family");
    expect(resource("MyDatabaseParameterGroup").inputs.family).toBe("postgres16");
  });

  it("creates a password only when none is given", async () => {
    new Postgres("Generated", { vpc });
    const given = new Postgres("Given", { vpc, password: "Passw0rd!" });
    await pulumi.settle();

    expect(names()).toContain("GeneratedPassword");
    expect(names()).not.toContain("GivenPassword");
    expect(given.nodes.password).toBeUndefined();
    expect(await pulumi.resolve(given.password)).toBe("Passw0rd!");
    // The provider marks the secret's contents as a secret value
    expect(
      JSON.parse(resource("GivenSecretVersion").inputs.secretString.value),
    ).toEqual({ username: "postgres", password: "Passw0rd!" });
  });

  it("exposes every resource on nodes", async () => {
    const database = new Postgres("MyDatabase", {
      vpc,
      replicas: 2,
      proxy: { credentials: [{ username: "metabase", password: "x" }] },
    });
    await pulumi.settle();

    expect(Object.keys(database.nodes)).toEqual([
      "password",
      "secret",
      "secretVersion",
      "subnetGroup",
      "parameterGroup",
      "instance",
      "replica",
      "proxySecret",
      "proxySecretVersion",
      "proxyRole",
      "proxyRoleLookup",
      "proxy",
      "proxyTargetGroup",
      "proxyTarget",
    ]);
    expect(database.nodes.instance.constructor.name).toBe("Instance");
    expect(database.nodes.proxy!.constructor.name).toBe("Proxy");
    expect(Object.keys(database.nodes.replica)).toEqual(["0", "1"]);
    expect(Object.keys(database.nodes.proxySecret)).toEqual(["metabase"]);
    expect(database.nodes.proxyRoleLookup!.constructor.name).toBe(
      "RdsRoleLookup",
    );
  });

  it("connects through the proxy when there is one", async () => {
    const database = new Postgres("MyDatabase", {
      vpc,
      proxy: { credentials: [{ username: "metabase", password: "x" }] },
    });
    await pulumi.settle();

    expect(await pulumi.resolve([database.host, database.proxyId])).toEqual([
      "MyDatabaseProxy.proxy.example.com",
      "MyDatabaseProxy_id",
    ]);
    // The proxy can connect as the master user and as each additional user
    expect(resource("MyDatabaseProxy").inputs.auths).toEqual([
      {
        authScheme: "SECRETS",
        iamAuth: "DISABLED",
        secretArn: "arn:aws:mock:us-east-1:123456789012:MyDatabaseSecret",
      },
      {
        authScheme: "SECRETS",
        iamAuth: "DISABLED",
        secretArn:
          "arn:aws:mock:us-east-1:123456789012:MyDatabaseProxySecretMetabase",
      },
    ]);
    expect(resource("MyDatabaseProxyTarget").inputs.dbInstanceIdentifier).toBe(
      resource("MyDatabaseInstance").inputs.identifier,
    );
  });

  it("says there is no proxy when its id is read", async () => {
    const database = new Postgres("MyDatabase", { vpc });
    await pulumi.settle();

    expect(database.nodes.proxy).toBeUndefined();
    expect(() => database.proxyId).toThrow(
      /Proxy is not enabled. Enable it with "proxy: true"/,
    );
  });

  it("transforms the parts Postgres had no transform for", async () => {
    new Postgres("MyDatabase", {
      vpc,
      proxy: true,
      replicas: 2,
      transform: {
        secret: { description: "Database credentials" },
        proxyRole: { path: "/database/" },
        replica: (args, _opts, _name, replica) => {
          if (replica === "1") args.instanceClass = "db.t4g.large";
        },
      },
    });
    await pulumi.settle();

    expect(resource("MyDatabaseSecret").inputs).toMatchObject({
      description: "Database credentials",
      recoveryWindowInDays: 0,
    });
    expect(resource("MyDatabaseProxyRole").inputs.path).toBe("/database/");
    expect(resource("MyDatabaseReplica1").inputs.instanceClass).toBe(
      "db.t4g.large",
    );
    expect(resource("MyDatabaseReplica0").inputs.instanceClass).toBe(
      "db.t4g.micro",
    );
  });

  describe("a database that's already deployed", () => {
    it("is connected to with its stored password", async () => {
      const database = Postgres.get("MyDatabase", { id: "app-dev-mydatabase" });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => [r.kind, r.name])).toEqual([
        ["register", "MyDatabase"],
        ["read", "MyDatabaseInstance"],
      ]);
      expect(
        await pulumi.resolve([
          database.id,
          database.host,
          database.port,
          database.username,
          database.password,
          database.database,
        ]),
      ).toEqual([
        "app-dev-mydatabase",
        "shared.db.example.com",
        5432,
        "postgres",
        "stored-password",
        "shared",
      ]);
      expect(() => database.proxyId).toThrow(/Proxy is not enabled/);
    });

    it("is connected to through its proxy", async () => {
      const database = Postgres.get("MyDatabase", {
        id: "app-dev-mydatabase",
        proxyId: "app-dev-mydatabase-proxy",
      });
      await pulumi.settle();

      expect(resource("MyDatabaseProxy")).toMatchObject({
        kind: "read",
        options: { id: "app-dev-mydatabase-proxy" },
      });
      expect(await pulumi.resolve([database.host, database.proxyId])).toEqual([
        "MyDatabaseProxy.proxy.example.com",
        "app-dev-mydatabase-proxy",
      ]);
    });

    it("can be passed as a resource, with its password", async () => {
      const { rds } = await import("@pulumi/aws");
      const mine = new rds.Instance("Mine", {
        instanceClass: "db.t4g.micro",
        username: "owner",
        dbName: "mine",
      });
      await pulumi.settle();
      pulumi.reset();

      const database = new Postgres("MyDatabase", {
        vpc,
        password: "known",
        existing: { instance: mine },
      });
      await pulumi.settle();

      expect(database.nodes.instance).toBe(mine);
      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Postgres"]);
      expect(
        await pulumi.resolve([
          database.host,
          database.username,
          database.password,
          database.database,
        ]),
      ).toEqual(["Mine.db.example.com", "owner", "known", "mine"]);
    });
  });

  it("links with the connection details", async () => {
    const { Link } = await import("../../../src/components/link");
    const database = new Postgres("MyDatabase", { vpc });
    await pulumi.settle();

    expect(Link.isLinkable(database)).toBe(true);
    expect(Object.keys((database as any).getSSTLink().properties)).toEqual([
      "database",
      "username",
      "password",
      "port",
      "host",
    ]);
  });

  it("says what has to be a plain value", () => {
    expect(
      () => new Postgres("MyDatabase", { vpc, proxy: output(true) as any }),
    ).toThrow(/The "proxy" of the "MyDatabase" database has to be a plain value/);
    expect(
      () =>
        new Postgres("Second", {
          vpc,
          proxy: { credentials: output([]) as any },
        }),
    ).toThrow(/The "proxy.credentials" of the "Second" database has to be a plain value/);
    expect(
      () =>
        new Postgres("Third", {
          vpc,
          proxy: {
            credentials: [{ username: output("metabase") as any, password: "x" }],
          },
        }),
    ).toThrow(/The "username" in the "proxy.credentials" of the "Third" database has to be a plain value/);
  });

  describe("in a Vpc", () => {
    it("is in the private subnets of either kind", async () => {
      for (const [i, VpcClass] of [OriginalVpc, Vpc].entries()) {
        pulumi.reset();
        const net = new VpcClass(`Net${i}`);
        new Postgres("MyDatabase", { vpc: net, proxy: true });
        await pulumi.settle();

        const subnets = await pulumi.resolve(net.privateSubnets);
        expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual(
          subnets,
        );
        expect(resource("MyDatabaseProxy").inputs.vpcSubnetIds).toEqual(
          subnets,
        );
      }
    });

    it("turns down another resource in its place", async () => {
      const aws = await import("@pulumi/aws");
      const { Vpc: VpcV1 } = await import(
        "../../../src/components/aws/vpc-v1"
      );
      for (const [i, net] of [
        new aws.ec2.Vpc("Net", { cidrBlock: "10.0.0.0/16" }),
        new VpcV1("Old"),
      ].entries())
        expect(() => new Postgres(`Database${i}`, { vpc: net as any })).toThrow(
          `The "vpc" of the "Database${i}" Postgres component isn't a "Vpc" component`,
        );
      await pulumi.settle();
    });
  });
});
