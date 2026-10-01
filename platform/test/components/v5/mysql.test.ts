import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const INSTANCE = "aws:rds/instance:Instance";
const PROXY = "aws:rds/proxy:Proxy";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === PROXY) return { endpoint: `${args.name}.proxy.example.com` };
    if (args.type !== INSTANCE) return {};
    // A database that's looked up has what it was created with
    if (args.id)
      return {
        identifier: args.id,
        endpoint: "shared.db.example.com:3306",
        port: 3306,
        username: "root",
        dbName: "shared",
        tagsAll: {
          "sst:component-version": "1",
          "sst:ref:password": "secret-id",
        },
      };
    return { endpoint: `${args.name}.db.example.com:3306`, port: 3306 };
  },
  call: (args) => {
    if (args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion")
      return {
        secretString: JSON.stringify({
          username: "root",
          password: "stored-password",
        }),
      };
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
    return undefined;
  },
});

const vpc = { subnets: ["subnet-1", "subnet-2"] };

type MysqlClass =
  | typeof import("../../../src/components/aws/mysql").Mysql
  | typeof import("../../../src/components/aws/v5/mysql").Mysql;

describe("Mysql", () => {
  let OriginalMysql: typeof import("../../../src/components/aws/mysql").Mysql;
  let Mysql: typeof import("../../../src/components/aws/v5/mysql").Mysql;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;

  beforeAll(async () => {
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    OriginalMysql = (await import("../../../src/components/aws/mysql")).Mysql;
    Mysql = (await import("../../../src/components/aws/v5/mysql"))
      .Mysql;
    await import("../../../src/components/aws/takeover/mysql");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name).sort();

  // Each case deploys the 4.x Mysql, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs: a database that's replaced loses its data.
  describe("takes over a deployed Mysql", () => {
    pulumi.takeoverCases({
      original: () => OriginalMysql,
      v5: () => Mysql,
      check: () => expect(resource("MyDatabaseInstance").type).toBe(INSTANCE),
      cases: {
        "default database": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc }, opts);
        },
        "every setting": (Mysql, opts) => {
          new Mysql(
            "MyDatabase",
            {
              vpc,
              version: "8.4.4",
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
        "storage in terabytes": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, storage: "2 TB" }, opts);
        },
        "blue/green with the smallest storage": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, blueGreen: true }, opts);
        },
        "settings given as outputs": (Mysql, opts) => {
          new Mysql(
            "MyDatabase",
            {
              vpc: output({ subnets: [output("subnet-1"), "subnet-2"] }),
              version: output("8.0.39"),
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
        "a proxy": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, proxy: true }, opts);
        },
        "a proxy with additional credentials": (Mysql, opts) => {
          new Mysql(
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
        "a proxy with no additional credentials": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, proxy: {} }, opts);
        },
        "read replicas": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, replicas: 2 }, opts);
        },
        "read replicas with a chosen version": (Mysql, opts) => {
          new Mysql("MyDatabase", { vpc, replicas: 1, version: "8.4.4" }, opts);
        },
        transforms: (Mysql, opts) => {
          new Mysql(
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
        "dev args outside of sst dev": (Mysql, opts) => {
          new Mysql(
            "MyDatabase",
            {
              vpc,
              dev: { username: "root", password: "password", port: 3307 },
            },
            opts,
          );
        },
        "a database referenced with get": (Mysql, opts) => {
          Mysql.get("MyDatabase", { id: "app-dev-mydatabase" }, opts);
        },
        "a database and proxy referenced with get": (Mysql, opts) => {
          Mysql.get(
            "MyDatabase",
            {
              id: "app-dev-mydatabase",
              proxyId: "app-dev-mydatabase-proxy",
            },
            opts,
          );
        },
        "a database in the private subnets of a Vpc": {
          create: (Mysql, opts) => {
            new Mysql(
              "MyDatabase",
              { vpc: new Vpc("MyVpc"), proxy: true },
              opts,
            );
          },
          check: () =>
            expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual([
              "MyVpcPrivateSubnet1_id",
              "MyVpcPrivateSubnet2_id",
            ]),
        },
        // V5 merges an object transform into the defaults. 4.x replaced
        // a nested object whole, so tags set this way took the place of the
        // ones SST sets. Those come back: the one thing that changes.
        "an object transform that sets tags": {
          create: (Mysql, opts) => {
            new Mysql(
              "MyDatabase",
              { vpc, transform: { instance: { tags: { team: "data" } } } },
              opts,
            );
          },
          changed: [["MyDatabaseInstance", ["tags"]]],
          check: () =>
            expect(resource("MyDatabaseInstance").inputs.tags).toEqual({
              team: "data",
              "sst:component-version": "1",
              "sst:ref:password": "MyDatabaseSecret_id",
            }),
        },
      },
    });

    it("keeps the secrets under their new names", async () => {
      const create = (Mysql: MysqlClass) =>
        new Mysql("MyDatabase", {
          vpc,
          proxy: { credentials: [{ username: "metabase", password: "x" }] },
        });

      create(OriginalMysql);
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
      create(Mysql);
      await pulumi.settle();
      expect(names()).toEqual(
        expect.arrayContaining([
          "MyDatabaseSecret",
          "MyDatabaseSecretVersion",
          "MyDatabaseProxySecretMetabase",
          "MyDatabaseProxySecretVersionMetabase",
        ]),
      );
      expect(pulumi.takeover(original)).toEqual({ unclaimed: [], changed: [] });
    });
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    it("creates nothing but the dev command when dev is set", async () => {
      const database = new Mysql("MyDatabase", {
        vpc,
        username: "admin",
        database: "acme",
        dev: { host: "127.0.0.1", port: 3307, password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type).sort()).toEqual([
        "sst:aws:MysqlV5",
        "sst:sst:DevCommand",
      ]);
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
        3307,
        "admin",
        "local",
        "acme",
        "placeholder",
        "placeholder",
      ]);
    });

    it("uses the dev username and database, and the top-level password", async () => {
      const database = new Mysql("MyDatabase", {
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
      ).toEqual(["localhost", 3306, "local-user", "top-level", "local"]);
    });

    it("needs a password to connect with", () => {
      expect(() => new Mysql("MyDatabase", { vpc, dev: {} })).toThrow(
        /You must provide the password to connect to your locally running MySQL/,
      );
    });

    it("explains why nodes are missing", async () => {
      const database = new Mysql("MyDatabase", {
        vpc,
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect(() => database.nodes.instance).toThrow(
        /Cannot access `nodes.instance` of "MyDatabase" in `sst dev`/,
      );
    });

    it("deploys the database when dev isn't set", async () => {
      new Mysql("MyDatabase", { vpc });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === INSTANCE)).toBe(true);
    });
  });

  it("creates the database with its defaults", async () => {
    const database = new Mysql("MyDatabase", { vpc });
    await pulumi.settle();

    expect(resource("MyDatabaseInstance").inputs).toMatchObject({
      dbName: "app",
      engine: "mysql",
      engineVersion: "8.0.40",
      instanceClass: "db.t4g.micro",
      username: "root",
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      multiAz: false,
      storageEncrypted: true,
      storageType: "gp3",
      backupRetentionPeriod: 7,
      blueGreenUpdate: { enabled: false },
      // Not offered on an instance this small
      performanceInsightsEnabled: false,
      tags: {
        "sst:component-version": "1",
        "sst:ref:password": "MyDatabaseSecret_id",
      },
    });
    expect(resource("MyDatabaseInstance").options).toMatchObject({
      deleteBeforeReplace: true,
      ignoreChanges: expect.arrayContaining(["engineVersion"]),
    });
    expect(resource("MyDatabaseParameterGroup").inputs).toMatchObject({
      family: "mysql8.0",
      parameters: [{ name: "require_secure_transport", value: "OFF" }],
    });
    expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual(
      vpc.subnets,
    );
    expect(
      await pulumi.resolve([database.host, database.port, database.database]),
    ).toEqual(["MyDatabaseInstance.db.example.com", 3306, "app"]);
  });

  it("turns performance insights on for instances that offer it", async () => {
    new Mysql("MyDatabase", { vpc, instance: "m7g.xlarge" });
    await pulumi.settle();

    expect(
      resource("MyDatabaseInstance").inputs.performanceInsightsEnabled,
    ).toBe(true);
  });

  it("follows the engine version once one is chosen", async () => {
    new Mysql("MyDatabase", { vpc, version: "8.4.4", replicas: 1 });
    await pulumi.settle();

    for (const name of ["MyDatabaseInstance", "MyDatabaseReplica0"])
      expect(resource(name).options.ignoreChanges ?? []).not.toContain(
        "engineVersion",
      );
    expect(
      resource("MyDatabaseParameterGroup").options.ignoreChanges ?? [],
    ).not.toContain("family");
    expect(resource("MyDatabaseParameterGroup").inputs.family).toBe("mysql8.4");
  });

  it("creates a password only when none is given", async () => {
    new Mysql("Generated", { vpc });
    const given = new Mysql("Given", { vpc, password: "Passw0rd!" });
    await pulumi.settle();

    expect(names()).toContain("GeneratedPassword");
    expect(names()).not.toContain("GivenPassword");
    expect(given.nodes.password).toBeUndefined();
    expect(await pulumi.resolve(given.password)).toBe("Passw0rd!");
    // The provider marks the secret's contents as a secret value
    expect(
      JSON.parse(resource("GivenSecretVersion").inputs.secretString.value),
    ).toEqual({ username: "root", password: "Passw0rd!" });
  });

  it("exposes every resource on nodes", async () => {
    const database = new Mysql("MyDatabase", {
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
    const database = new Mysql("MyDatabase", {
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
    const database = new Mysql("MyDatabase", { vpc });
    await pulumi.settle();

    expect(database.nodes.proxy).toBeUndefined();
    expect(() => database.proxyId).toThrow(
      /Proxy is not enabled. Enable it with "proxy: true"/,
    );
  });

  it("transforms the parts Mysql had no transform for", async () => {
    new Mysql("MyDatabase", {
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
      const database = Mysql.get("MyDatabase", { id: "app-dev-mydatabase" });
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
        3306,
        "root",
        "stored-password",
        "shared",
      ]);
      expect(() => database.proxyId).toThrow(/Proxy is not enabled/);
    });

    it("is connected to through its proxy", async () => {
      const database = Mysql.get("MyDatabase", {
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

      const database = new Mysql("MyDatabase", {
        vpc,
        password: "known",
        existing: { instance: mine },
      });
      await pulumi.settle();

      expect(database.nodes.instance).toBe(mine);
      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:MysqlV5"]);
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
    const database = new Mysql("MyDatabase", { vpc });
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
      () => new Mysql("MyDatabase", { vpc, proxy: output(true) as any }),
    ).toThrow(/The "proxy" of the "MyDatabase" database has to be a plain value/);
    expect(
      () =>
        new Mysql("Second", {
          vpc,
          proxy: { credentials: output([]) as any },
        }),
    ).toThrow(/The "proxy.credentials" of the "Second" database has to be a plain value/);
    expect(
      () =>
        new Mysql("Third", {
          vpc,
          proxy: {
            credentials: [{ username: output("metabase") as any, password: "x" }],
          },
        }),
    ).toThrow(/The "username" in the "proxy.credentials" of the "Third" database has to be a plain value/);
  });

  it("rejects a Vpc.v1", async () => {
    const { Vpc } = await import("../../../src/components/aws/vpc-v1");
    expect(
      () =>
        new Mysql("MyDatabase", {
          vpc: Object.create(Vpc.prototype),
        }),
    ).toThrow(/You are using the "Vpc.v1" component/);
  });
});
