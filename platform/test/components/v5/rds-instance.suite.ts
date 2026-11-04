import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output, secret } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import { applyErrors } from "../../helpers/apply-errors";

// The tests every database on an RDS instance passes, the `Postgres` and the
// `Mysql` (`helpers/rds-instance.ts`), run by each engine's test file with
// what's its own. Inside, the V5 component is called `Postgres` and its 4.x
// form `OriginalPostgres` whatever the engine: the two have the same shape.

type V5Class =
  typeof import("../../../src/components/aws/v5/postgres").Postgres;
type OriginalClass =
  typeof import("../../../src/components/aws/postgres").Postgres;
type AnyClass = V5Class | OriginalClass;

/** One engine, as the shared tests see it: what differs from the other. */
export interface RdsInstanceCase {
  /** The component's name, as in its type, `sst:aws:Postgres`. */
  name: string;
  /** What its messages call the database: "Postgres", "MySQL". */
  label: string;
  /** What its pane in `sst dev` calls the local server. */
  server: string;
  /** What RDS calls the engine. */
  engine: string;
  /** The 4.x and V5 components, with the V5 one's takeover map loaded. */
  load(): Promise<{ original: OriginalClass; v5: V5Class }>;
  /** Whether the 4.x component leaves a version marker in the state. */
  versionMarker: boolean;
  /** The port it's deployed on, and one a local server is on. */
  port: number;
  devPort: number;
  /** The master user by default. */
  username: string;
  /** The tags the 4.x component writes, which the V5 one keeps. */
  tags: { version: string; password: string };
  /** Versions the cases deploy: with every setting, as an output, with replicas. */
  versions: { every: string; output: string; replica: string };
  defaults: { version: string; family: string; performanceInsights: boolean };
  /** A version chosen, and the parameter group's family for it. */
  chosen: { version: string; family: string };
}

const INSTANCE = "aws:rds/instance:Instance";
const PROXY = "aws:rds/proxy:Proxy";

/**
 * The tests every database on an RDS instance passes.
 *
 * @param more The engine's own tests, given what the shared ones use.
 */
export function rdsInstanceSuite(
  e: RdsInstanceCase,
  more?: (context: {
    pulumi: ReturnType<typeof mockPulumi>;
    vpc: { subnets: string[] };
    component: () => V5Class;
    resource: (name: string) => any;
  }) => void,
) {
  const marker = e.versionMarker ? ["sst:sst:Version::MyDatabaseVersion"] : [];

  const pulumi = mockPulumi({
    state: (args) => {
      if (args.type === PROXY)
        return { endpoint: `${args.name}.proxy.example.com` };
      if (args.type !== INSTANCE) return {};
      // A database that's looked up has what it was created with
      if (args.id)
        return {
          identifier: args.id,
          endpoint: `shared.db.example.com:${e.port}`,
          port: e.port,
          username: e.username,
          dbName: "shared",
          tagsAll: {
            "sst:component-version": e.tags.version,
            [e.tags.password]: "secret-id",
          },
        };
      return {
        endpoint: `${args.name}.db.example.com:${e.port}`,
        port: e.port,
      };
    },
    call: (args) => {
      // The password in the secret a database is tagged with, or in another
      if (args.token === "aws:secretsmanager/getSecretVersion:getSecretVersion")
        return {
          secretString: JSON.stringify({
            username: e.username,
            password:
              args.inputs.secretId === "secret-id"
                ? "stored-password"
                : `the password in ${args.inputs.secretId}`,
          }),
        };
      if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
        return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
      return undefined;
    },
  });

  const vpc = { subnets: ["subnet-1", "subnet-2"] };

  describe(e.name, () => {
    let OriginalPostgres: OriginalClass;
    let Postgres: V5Class;
    let OriginalVpc: typeof import("../../../src/components/aws/vpc").Vpc;
    let Vpc: typeof import("../../../src/components/aws/v5/vpc").Vpc;

    beforeAll(async () => {
      OriginalVpc = (await import("../../../src/components/aws/vpc")).Vpc;
      Vpc = (await import("../../../src/components/aws/v5/vpc")).Vpc;
      ({ original: OriginalPostgres, v5: Postgres } = await e.load());
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

    // Each case deploys the 4.x component, then the same thing as the V5 one.
    // Everything the 4.x one created has to be kept by the V5 one, with the same
    // inputs: a database that's replaced loses its data. The one thing that goes
    // is the version marker the 4.x component writes, if it does, which has nothing in AWS
    // behind it.
    describe(`takes over a deployed ${e.name}`, () => {
      pulumi.takeoverCases({
        original: () => OriginalPostgres,
        v5: () => Postgres,
        unclaimed: marker,
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
                version: e.versions.every,
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
                version: output(e.versions.output),
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
              { vpc, replicas: 1, version: e.versions.replica },
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
          // The 4.x component created a component for the pane `sst dev` shows
          // in every deploy. The V5 one reports the pane in `sst dev` alone.
          "dev args outside of sst dev": {
            create: (Postgres, opts) => {
              new Postgres(
                "MyDatabase",
                {
                  vpc,
                  dev: {
                    username: e.username,
                    password: "password",
                    port: e.devPort,
                  },
                },
                opts,
              );
            },
            unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", ...marker],
            check: () => expect(pulumi.reportOf("MyDatabase")).toBeUndefined(),
          },
          "dev args in sst dev": {
            create: (Postgres, opts) => {
              // @ts-ignore
              global.$dev = true;
              new Postgres(
                "MyDatabase",
                { vpc, dev: { password: "password", port: e.devPort } },
                opts,
              );
            },
            unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", ...marker],
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
            unclaimed: ["sst:sst:DevCommand::MyDatabaseDev", ...marker],
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
              expect(
                resource("MyDatabaseSubnetGroup").inputs.subnetIds,
              ).toEqual(["MyVpcPrivateSubnet1_id", "MyVpcPrivateSubnet2_id"]),
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
            unclaimed: [...marker, "sst:sst:Version::MyVpcVersion"],
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
                "sst:component-version": e.tags.version,
                [e.tags.password]: "MyDatabaseSecret_id",
              }),
          },
        },
      });

      it("keeps the secrets under their new names", async () => {
        const create = (Postgres: AnyClass) =>
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
        await pulumi.asMove(original, async () => {
          create(Postgres);
          await pulumi.settle();
        });
        expect(names()).toEqual(
          expect.arrayContaining([
            "MyDatabaseSecret",
            "MyDatabaseSecretVersion",
            "MyDatabaseProxySecretMetabase",
            "MyDatabaseProxySecretVersionMetabase",
          ]),
        );
        expect(pulumi.takeover(original)).toEqual({
          unclaimed: marker,
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
          dev: { host: "127.0.0.1", port: e.devPort, password: "local" },
        });
        await pulumi.settle();

        expect(pulumi.resources.map((r) => r.type)).toEqual([
          `sst:aws:${e.name}`,
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
          e.devPort,
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
                `Make sure your local ${e.server} is using:`,
                "",
                '  username: "admin"',
                '  password: "local"',
                '  database: "acme"',
                "",
                `Listening on "127.0.0.1:${e.devPort}"...`,
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
          pulumi.reportOf("MyDatabase")?.dev.environment
            .SST_DEV_COMMAND_MESSAGE,
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
        ).toEqual(["localhost", e.port, "local-user", "top-level", "local"]);
      });

      // The core reads it decrypted, as it read SST 4's `DevCommand`
      it("keeps a secret password secret in the state", async () => {
        new Postgres("MyDatabase", { vpc, dev: { password: secret("local") } });
        await pulumi.settle();

        const message =
          pulumi.reportOf("MyDatabase")?.dev.environment
            .SST_DEV_COMMAND_MESSAGE;
        expect(message).toMatchObject({
          "4dabf18193072939515e22adb298388d":
            "1b47061264138c4ac30d75fd1eb44270",
        });
        expect(message.value).toContain('password: "local"');
      });

      it("needs a password to connect with", () => {
        expect(() => new Postgres("MyDatabase", { vpc, dev: {} })).toThrow(
          `The "MyDatabase" ${e.label} database needs the password of your local server to connect to it in sst dev. Set "dev.password", or "password".`,
        );
      });

      // An output that resolves to nothing is as good as leaving it out
      it("falls back for dev values that are outputs of nothing", async () => {
        const database = new Postgres("MyDatabase", {
          vpc,
          password: "top-level",
          dev: {
            host: output(undefined as unknown as string),
            port: output(undefined as unknown as number),
            username: output(""),
            password: output(undefined as unknown as string),
          },
        });
        await pulumi.settle();

        expect(
          await pulumi.resolve([
            database.host,
            database.port,
            database.username,
            database.password,
          ]),
        ).toEqual(["localhost", e.port, e.username, "top-level"]);
        expect(
          pulumi.reportOf("MyDatabase")?.dev.environment
            .SST_DEV_COMMAND_MESSAGE,
        ).toContain(`Listening on "localhost:${e.port}"`);
      });

      it("needs dev as a plain value", () => {
        expect(
          () => new Postgres("MyDatabase", { vpc, dev: output({}) as any }),
        ).toThrow(
          `The "dev" of the "MyDatabase" ${e.label} database has to be a plain value`,
        );
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

        expect(pulumi.resources.map((r) => r.type)).toEqual([
          `sst:aws:${e.name}`,
        ]);
        expect(
          await pulumi.resolve([database.host, database.password]),
        ).toEqual(["localhost", "local"]);
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
      new Postgres("MyDatabase", { vpc, dev: { port: e.devPort } });
      await pulumi.settle();

      expect(pulumi.resources.some((r) => r.type === INSTANCE)).toBe(true);
      expect(pulumi.reportOf("MyDatabase")).toBeUndefined();
    });

    it("creates the database with its defaults", async () => {
      const database = new Postgres("MyDatabase", { vpc });
      await pulumi.settle();

      expect(resource("MyDatabaseInstance").inputs).toMatchObject({
        dbName: "app",
        engine: e.engine,
        engineVersion: e.defaults.version,
        instanceClass: "db.t4g.micro",
        username: e.username,
        allocatedStorage: 20,
        maxAllocatedStorage: 20,
        multiAz: false,
        storageEncrypted: true,
        storageType: "gp3",
        backupRetentionPeriod: 7,
        performanceInsightsEnabled: e.defaults.performanceInsights,
        blueGreenUpdate: { enabled: false },
        tags: {
          "sst:component-version": e.tags.version,
          [e.tags.password]: "MyDatabaseSecret_id",
        },
      });
      expect(resource("MyDatabaseInstance").options).toMatchObject({
        deleteBeforeReplace: true,
        ignoreChanges: expect.arrayContaining(["engineVersion"]),
      });
      expect(resource("MyDatabaseParameterGroup").inputs.family).toBe(
        e.defaults.family,
      );
      expect(resource("MyDatabaseSubnetGroup").inputs.subnetIds).toEqual(
        vpc.subnets,
      );
      expect(
        await pulumi.resolve([database.host, database.port, database.database]),
      ).toEqual(["MyDatabaseInstance.db.example.com", e.port, "app"]);
    });

    it("follows the engine version once one is chosen", async () => {
      new Postgres("MyDatabase", {
        vpc,
        version: e.chosen.version,
        replicas: 1,
      });
      await pulumi.settle();

      for (const name of ["MyDatabaseInstance", "MyDatabaseReplica0"])
        expect(resource(name).options.ignoreChanges ?? []).not.toContain(
          "engineVersion",
        );
      expect(
        resource("MyDatabaseParameterGroup").options.ignoreChanges ?? [],
      ).not.toContain("family");
      expect(resource("MyDatabaseParameterGroup").inputs.family).toBe(
        e.chosen.family,
      );
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
      ).toEqual({ username: e.username, password: "Passw0rd!" });
    });

    it("exposes every resource on nodes", async () => {
      const database = new Postgres("MyDatabase", {
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
      expect(
        resource("MyDatabaseProxyTarget").inputs.dbInstanceIdentifier,
      ).toBe(resource("MyDatabaseInstance").inputs.identifier);
    });

    it("says there is no proxy when its id is read", async () => {
      const database = new Postgres("MyDatabase", { vpc });
      await pulumi.settle();

      expect(database.nodes.proxy).toBeUndefined();
      expect(() => database.proxyId).toThrow(
        `The "MyDatabase" ${e.label} database has no proxy, so it has no "proxyId". Enable one with "proxy: true", or give "get" the "proxyId" of the one it has.`,
      );
    });

    it(`transforms the parts ${e.name} had no transform for`, async () => {
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
        const database = Postgres.get("MyDatabase", {
          id: "app-dev-mydatabase",
        });
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
          e.port,
          e.username,
          "stored-password",
          "shared",
        ]);
        expect(() => database.proxyId).toThrow(/has no proxy/);
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
        expect(await pulumi.resolve([database.host, database.proxyId])).toEqual(
          ["MyDatabaseProxy.proxy.example.com", "app-dev-mydatabase-proxy"],
        );
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
        expect(pulumi.resources.map((r) => r.type)).toEqual([
          `sst:aws:${e.name}`,
        ]);
        expect(
          await pulumi.resolve([
            database.host,
            database.username,
            database.password,
            database.database,
          ]),
        ).toEqual(["Mine.db.example.com", "owner", "known", "mine"]);
      });

      it("reads its password from the secret it's given", async () => {
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
          existing: { instance: mine, secret: "my-secret" },
        });
        await pulumi.settle();

        expect(resource("MyDatabaseSecret")).toMatchObject({
          kind: "read",
          options: { id: "my-secret" },
        });
        expect(database.nodes.secret).toBeDefined();
        expect(await pulumi.resolve(database.password)).toBe(
          "the password in my-secret",
        );
      });

      it("says what it can't find without the tag that names its secret", async () => {
        const { rds } = await import("@pulumi/aws");
        const mine = new rds.Instance("Mine", {
          instanceClass: "db.t4g.micro",
          username: "owner",
        });
        await pulumi.settle();
        pulumi.reset();

        const errors = await applyErrors(
          () =>
            new Postgres("MyDatabase", { vpc, existing: { instance: mine } }),
          pulumi.settle,
        );
        expect(errors).toContain(
          `The "MyDatabase" ${e.label} database can't find its password: its instance has no "${e.tags.password}" tag, which names the secret that holds it. Pass the secret in "existing.secret", or set "password".`,
        );
      });

      it("turns down what it would create next to it", () => {
        for (const part of ["subnetGroup", "parameterGroup", "secretVersion"])
          expect(
            () =>
              new Postgres(`Database${part}`, {
                vpc,
                existing: { instance: "app-dev-mydatabase", [part]: "x" },
              }),
          ).toThrow(
            `"existing.${part}" isn't an option for the "Database${part}" ${e.label} database. It's given an existing "instance", which it uses the way it is, so it creates nothing this would stand in for. Remove it.`,
          );
        expect(
          () =>
            new Postgres("Replicas", {
              vpc,
              existing: {
                instance: "app-dev-mydatabase",
                replica: { "0": "x" },
              },
            }),
        ).toThrow(/"existing.replica" isn't an option/);
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
      ).toThrow(
        `The "proxy" of the "MyDatabase" ${e.label} database has to be a plain value`,
      );
      expect(
        () =>
          new Postgres("Second", {
            vpc,
            proxy: { credentials: output([]) as any },
          }),
      ).toThrow(
        `The "proxy.credentials" of the "Second" ${e.label} database has to be a plain value`,
      );
      expect(
        () =>
          new Postgres("Third", {
            vpc,
            proxy: {
              credentials: [
                { username: output("metabase") as any, password: "x" },
              ],
            },
          }),
      ).toThrow(
        `The "username" in the "proxy.credentials" of the "Third" ${e.label} database has to be a plain value`,
      );
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
          expect(
            () => new Postgres(`Database${i}`, { vpc: net as any }),
          ).toThrow(
            `The "vpc" of the "Database${i}" ${e.label} database isn't a "Vpc" component`,
          );
        await pulumi.settle();
      });
    });

    more?.({ pulumi, vpc, component: () => Postgres, resource });
  });
}
