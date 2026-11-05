import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ComponentResourceOptions,
  output,
  secret,
} from "@pulumi/pulumi";
import { mockPulumi, sidedClass } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

const CLUSTER = "aws:rds/cluster:Cluster";
const INSTANCE = "aws:rds/clusterInstance:ClusterInstance";
const PROXY = "aws:rds/proxy:Proxy";
const SECRET = "aws:secretsmanager/secret:Secret";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === PROXY) return { endpoint: `${args.name}.proxy.example.com` };
    if (args.type === INSTANCE) return { port: 5432 };
    if (args.type !== CLUSTER) return {};
    const endpoints = {
      endpoint: `${args.name}.cluster.example.com`,
      readerEndpoint: `${args.name}.reader.example.com`,
    };
    // A cluster that's looked up has what it was created with: the tags that
    // name its secret, and its proxy when it has one
    if (args.id)
      return {
        ...endpoints,
        masterUsername: "postgres",
        databaseName: "shared",
        tagsAll: args.id.includes("untagged")
          ? {}
          : {
              "sst:ref:password": "shared-secret",
              ...(args.id.includes("proxied")
                ? { "sst:ref:proxy": "shared-proxy" }
                : {}),
            },
      };
    return endpoints;
  },
  call: (args) => {
    // The password in the secret a cluster is tagged with, or in another
    if (args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion")
      return {
        secretString: JSON.stringify({
          username: "postgres",
          password:
            args.inputs.secretId === "shared-secret"
              ? "stored-password"
              : `the password in ${args.inputs.secretId}`,
        }),
      };
    if (args.token === "aws:rds/getInstances:getInstances")
      return { instanceIdentifiers: ["shared-instance-1", "shared-instance-2"] };
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
    return undefined;
  },
});

const vpc = { subnets: ["subnet-1", "subnet-2"], securityGroups: ["sg-1"] };

type AuroraClass =
  | typeof import("../../fixtures/v4/components/aws/aurora").Aurora
  | typeof import("../../../src/components/aws/aurora").Aurora;

describe("Aurora", () => {
  let OriginalAurora: typeof import("../../fixtures/v4/components/aws/aurora").Aurora;
  let Aurora: typeof import("../../../src/components/aws/aurora").Aurora;
  let OriginalVpc: typeof import("../../fixtures/v4/components/aws/vpc").Vpc;
  let SidedVpc: any;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;

  beforeAll(async () => {
    OriginalVpc = (await import("../../fixtures/v4/components/aws/vpc")).Vpc;
    // SST 4's for SST 4's side, SST 5's for SST 5's
    SidedVpc = await sidedClass(
      "Vpc",
      import("../../fixtures/v4/components/aws/vpc"),
      import("../../../src/components/aws/vpc"),
      import("../../../src/components/aws/takeover/vpc"),
    );
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    OriginalAurora = (await import("../../fixtures/v4/components/aws/aurora")).Aurora;
    Aurora = (await import("../../../src/components/aws/aurora")).Aurora;
    await import("../../../src/components/aws/takeover/aurora");
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

  // Each case deploys the 4.x Aurora, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs: a cluster that's replaced loses its data.
  describe("takes over a deployed Aurora", () => {
    pulumi.takeoverCases({
      original: () => OriginalAurora,
      v5: () => Aurora,
      check: () => {
        // In `sst dev` with `dev` set, neither creates the cluster
        // @ts-ignore
        if (global.$dev) return;
        expect(resource("MyDatabaseCluster").type).toBe(CLUSTER);
        expect(resource("MyDatabaseInstance").type).toBe(INSTANCE);
      },
      cases: {
        "postgres cluster": (Aurora, opts) => {
          new Aurora("MyDatabase", { engine: "postgres", vpc }, opts);
        },
        "mysql cluster": (Aurora, opts) => {
          new Aurora("MyDatabase", { engine: "mysql", vpc }, opts);
        },
        "every postgres setting": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              version: "16.4",
              username: "admin",
              password: "Passw0rd!",
              database: "acme",
              scaling: { min: "2 ACU", max: "128 ACU" },
              dataApi: true,
            },
            opts,
          );
        },
        "mysql version 3": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            { engine: "mysql", vpc, version: "3.05.2" },
            opts,
          );
        },
        "mysql version 2": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            { engine: "mysql", vpc, version: "2.12.0" },
            opts,
          );
        },
        "scaling that pauses after a while": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              scaling: { min: "0 ACU", max: "8 ACU", pauseAfter: "20 minutes" },
            },
            opts,
          );
        },
        "scaling with only a minimum": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              scaling: { min: "0.5 ACU" },
            },
            opts,
          );
        },
        "settings given as outputs": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: output("mysql" as const),
              vpc: output({
                subnets: [output("subnet-1")],
                securityGroups: ["sg-1"],
              }),
              version: output("3.08.0"),
              username: output("admin"),
              password: output("Passw0rd!"),
              database: output("acme"),
              scaling: output({
                min: output("1 ACU" as const),
                max: "2 ACU" as const,
              }),
              dataApi: output(true),
            },
            opts,
          );
        },
        "read replicas": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            { engine: "postgres", vpc, replicas: 2 },
            opts,
          );
        },
        "read replicas with a chosen version": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              replicas: 1,
              version: "17.3",
            },
            opts,
          );
        },
        "a proxy": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            { engine: "postgres", vpc, proxy: true },
            opts,
          );
        },
        "a mysql proxy with additional credentials": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "mysql",
              vpc,
              replicas: 1,
              proxy: {
                credentials: [
                  { username: "metabase", password: "Passw0rd!" },
                  { username: "app_user", password: output("S3cret") },
                ],
              },
            },
            opts,
          );
        },
        "a proxy with no additional credentials": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            { engine: "postgres", vpc, proxy: {} },
            opts,
          );
        },
        // The 4.x Aurora applies the instance's transform to each replica as
        // well
        transforms: (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              proxy: true,
              replicas: 2,
              transform: {
                subnetGroup: { description: "custom" },
                clusterParameterGroup: {
                  parameters: [{ name: "rds.force_ssl", value: "1" }],
                },
                instanceParameterGroup: (args) => {
                  args.description = "tuned";
                },
                cluster: (args, opts) => {
                  args.backupRetentionPeriod = 30;
                  args.clusterIdentifier = "custom-identifier";
                  opts.protect = true;
                },
                instance: { performanceInsightsEnabled: true },
                proxy: { idleClientTimeout: 600 },
              },
            },
            opts,
          );
        },
        "an instance transform as a function": (Aurora, opts) => {
          new Aurora(
            "MyDatabase",
            {
              engine: "postgres",
              vpc,
              replicas: 2,
              transform: {
                instance: (args, opts, name) => {
                  args.monitoringInterval = name.endsWith("Instance") ? 60 : 30;
                  opts.protect = true;
                },
              },
            },
            opts,
          );
        },
        // The 4.x Aurora created a component for the pane `sst dev` shows in
        // every deploy. The V5 one reports the pane in `sst dev` alone.
        "dev args outside of sst dev": {
          create: (Aurora, opts) => {
            new Aurora(
              "MyDatabase",
              {
                engine: "mysql",
                vpc,
                dev: { username: "root", password: "password" },
              },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev"],
          check: () => expect(pulumi.reportOf("MyDatabase")).toBeUndefined(),
        },
        "dev args in sst dev": {
          create: (Aurora, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Aurora(
              "MyDatabase",
              { engine: "mysql", vpc, dev: { password: "password" } },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev"],
          // The component itself reports the pane, in its outputs
          changed: [["MyDatabase", ["outputs"]]],
          check: () =>
            expect(pulumi.reportOf("MyDatabase")).toHaveProperty("dev"),
        },
        // The 4.x dev command kept it secret in its outputs, and so does the
        // V5 pane
        "a secret dev password in sst dev": {
          create: (Aurora, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Aurora(
              "MyDatabase",
              { engine: "postgres", vpc, dev: { password: secret("password") } },
              opts,
            );
          },
          unclaimed: ["sst:sst:DevCommand::MyDatabaseDev"],
          changed: [["MyDatabase", ["outputs"]]],
        },
        "in a Vpc switched with it": {
          original: (opts) =>
            new OriginalAurora(
              "MyDatabase",
              { engine: "postgres", vpc: new OriginalVpc("MyVpc"), proxy: true },
              opts,
            ),
          v5: (opts) =>
            new Aurora(
              "MyDatabase",
              { engine: "postgres", vpc: new Vpc("MyVpc"), proxy: true },
              opts,
            ),
          // The Vpc's version marker, with nothing in AWS behind it
          unclaimed: ["sst:sst:Version::MyVpcVersion"],
        },
        "a cluster in the private subnets of a Vpc": {
          create: (Aurora, opts) => {
            new Aurora(
              "MyDatabase",
              {
                engine: "postgres",
                vpc: new SidedVpc("MyVpc"),
                proxy: true,
              },
              opts,
            );
          },
          check: () => {
            expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual([
              "MyVpcPrivateSubnet1_id",
              "MyVpcPrivateSubnet2_id",
            ]);
            expect(
              resource("MyDatabaseCluster").inputs.vpcSecurityGroupIds,
            ).toEqual(["MyVpcSecurityGroup_id"]);
          },
        },
        // V5 merges an object transform into the defaults. 4.x
        // replaced a nested object whole, so tags set this way took the place
        // of the ones SST sets. Those come back: the one thing that changes.
        "an object transform that sets tags": {
          create: (Aurora, opts) => {
            new Aurora(
              "MyDatabase",
              {
                engine: "postgres",
                vpc,
                transform: { cluster: { tags: { team: "data" } } },
              },
              opts,
            );
          },
          changed: [["MyDatabaseCluster", ["tags"]]],
          check: () =>
            expect(resource("MyDatabaseCluster").inputs.tags).toEqual({
              team: "data",
              "sst:ref:password": "MyDatabaseSecret_id",
            }),
        },
        // The 4.x Aurora looks the cluster's secret up under the name it
        // creates it with, "ProxySecret". V5 looks the same secret up as
        // "Secret", which this can't match: a lookup has no aliases. Nothing is
        // deployed for a lookup, so nothing is deleted.
        ...Object.fromEntries(
          ["app-dev-mydatabase", "app-dev-proxied"].map((id) => [
            `a cluster referenced with get (${id})`,
            {
              create: (Aurora: AuroraClass, opts?: ComponentResourceOptions) =>
                Aurora.get("MyDatabase", id, opts),
              unclaimed: [`${SECRET}::MyDatabaseProxySecret`],
              check: () =>
                expect(resource("MyDatabaseSecret")).toMatchObject({
                  kind: "read",
                  options: { id: "shared-secret" },
                }),
            },
          ]),
        ),
      },
    });

    it("keeps what it renames", async () => {
      const create = (Aurora: AuroraClass) =>
        new Aurora("MyDatabase", {
          engine: "postgres",
          vpc,
          proxy: { credentials: [{ username: "metabase", password: "x" }] },
        });

      create(OriginalAurora);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(original.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "MyDatabaseProxySecret",
          "MyDatabaseProxySecretVersion",
          "MyDatabaseParameterGroup",
          "MyDatabaseProxySecretmetabase",
          "MyDatabaseProxySecretVersionmetabase",
        ]),
      );

      pulumi.reset();
      await pulumi.asMove(original, async () => {
        create(Aurora);
        await pulumi.settle();
      });
      expect(names()).toEqual(
        expect.arrayContaining([
          "MyDatabaseSecret",
          "MyDatabaseSecretVersion",
          "MyDatabaseInstanceParameterGroup",
          "MyDatabaseProxySecretMetabase",
          "MyDatabaseProxySecretVersionMetabase",
        ]),
      );
      expect(pulumi.takeover(original)).toEqual({
        unclaimed: [],
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
      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        username: "admin",
        database: "acme",
        dev: { host: "127.0.0.1", password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Aurora"]);
      // The pane `sst dev` shows, titled with the component's name
      expect(pulumi.reportOf("MyDatabase")).toEqual({
        contract: 1,
        dev: {
          command: "sst print-and-not-quit",
          autostart: true,
          links: [],
          environment: {
            SST_DEV_COMMAND_MESSAGE: [
              "Make sure your local database is using:",
              "",
              '  username: "admin"',
              '  password: "local"',
              '  database: "acme"',
              "",
              'Listening on "127.0.0.1:5432"...',
            ].join("\n"),
          },
        },
      });
      expect(
        await pulumi.resolve([
          database.host,
          database.reader,
          database.port,
          database.username,
          database.password,
          database.database,
          database.id,
          database.clusterArn,
          database.secretArn,
        ]),
      ).toEqual([
        "127.0.0.1",
        "127.0.0.1",
        5432,
        "admin",
        "local",
        "acme",
        "placeholder",
        "placeholder",
        "placeholder",
      ]);
    });

    it("uses the engine's port and username", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "mysql",
        vpc,
        password: "top-level",
        dev: {},
      });
      await pulumi.settle();

      expect(
        await pulumi.resolve([
          database.host,
          database.port,
          database.username,
          database.password,
        ]),
      ).toEqual(["localhost", 3306, "root", "top-level"]);
    });

    it("links without any permissions", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect((database as any).getSSTLink().include).toEqual([]);
    });

    it("says there's no password in its pane, given an empty one", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "mysql",
        vpc,
        dev: { password: output("") },
      });
      await pulumi.settle();

      expect(
        pulumi.reportOf("MyDatabase")?.dev.environment.SST_DEV_COMMAND_MESSAGE,
      ).toContain('password: "\x1b[38;5;8m[no password]\x1b[0m"');
      expect(await pulumi.resolve(database.password)).toBe("");
    });

    // The core reads it decrypted, as it read SST 4's `DevCommand`
    it("keeps a secret password secret in the state", async () => {
      new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        dev: { password: secret("local") },
      });
      await pulumi.settle();

      const message =
        pulumi.reportOf("MyDatabase")?.dev.environment.SST_DEV_COMMAND_MESSAGE;
      expect(message).toMatchObject({
        "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270",
      });
      expect(message.value).toContain('password: "local"');
    });

    it("needs a password to connect with", () => {
      expect(
        () => new Aurora("MyDatabase", { engine: "postgres", vpc, dev: {} }),
      ).toThrow(
        `The "MyDatabase" Aurora database needs the password of your local server to connect to it in sst dev. Set "dev.password", or "password".`,
      );
    });

    it("needs dev as a plain value", () => {
      expect(
        () =>
          new Aurora("MyDatabase", {
            engine: "postgres",
            vpc,
            dev: output({}) as any,
          }),
      ).toThrow(
        /The "dev" of the "MyDatabase" Aurora database has to be a plain value/,
      );
    });

    it("explains why nodes are missing", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect(() => database.nodes.cluster).toThrow(
        /Cannot access `nodes.cluster` of "MyDatabase" in `sst dev`/,
      );
    });

    it("deploys the cluster when dev isn't set", async () => {
      new Aurora("MyDatabase", { engine: "postgres", vpc });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === CLUSTER)).toBe(true);
      expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
    });

    // `dev` says what `sst dev` connects to, whatever a deploy does
    it("connects to the local database in place of an existing one", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        existing: { cluster: "app-dev-mydatabase" },
        dev: { password: "local" },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Aurora"]);
      expect(await pulumi.resolve([database.host, database.password])).toEqual(
        ["localhost", "local"],
      );
    });
  });

  it("uses an existing cluster with dev args outside of sst dev", async () => {
    const database = new Aurora("MyDatabase", {
      engine: "postgres",
      vpc,
      existing: { cluster: "app-dev-mydatabase" },
      dev: { password: "local" },
    });
    await pulumi.settle();

    expect(resource("MyDatabaseCluster").kind).toBe("read");
    expect(await pulumi.resolve(database.host)).toBe(
      "MyDatabaseCluster.cluster.example.com",
    );
    expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
  });

  // 4.x asked for the password in `sst dev` alone
  it("deploys with dev args that have no password", async () => {
    new Aurora("MyDatabase", { engine: "postgres", vpc, dev: { port: 5433 } });
    await pulumi.settle();

    expect(pulumi.resources.some((r) => r.type === CLUSTER)).toBe(true);
    expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
  });

  describe("in a Vpc", () => {
    it("is in the private subnets and security groups of a Vpc", async () => {
      for (const [i, VpcClass] of [Vpc].entries()) {
        pulumi.reset();
        const net = new VpcClass(`Net${i}`);
        new Aurora("MyDatabase", { engine: "postgres", vpc: net, proxy: true });
        await pulumi.settle();

        const subnets = await pulumi.resolve(net.privateSubnets);
        expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual(
          subnets,
        );
        expect(resource("MyDatabaseProxy").inputs.vpcSubnetIds).toEqual(
          subnets,
        );
        expect(resource("MyDatabaseCluster").inputs.vpcSecurityGroupIds).toEqual(
          await pulumi.resolve(net.securityGroups),
        );
      }
    });

    it("turns down another resource in its place", async () => {
      const aws = await import("@pulumi/aws");
      const net = new aws.ec2.Vpc("Net", { cidrBlock: "10.0.0.0/16" });
      expect(
        () =>
          new Aurora("MyDatabase", { engine: "postgres", vpc: net as any }),
      ).toThrow(
        /The "vpc" of the "MyDatabase" Aurora database isn't a "Vpc" component/,
      );
      await pulumi.settle();
    });
  });

  it("creates a postgres cluster with its defaults", async () => {
    const database = new Aurora("MyDatabase", { engine: "postgres", vpc });
    await pulumi.settle();

    expect(resource("MyDatabaseCluster").inputs).toMatchObject({
      engine: "aurora-postgresql",
      engineMode: "provisioned",
      engineVersion: "17",
      databaseName: "app",
      masterUsername: "postgres",
      serverlessv2ScalingConfiguration: {
        maxCapacity: 4,
        minCapacity: 0,
        secondsUntilAutoPause: 300,
      },
      enableHttpEndpoint: false,
      storageEncrypted: true,
      vpcSecurityGroupIds: ["sg-1"],
      tags: { "sst:ref:password": "MyDatabaseSecret_id" },
    });
    expect(resource("MyDatabaseCluster").options.ignoreChanges).toContain(
      "engineVersion",
    );
    for (const group of ["InstanceParameterGroup", "ClusterParameterGroup"])
      expect(resource(`MyDatabase${group}`).inputs.family).toBe(
        "aurora-postgresql17",
      );
    expect(resource("MyDatabaseInstance").inputs).toMatchObject({
      clusterIdentifier: "MyDatabaseCluster_id",
      instanceClass: "db.serverless",
      autoMinorVersionUpgrade: false,
    });
    expect(
      await pulumi.resolve([
        database.host,
        database.reader,
        database.port,
        database.username,
        database.database,
      ]),
    ).toEqual([
      "MyDatabaseCluster.cluster.example.com",
      "MyDatabaseCluster.reader.example.com",
      5432,
      "postgres",
      "app",
    ]);
  });

  it("names a mysql cluster's version and family the way Aurora does", async () => {
    new Aurora("Latest", { engine: "mysql", vpc });
    new Aurora("Older", { engine: "mysql", vpc, version: "2.12.0" });
    await pulumi.settle();

    expect(resource("LatestCluster").inputs).toMatchObject({
      engine: "aurora-mysql",
      engineVersion: "8.0.mysql_aurora.3.08.0",
      masterUsername: "root",
    });
    expect(resource("LatestClusterParameterGroup").inputs.family).toBe(
      "aurora-mysql8.0",
    );
    expect(resource("OlderCluster").inputs.engineVersion).toBe(
      "5.7.mysql_aurora.2.12.0",
    );
    expect(resource("OlderInstanceParameterGroup").inputs.family).toBe(
      "aurora-mysql5.7",
    );
    // A version that's chosen is followed
    expect(resource("OlderCluster").options.ignoreChanges ?? []).not.toContain(
      "engineVersion",
    );
  });

  it("doesn't pause a cluster that can't scale down to nothing", async () => {
    new Aurora("MyDatabase", {
      engine: "postgres",
      vpc,
      scaling: { min: "1 ACU", max: "16 ACU" },
    });
    await pulumi.settle();

    expect(
      resource("MyDatabaseCluster").inputs.serverlessv2ScalingConfiguration,
    ).toEqual({ maxCapacity: 16, minCapacity: 1 });
  });

  it("applies the instance's transform to replicas, then the replica's own", async () => {
    new Aurora("MyDatabase", {
      engine: "postgres",
      vpc,
      replicas: 2,
      transform: {
        instance: { monitoringInterval: 60, promotionTier: 1 },
        replica: (args, _opts, _name, replica) => {
          if (replica === "1") args.monitoringInterval = 5;
        },
      },
    });
    await pulumi.settle();

    const instance = (name: string) => {
      const { monitoringInterval, promotionTier } = resource(name).inputs;
      return { monitoringInterval, promotionTier };
    };
    expect(instance("MyDatabaseInstance")).toEqual({
      monitoringInterval: 60,
      promotionTier: 1,
    });
    expect(instance("MyDatabaseReplica0")).toEqual({
      monitoringInterval: 60,
      promotionTier: 1,
    });
    expect(instance("MyDatabaseReplica1")).toEqual({
      monitoringInterval: 5,
      promotionTier: 1,
    });
  });

  // As in 4.x, a function there is given the component as the parent, for
  // the primary instance and for each replica
  it("gives the instance's transform function its parent", async () => {
    const parents: unknown[] = [];
    const database = new Aurora("MyDatabase", {
      engine: "postgres",
      vpc,
      replicas: 1,
      transform: { instance: (_args, opts) => void parents.push(opts.parent) },
    });
    await pulumi.settle();

    expect(parents).toEqual([database, database]);
  });

  it("makes replicas the last to be promoted", async () => {
    new Aurora("MyDatabase", { engine: "postgres", vpc, replicas: 1 });
    await pulumi.settle();

    expect(resource("MyDatabaseReplica0").inputs.promotionTier).toBe(15);
    expect(resource("MyDatabaseInstance").inputs.promotionTier).toBeUndefined();
  });

  it("exposes every resource on nodes", async () => {
    const database = new Aurora("MyDatabase", {
      engine: "postgres",
      vpc,
      replicas: 2,
      proxy: { credentials: [{ username: "metabase", password: "x" }] },
    });
    await pulumi.settle();

    expect(Object.keys(database.nodes)).toEqual([
      "secret",
      "password",
      "secretVersion",
      "subnetGroup",
      "instanceParameterGroup",
      "clusterParameterGroup",
      "cluster",
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
    expect(database.nodes.cluster.constructor.name).toBe("Cluster");
    expect(database.nodes.instance.constructor.name).toBe("ClusterInstance");
    expect(Object.keys(database.nodes.replica)).toEqual(["0", "1"]);
    expect(Object.keys(database.nodes.proxySecret)).toEqual(["metabase"]);
    expect(database.nodes.proxy!.constructor.name).toBe("Proxy");
  });

  it("connects through the proxy when there is one", async () => {
    const database = new Aurora("MyDatabase", {
      engine: "mysql",
      vpc,
      proxy: { credentials: [{ username: "metabase", password: "x" }] },
    });
    await pulumi.settle();

    expect(await pulumi.resolve(database.host)).toBe(
      "MyDatabaseProxy.proxy.example.com",
    );
    expect(resource("MyDatabaseProxy").inputs).toMatchObject({
      engineFamily: "MYSQL",
      auths: [
        { secretArn: "arn:aws:mock:us-east-1:123456789012:MyDatabaseSecret" },
        {
          secretArn:
            "arn:aws:mock:us-east-1:123456789012:MyDatabaseProxySecretMetabase",
        },
      ],
    });
    // A cluster that references this one finds the proxy from this tag
    expect(resource("MyDatabaseCluster").inputs.tags).toEqual({
      "sst:ref:password": "MyDatabaseSecret_id",
      "sst:ref:proxy": "MyDatabaseProxy_id",
    });
    expect(resource("MyDatabaseProxyTarget").inputs.dbClusterIdentifier).toBe(
      resource("MyDatabaseCluster").inputs.clusterIdentifier,
    );
    // A proxy has no reader endpoint to link
    expect(
      await pulumi.resolve((database as any).getSSTLink().properties.reader),
    ).toBeUndefined();
  });

  describe("a cluster that's already deployed", () => {
    it("is found with its instance, secret and password", async () => {
      const database = Aurora.get("MyDatabase", "app-dev-mydatabase");
      await pulumi.settle();

      expect(
        pulumi.resources
          .filter((r) => r.kind === "read")
          .map((r) => [r.name, r.options.id])
          .sort(),
      ).toEqual([
        ["MyDatabaseCluster", "app-dev-mydatabase"],
        ["MyDatabaseInstance", "shared-instance-1"],
        ["MyDatabaseSecret", "shared-secret"],
      ]);
      expect(pulumi.resources.filter((r) => r.kind === "register")).toHaveLength(1);
      expect(
        await pulumi.resolve([
          database.id,
          database.host,
          database.reader,
          database.port,
          database.username,
          database.password,
          database.database,
          database.secretArn,
        ]),
      ).toEqual([
        "app-dev-mydatabase",
        "MyDatabaseCluster.cluster.example.com",
        "MyDatabaseCluster.reader.example.com",
        5432,
        "postgres",
        "stored-password",
        "shared",
        "arn:aws:mock:us-east-1:123456789012:MyDatabaseSecret",
      ]);
    });

    it("is connected to through its proxy when it has one", async () => {
      const database = Aurora.get("MyDatabase", "app-dev-proxied");
      await pulumi.settle();

      expect(resource("MyDatabaseProxy")).toMatchObject({
        kind: "read",
        options: { id: "shared-proxy" },
      });
      expect(database.nodes.proxy!.constructor.name).toBe("Proxy");
      expect(await pulumi.resolve(database.host)).toBe(
        "MyDatabaseProxy.proxy.example.com",
      );
    });

    it("reads its password from the secret it's given", async () => {
      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        existing: { cluster: "app-dev-mydatabase", secret: "my-secret" },
      });
      await pulumi.settle();

      expect(resource("MyDatabaseSecret")).toMatchObject({
        kind: "read",
        options: { id: "my-secret" },
      });
      expect(await pulumi.resolve(database.password)).toBe(
        "the password in my-secret",
      );
    });

    it("turns down what it would create next to it", () => {
      for (const part of [
        "subnetGroup",
        "instanceParameterGroup",
        "clusterParameterGroup",
        "secretVersion",
        "proxyRole",
      ])
        expect(
          () =>
            new Aurora(`Database${part}`, {
              engine: "postgres",
              vpc,
              existing: { cluster: "app-dev-mydatabase", [part]: "x" },
            }),
        ).toThrow(
          `"existing.${part}" isn't an option for the "Database${part}" Aurora database. It's given an existing "cluster", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
        );
    });

    it("says what it can't find without the tag that names its secret", async () => {
      const errors = await applyErrors(
        () => Aurora.get("MyDatabase", "app-dev-untagged"),
        pulumi.settle,
      );
      expect(errors).toContain(
        `The "MyDatabase" Aurora database can't find its secret: its cluster has no "sst:ref:password" tag, which names the secret that holds its password. Pass the secret in "existing.secret".`,
      );
    });

    it("can be passed as resources, with its password", async () => {
      const { rds, secretsmanager } = await import("@pulumi/aws");
      const cluster = new rds.Cluster("Mine", {
        engine: "aurora-postgresql",
        masterUsername: "owner",
        databaseName: "mine",
      });
      const instance = new rds.ClusterInstance("MineInstance", {
        clusterIdentifier: cluster.id,
        engine: "aurora-postgresql",
        instanceClass: "db.serverless",
      });
      const secret = new secretsmanager.Secret("MineSecret", {});
      await pulumi.settle();
      pulumi.reset();

      const database = new Aurora("MyDatabase", {
        engine: "postgres",
        vpc,
        password: "known",
        existing: { cluster, instance, secret },
      });
      await pulumi.settle();

      expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:aws:Aurora"]);
      expect(database.nodes.cluster).toBe(cluster);
      expect(
        await pulumi.resolve([
          database.host,
          database.username,
          database.password,
          database.database,
          database.secretArn,
        ]),
      ).toEqual([
        "Mine.cluster.example.com",
        "owner",
        "known",
        "mine",
        "arn:aws:mock:us-east-1:123456789012:MineSecret",
      ]);
    });
  });

  it("links with the connection details and access to the Data API", async () => {
    const { Link } = await import("../../../src/components/link");
    const database = new Aurora("MyDatabase", { engine: "postgres", vpc });
    await pulumi.settle();

    expect(Link.isLinkable(database)).toBe(true);
    const link = (database as any).getSSTLink();
    expect(Object.keys(link.properties)).toEqual([
      "clusterArn",
      "secretArn",
      "database",
      "username",
      "password",
      "port",
      "host",
      "reader",
    ]);
    expect(await pulumi.resolve(link.properties.reader)).toBe(
      "MyDatabaseCluster.reader.example.com",
    );
    expect(await pulumi.resolve(link.include)).toMatchObject([
      {
        type: "aws.permission",
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["arn:aws:mock:us-east-1:123456789012:MyDatabaseSecret"],
      },
      {
        type: "aws.permission",
        actions: [
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:ExecuteStatement",
          "rds-data:RollbackTransaction",
        ],
        resources: ["arn:aws:mock:us-east-1:123456789012:MyDatabaseCluster"],
      },
    ]);
  });

  it("says what has to be a plain value, and how many replicas there can be", () => {
    const create = (name: string, args: object) => () =>
      new Aurora(name, { engine: "postgres", vpc, ...args } as any);

    expect(create("First", { proxy: output(true) })).toThrow(
      /The "proxy" of the "First" Aurora database has to be a plain value/,
    );
    expect(create("Second", { replicas: output(2) })).toThrow(
      /The "replicas" of the "Second" Aurora database has to be a plain value/,
    );
    expect(
      create("Third", {
        proxy: { credentials: [{ username: output("metabase"), password: "x" }] },
      }),
    ).toThrow(
      /The "username" in the "proxy.credentials" of the "Third" Aurora database/,
    );
    expect(create("Fourth", { replicas: 16 })).toThrow(
      `The "replicas" of the "Fourth" Aurora database is 16. It can have 15 read-only replicas at most.`,
    );
  });
});
