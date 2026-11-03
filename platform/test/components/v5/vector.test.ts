import fs from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

const CLUSTER = "aws:rds/cluster:Cluster";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds";

const pulumi = mockPulumi({
  state: (args) =>
    args.type === CLUSTER
      ? {
          masterUserSecrets: [{ secretArn: SECRET_ARN }],
          // A cluster that's looked up has the ARN of the one it finds, by
          // its id, whatever it's called in the app
          ...(args.id
            ? { arn: `arn:aws:rds:us-east-1:123456789012:cluster:${args.id}` }
            : {}),
        }
      : {},
  call: (args) =>
    args.token === "aws:rds/getInstances:getInstances"
      ? { instanceIdentifiers: ["my-instance"] }
      : args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
        ? { names: ["us-east-1a", "us-east-1b"] }
        : undefined,
});

// The handlers' bundle, which the CLI ships in the platform
// @ts-ignore
const bundle = path.join($cli.paths.platform, "dist", "vector-handler");
fs.mkdirSync(bundle, { recursive: true });
fs.writeFileSync(path.join(bundle, "index.mjs"), "export const query = 1;\n");

type VectorClass =
  | typeof import("../../../src/components/aws/vector").Vector
  | typeof import("../../../src/components/aws/v5/vector").Vector;

describe("Vector", () => {
  let Original: typeof import("../../../src/components/aws/vector").Vector;
  let Vector: typeof import("../../../src/components/aws/v5/vector").Vector;
  let OriginalVpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Vpc: typeof import("../../../src/components/aws/v5/vpc").Vpc;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/vector")).Vector;
    Vector = (await import("../../../src/components/aws/v5/vector")).Vector;
    OriginalVpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Vpc = (await import("../../../src/components/aws/v5/vpc")).Vpc;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const ofType = (type: string) =>
    pulumi.resources.filter((r) => r.type === type);
  const ids = {
    privateSubnets: ["subnet-1", "subnet-2"],
    securityGroups: ["sg-1"],
  };

  // Each case deploys the 4.x Vector, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. Its database moves out of the `Postgres` it was in.
  describe("takes over a deployed Vector", () => {
    pulumi.takeoverCases<VectorClass, VectorClass>({
      original: () => Original,
      v5: () => Vector,
      // The `Postgres` the 4.x one kept its database in
      unclaimed: ["sst:aws:Postgres::MyVectorDBDatabase"],
      cases: {
        "a vector database": (Vector, opts) => {
          new Vector("MyVectorDB", { dimension: 1536 }, opts);
        },
        "in a VPC, by its ids": {
          original: (opts) =>
            new Original(
              "MyVectorDB",
              { dimension: 1536, transform: { postgres: { vpc: ids } } },
              opts,
            ),
          v5: (opts) =>
            new Vector("MyVectorDB", { dimension: 1536, vpc: ids }, opts),
          check: () =>
            expect(resource("MyVectorDBSubnetGroup").inputs.subnetIds).toEqual(
              ids.privateSubnets,
            ),
        },
        "in a Vpc": {
          original: (opts) =>
            new Original(
              "MyVectorDB",
              {
                dimension: 1536,
                transform: { postgres: { vpc: new OriginalVpc("MyVpc") } },
              },
              opts,
            ),
          v5: (opts) =>
            new Vector(
              "MyVectorDB",
              { dimension: 1536, vpc: new OriginalVpc("MyVpc") },
              opts,
            ),
        },
        "its database transformed": {
          original: (opts) =>
            new Original(
              "MyVectorDB",
              {
                dimension: 768,
                transform: {
                  postgres: {
                    transform: {
                      cluster: { backupRetentionPeriod: 7 },
                      instance: { performanceInsightsEnabled: true },
                    },
                  },
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Vector(
              "MyVectorDB",
              {
                dimension: 768,
                transform: {
                  cluster: { backupRetentionPeriod: 7 },
                  instance: { performanceInsightsEnabled: true },
                },
              },
              opts,
            ),
        },
        // What SST 4 only took through its Postgres, the V5 one takes as
        // args of its own
        "its database's settings": {
          original: (opts) =>
            new Original(
              "MyVectorDB",
              {
                dimension: 1536,
                transform: {
                  postgres: {
                    version: "16.4",
                    scaling: { min: "1 ACU", max: "8 ACU" },
                    databaseName: "vectors",
                  },
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Vector(
              "MyVectorDB",
              {
                dimension: 1536,
                version: "16.4",
                scaling: { min: "1 ACU", max: "8 ACU" },
                databaseName: "vectors",
              },
              opts,
            ),
          check: () =>
            expect(
              resource("MyVectorDBCluster").options.ignoreChanges ?? [],
            ).not.toContain("engineVersion"),
        },
        // The options a function in SST 4's transform set on its Postgres,
        // which the database's resources took from it
        "its database protected": {
          original: (opts) =>
            new Original(
              "MyVectorDB",
              {
                dimension: 1536,
                transform: {
                  postgres: (_args: any, opts: any) => {
                    opts.protect = true;
                  },
                },
              },
              opts,
            ),
          v5: (opts) => {
            const protect = (_args: unknown, opts: { protect?: boolean }) => {
              opts.protect = true;
              return undefined;
            };
            return new Vector(
              "MyVectorDB",
              {
                dimension: 1536,
                transform: { cluster: protect, instance: protect },
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MyVectorDBCluster").options.protect).toBe(true),
        },
        "linked by a function": async (Vector, opts) => {
          const { Function } = await import(
            "../../../src/components/aws/function"
          );
          const vector = new Vector("MyVectorDB", { dimension: 1536 }, opts);
          new Function("MyCaller", {
            handler: "src/caller.handler",
            link: [vector],
          });
        },
        "in sst dev": (Vector, opts) => {
          // @ts-ignore
          global.$dev = true;
          new Vector("MyVectorDB", { dimension: 1536 }, opts);
        },
      },
    });
  });

  // 4.x looked the database up in a `Postgres` at the top of the app, with
  // lookups that took no parent, and its `get` took no options. The V5 one
  // looks it up inside itself. A lookup changes nothing in AWS.
  it("takes over one from get", async () => {
    const result = await pulumi.takesOver(
      () => Original.get("MyVectorDB", "my-cluster"),
      () => Vector.get("MyVectorDB", "my-cluster"),
    );
    expect(result.changed).toEqual([]);
    expect([...result.unclaimed].sort()).toEqual([
      "aws:rds/cluster:Cluster::MyVectorDBDatabaseCluster",
      "aws:rds/clusterInstance:ClusterInstance::MyVectorDBDatabaseInstance",
      "sst:aws:Postgres::MyVectorDBDatabase",
    ]);
  });

  it("creates the database as SST 4 did, with its table and functions", async () => {
    new Vector("MyVectorDB", { dimension: 1536 });
    await pulumi.settle();

    expect(resource("MyVectorDBCluster").inputs).toMatchObject({
      engine: "aurora-postgresql",
      engineMode: "provisioned",
      engineVersion: "17",
      databaseName: "app",
      masterUsername: "postgres",
      manageMasterUserPassword: true,
      serverlessv2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 4 },
      enableHttpEndpoint: true,
      skipFinalSnapshot: true,
    });
    expect(resource("MyVectorDBCluster").options.ignoreChanges).toContain(
      "engineVersion",
    );
    expect(resource("MyVectorDBInstance").inputs).toMatchObject({
      clusterIdentifier: "MyVectorDBCluster_id",
      instanceClass: "db.serverless",
    });
    expect(resource("MyVectorDBSubnetGroup")).toBeUndefined();

    const table = resource("MyVectorDBTable.sst.aws.VectorTable");
    expect(table.inputs).toMatchObject({
      secretArn: SECRET_ARN,
      databaseName: "app",
      tableName: "embeddings",
      dimension: 1536,
    });
    expect(pulumi.dependsOn(table.name, "MyVectorDBInstance")).toBe(true);

    const fn = resource("MyVectorDBQueryFunction").inputs;
    // The mock's build names the file `bundle`
    expect(fn.handler).toMatch(/\.query$/);
    expect(fn.environment.variables).toMatchObject({
      SECRET_ARN: SECRET_ARN,
      DATABASE_NAME: "app",
      TABLE_NAME: "embeddings",
    });
  });

  // SST 4 replaced a nested object of a transform whole
  it("keeps the capacity it sets next to one set with an object transform", async () => {
    new Vector("MyVectorDB", {
      dimension: 1536,
      transform: {
        cluster: { serverlessv2ScalingConfiguration: { maxCapacity: 8 } },
      },
    });
    await pulumi.settle();
    expect(
      resource("MyVectorDBCluster").inputs.serverlessv2ScalingConfiguration,
    ).toEqual({ minCapacity: 0.5, maxCapacity: 8 });
  });

  it("has every part in nodes", async () => {
    const vector = new Vector("MyVectorDB", { dimension: 1536, vpc: ids });
    await pulumi.settle();
    expect(Object.keys(vector.nodes).sort()).toEqual([
      "cluster",
      "instance",
      "put",
      "query",
      "remove",
      "subnetGroup",
      "table",
    ]);
    expect(await pulumi.resolve(vector.clusterID)).toBe("MyVectorDBCluster_id");
  });

  it("links what the SDK invokes, and lets it invoke them", async () => {
    const vector = new Vector("MyVectorDB", { dimension: 1536 });
    const link = vector.link();
    expect(Object.keys(await pulumi.resolve(link.properties))).toEqual([
      "queryFunction",
      "putFunction",
      "removeFunction",
    ]);
    const { query, put, remove } = vector.nodes;
    expect(await pulumi.resolve(link.properties)).toEqual(
      await pulumi.resolve({
        queryFunction: query.name,
        putFunction: put.name,
        removeFunction: remove.name,
      }),
    );
    const [allowed] = await pulumi.resolve(link.include);
    expect(allowed.actions).toEqual(["lambda:InvokeFunction"]);
    expect(allowed.resources).toEqual(
      await pulumi.resolve([
        query.nodes.function.arn,
        put.nodes.function.arn,
        remove.nodes.function.arn,
      ]),
    );
  });

  it("puts the database in either kind of Vpc", async () => {
    for (const vpc of [
      () => new OriginalVpc("MyVpc"),
      () => new Vpc("MyVpc"),
    ]) {
      pulumi.reset();
      new Vector("MyVectorDB", { dimension: 1536, vpc: vpc() });
      await pulumi.settle();
      expect(resource("MyVectorDBSubnetGroup").inputs.subnetIds).toEqual([
        "MyVpcPrivateSubnet1_id",
        "MyVpcPrivateSubnet2_id",
      ]);
      expect(resource("MyVectorDBCluster").inputs).toMatchObject({
        dbSubnetGroupName: expect.any(String),
        vpcSecurityGroupIds: ["MyVpcSecurityGroup_id"],
      });
    }
  });

  it("refuses another resource as the ids of a VPC", async () => {
    const { ec2 } = await import("@pulumi/aws");
    expect(
      () =>
        new Vector("MyVectorDB", {
          dimension: 1536,
          vpc: new ec2.Vpc("Other", { cidrBlock: "10.0.0.0/16" }) as any,
        }),
    ).toThrow(/The "vpc" of the "MyVectorDB" vector database isn't a "Vpc"/);
    await pulumi.settle();
  });

  it("says where SST 4's transform of its Postgres goes", () => {
    expect(
      () =>
        new Vector("MyVectorDB", {
          dimension: 1536,
          transform: { postgres: { vpc: ids } },
        } as any),
    ).toThrow(
      /"postgres" isn't an option here\. The "MyVectorDB" vector database has no Postgres component\. Set its "vpc", "version", "scaling" and "databaseName" on the vector itself/,
    );
    expect(
      () =>
        new Vector("MyVectorDB", { dimension: 1536, vpc: "default" } as any),
    ).toThrow(/is "default"\. Leave "vpc" out to use the default VPC/);
  });

  it("uses the database it's given, and creates no table", async () => {
    const vector = Vector.get("MyVectorDB", "my-cluster");
    await pulumi.settle();
    expect(ofType(CLUSTER).map((r) => [r.kind, r.options.id])).toEqual([
      ["read", "my-cluster"],
    ]);
    expect(resource("MyVectorDBInstance").kind).toBe("read");
    expect(resource("MyVectorDBTable.sst.aws.VectorTable")).toBeUndefined();
    expect(vector.nodes.table).toBeUndefined();
    expect(
      resource("MyVectorDBQueryFunction").inputs.environment.variables
        .SECRET_ARN,
    ).toBe(SECRET_ARN);
  });
});
