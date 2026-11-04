import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const CLUSTER = "aws:dsql/cluster:Cluster";
const PEERING = "aws:dsql/clusterPeering:ClusterPeering";
const ENDPOINT = "aws:ec2/vpcEndpoint:VpcEndpoint";
const VAULT = "aws:backup/vault:Vault";

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === "aws:ec2/vpc:Vpc") return { cidrBlock: "10.0.0.0/16" };
    if (args.type === ENDPOINT)
      return {
        dnsEntries: [
          { dnsName: "vpce-1.dsql-fnh4.us-east-1.vpce.amazonaws.com" },
          { dnsName: "*.dsql-fnh4.us-east-1.on.aws" },
        ],
      };
    if (args.type !== CLUSTER) return {};
    // What's created with the peer region's provider is in that region
    const region = args.provider?.includes("us-east-2")
      ? "us-east-2"
      : "us-east-1";
    const identifier = (args.id || args.name).toLowerCase();
    return {
      identifier,
      region,
      arn: `arn:aws:dsql:${region}:123456789012:cluster/${identifier}`,
      vpcEndpointServiceName: `com.amazonaws.${region}.dsql-fnh4`,
    };
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b", "us-east-1c"] };
    return undefined;
  },
});

const regions = { witness: "us-west-2", peer: "us-east-2" };

type DsqlClass =
  | typeof import("../../../src/components/aws/dsql").Dsql
  | typeof import("../../../src/components/aws/v5/dsql").Dsql;

describe("Dsql", () => {
  let OriginalDsql: typeof import("../../../src/components/aws/dsql").Dsql;
  let Dsql: typeof import("../../../src/components/aws/v5/dsql").Dsql;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let VpcV5: typeof import("../../../src/components/aws/v5/vpc").Vpc;

  beforeAll(async () => {
    OriginalDsql = (await import("../../../src/components/aws/dsql")).Dsql;
    Dsql = (await import("../../../src/components/aws/v5/dsql")).Dsql;
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    VpcV5 = (await import("../../../src/components/aws/v5/vpc")).Vpc;
    await import("../../../src/components/aws/takeover/dsql");
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
  const created = (type: string) =>
    pulumi.resources.filter((r) => r.type === type).map((r) => r.name).sort();

  // Each case deploys the 4.x Dsql, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs: a cluster that's replaced loses its data.
  describe("takes over a deployed Dsql", () => {
    pulumi.takeoverCases({
      original: () => OriginalDsql,
      v5: () => Dsql,
      check: () => expect(resource("MyClusterCluster").type).toBe(CLUSTER),
      cases: {
        "single-region cluster": (Dsql, opts) => {
          new Dsql("MyCluster", {}, opts);
        },
        "multi-region cluster": (Dsql, opts) => {
          new Dsql("MyCluster", { regions }, opts);
        },
        "witness region given as an output": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              regions: { witness: output("us-west-2"), peer: "us-east-2" },
            },
            opts,
          );
        },
        "backups with the defaults": (Dsql, opts) => {
          new Dsql("MyCluster", { backup: true }, opts);
        },
        "backups with a schedule and retention": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              backup: { schedule: "cron(0 2 ? * * *)", retention: "90 days" },
            },
            opts,
          );
        },
        "backup settings given as outputs": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              backup: {
                schedule: output("cron(0 3 ? * MON *)"),
                retention: output("30 days" as const),
              },
            },
            opts,
          );
        },
        "backups left at an empty object": (Dsql, opts) => {
          new Dsql("MyCluster", { backup: {} }, opts);
        },
        "backups switched off": (Dsql, opts) => {
          new Dsql("MyCluster", { backup: false }, opts);
        },
        "multi-region cluster with backups": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            { regions, backup: { retention: "14 days" } },
            opts,
          );
        },
        transforms: (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              regions,
              backup: true,
              transform: {
                cluster: { deletionProtectionEnabled: true },
                peerCluster: (args, opts) => {
                  args.deletionProtectionEnabled = true;
                  opts.protect = true;
                },
                backupVault: { forceDestroy: true },
                backupPlan: (args) => {
                  args.tags = { team: "data" };
                },
                backupSelection: { name: "everything" },
              },
            },
            opts,
          );
        },
        // The 4.x Dsql applies the vault's transform to the peer region's vault
        // as well
        "a vault transform as a function": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              regions,
              backup: true,
              transform: {
                backupVault: (args, opts) => {
                  args.forceDestroy = true;
                  opts.retainOnDelete = true;
                },
              },
            },
            opts,
          );
        },
        "a security group with tags of its own is left as it is": (
          Dsql,
          opts,
        ) => {
          new Dsql(
            "MyCluster",
            {
              vpc: new Vpc("MyVpc"),
              transform: { endpointSecurityGroup: { tags: { team: "data" } } },
            },
            opts,
          );
        },
        // V5 merges an object transform into the defaults. 4.x replaced a
        // nested object whole, which dropped the witness region here.
        "an object transform that sets multi-region properties": {
          create: (Dsql, opts) => {
            new Dsql(
              "MyCluster",
              {
                regions,
                transform: {
                  cluster: {
                    multiRegionProperties: { clusters: ["arn:other"] },
                  },
                },
              },
              opts,
            );
          },
          changed: [["MyClusterCluster", ["multiRegionProperties"]]],
          check: () =>
            expect(
              resource("MyClusterCluster").inputs.multiRegionProperties,
            ).toEqual({ clusters: ["arn:other"], witnessRegion: "us-west-2" }),
        },
        // 4.x looks the clusters up beside the component. V5 looks them
        // up inside it, which this can't match: a lookup has no aliases.
        // Nothing is deployed for a lookup, so nothing is deleted.
        "a cluster referenced with get": {
          create: (Dsql, opts) =>
            Dsql.get("MyCluster", { id: "kzttrvbdg4k2o5ze2m2rrwdj7u" }, opts),
          unclaimed: [`${CLUSTER}::MyClusterCluster`],
          check: () => {
            expect(resource("MyClusterCluster")).toMatchObject({
              kind: "read",
              options: { id: "kzttrvbdg4k2o5ze2m2rrwdj7u" },
            });
            expect(created(CLUSTER)).toEqual(["MyClusterCluster"]);
          },
        },
        "a multi-region cluster referenced with get": {
          create: (Dsql, opts) =>
            Dsql.get(
              "MyCluster",
              {
                id: "app-dev-mycluster",
                peer: { id: "kzttrvbdg4k2o5ze2m2rrwdj7u", region: "us-east-2" },
              },
              opts,
            ),
          unclaimed: [
            `${CLUSTER}::MyClusterCluster`,
            `${CLUSTER}::MyClusterPeerCluster`,
          ],
          check: () => {
            expect(resource("MyClusterPeerCluster")).toMatchObject({
              kind: "read",
              options: {
                id: "kzttrvbdg4k2o5ze2m2rrwdj7u",
                provider: expect.stringMatching(
                  /::AwsProvider\.sst\.us-east-2::/,
                ),
              },
            });
            expect(created(PEERING)).toEqual([]);
          },
        },
      },
    });

    // A security group is named with a tag made from its logical name, so the
    // endpoints' keeps the name the 4.x `Dsql` gave it: its part is declared
    // with that name, which isn't its key.
    pulumi.takeoverCases({
      original: () => OriginalDsql,
      v5: () => Dsql,
      check: () =>
        expect(
          resource("MyClusterDsqlEndpointSecurityGroup").inputs.tags,
        ).toEqual({
          Name: expect.stringMatching(/MyClusterDsqlEndpointSecurityGroup$/),
        }),
      cases: {
        "a cluster in a Vpc": (Dsql, opts) => {
          new Dsql("MyCluster", { vpc: new Vpc("MyVpc") }, opts);
        },
        // How an app moves: the VPC goes to its 5.0 form along with the cluster
        "both endpoints, in a Vpc switched with it": {
          original: (opts) =>
            new OriginalDsql(
              "MyCluster",
              {
                vpc: {
                  instance: new Vpc("MyVpc"),
                  endpoints: { management: true, connection: true },
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Dsql(
              "MyCluster",
              {
                vpc: {
                  instance: new VpcV5("MyVpc"),
                  endpoints: { management: true, connection: true },
                },
              },
              opts,
            ),
          // The 4.x Vpc's version marker, with nothing in AWS behind it
          unclaimed: ["sst:sst:Version::MyVpcVersion"],
        },
        "both endpoints": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              vpc: {
                instance: new Vpc("MyVpc"),
                endpoints: { management: true, connection: true },
              },
            },
            opts,
          );
        },
        "only the management endpoint": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              vpc: {
                instance: new Vpc("MyVpc"),
                endpoints: { management: true, connection: false },
              },
            },
            opts,
          );
        },
        "neither endpoint": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              vpc: {
                instance: new Vpc("MyVpc"),
                endpoints: { management: false, connection: false },
              },
            },
            opts,
          );
        },
        "endpoint transforms": (Dsql, opts) => {
          new Dsql(
            "MyCluster",
            {
              vpc: {
                instance: new Vpc("MyVpc"),
                endpoints: { management: true },
              },
              backup: true,
              transform: {
                endpointSecurityGroup: { description: "custom" },
                managementEndpoint: { privateDnsEnabled: false },
                connectionEndpoint: (args, opts) => {
                  args.ipAddressType = "dualstack";
                  opts.protect = true;
                },
              },
            },
            opts,
          );
        },
      },
    });

    // The peer's resources are in the peer region whatever provider the
    // component is given
    it("keeps the peer region with another provider", async () => {
      const { Provider } = await import("@pulumi/aws");
      new Dsql(
        "MyCluster",
        { regions, backup: true },
        { provider: new Provider("West", { region: "us-west-1" }) },
      );
      await pulumi.settle();

      expect(
        Object.fromEntries(
          pulumi.resources
            .filter((r) => r.custom && r.type.startsWith("aws:"))
            .map((r) => [
              r.name,
              (r.options.provider as string).split("::").at(-2),
            ]),
        ),
      ).toEqual({
        MyClusterCluster: "West",
        MyClusterPeerCluster: "AwsProvider.sst.us-east-2",
        MyClusterClusterPeering: "West",
        MyClusterPeerClusterPeering: "AwsProvider.sst.us-east-2",
        MyClusterBackupRole: "West",
        MyClusterBackupVault: "West",
        MyClusterPeerBackupVault: "AwsProvider.sst.us-east-2",
        MyClusterBackupPlan: "West",
        MyClusterBackupSelection: "West",
      });
    });

    it("keeps what it renames", async () => {
      const create = (Dsql: DsqlClass) => {
        new Dsql("MyCluster", { regions, backup: true });
      };

      create(OriginalDsql);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(original.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          "MyClusterPeering1",
          "MyClusterPeering2",
          "MyClusterBackupVaultPeer",
        ]),
      );

      pulumi.reset();
      create(Dsql);
      await pulumi.settle();
      expect(names()).toEqual(
        expect.arrayContaining([
          "MyClusterClusterPeering",
          "MyClusterPeerClusterPeering",
          "MyClusterPeerBackupVault",
        ]),
      );
      expect(
        pulumi
          .takeover(
            original.filter((r) => !r.type.startsWith("pulumi:providers:")),
          )
          .unclaimed,
      ).toEqual([]);
    });
  });

  it("creates only the cluster by default", async () => {
    const cluster = new Dsql("MyCluster");
    await pulumi.settle();

    expect(names()).toEqual(["MyCluster", "MyClusterCluster"]);
    expect(resource("MyClusterCluster").inputs.multiRegionProperties).toBe(
      undefined,
    );
    expect(await pulumi.resolve([cluster.region, cluster.endpoint])).toEqual([
      "us-east-1",
      "myclustercluster.dsql.us-east-1.on.aws",
    ]);
    expect(cluster.nodes.peerCluster).toBe(undefined);
  });

  it("peers a multi-region cluster both ways", async () => {
    const cluster = new Dsql("MyCluster", { regions });
    await pulumi.settle();

    expect(created(CLUSTER)).toEqual(["MyClusterCluster", "MyClusterPeerCluster"]);
    expect(resource("MyClusterCluster").inputs.multiRegionProperties).toEqual({
      witnessRegion: "us-west-2",
    });
    expect(resource("MyClusterPeerCluster").inputs.multiRegionProperties).toEqual({
      witnessRegion: "us-west-2",
    });
    expect(resource("MyClusterClusterPeering").inputs).toMatchObject({
      identifier: "myclustercluster",
      clusters: ["arn:aws:dsql:us-east-2:123456789012:cluster/myclusterpeercluster"],
      witnessRegion: "us-west-2",
    });
    expect(resource("MyClusterPeerClusterPeering").inputs).toMatchObject({
      identifier: "myclusterpeercluster",
      clusters: ["arn:aws:dsql:us-east-1:123456789012:cluster/myclustercluster"],
      witnessRegion: "us-west-2",
    });
    expect(
      await pulumi.resolve([cluster.peer.region, cluster.peer.endpoint]),
    ).toEqual(["us-east-2", "myclusterpeercluster.dsql.us-east-2.on.aws"]);
    expect(cluster.nodes.clusterPeering).toBeDefined();
    expect(cluster.nodes.peerClusterPeering).toBeDefined();
  });

  it("has no peer for a single-region cluster", async () => {
    const cluster = new Dsql("MyCluster");
    await pulumi.settle();

    expect(() => cluster.peer).toThrow(
      `The "MyCluster" DSQL cluster is in one region, so it has no "peer". Set "regions.peer" to give it one.`,
    );
  });

  it("connects through the VPC endpoint when it has one", async () => {
    const cluster = new Dsql("MyCluster", { vpc: new Vpc("MyVpc") });
    await pulumi.settle();

    expect(created(ENDPOINT)).toEqual(["MyClusterConnectionEndpoint"]);
    expect(resource("MyClusterConnectionEndpoint").inputs).toMatchObject({
      vpcId: "MyVpcVpc_id",
      serviceName: "com.amazonaws.us-east-1.dsql-fnh4",
      vpcEndpointType: "Interface",
      subnetIds: ["MyVpcPrivateSubnet1_id", "MyVpcPrivateSubnet2_id"],
      privateDnsEnabled: true,
      securityGroupIds: ["MyClusterDsqlEndpointSecurityGroup_id"],
    });
    expect(resource("MyClusterDsqlEndpointSecurityGroup").inputs).toMatchObject({
      vpcId: "MyVpcVpc_id",
      ingress: [
        {
          protocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          cidrBlocks: ["10.0.0.0/16"],
        },
      ],
    });
    expect(await pulumi.resolve(cluster.endpoint)).toBe(
      "myclustercluster.dsql-fnh4.us-east-1.on.aws",
    );
  });

  it("adds the management endpoint when asked", async () => {
    const cluster = new Dsql("MyCluster", {
      vpc: {
        instance: new Vpc("MyVpc"),
        endpoints: { management: true, connection: false },
      },
    });
    await pulumi.settle();

    expect(created(ENDPOINT)).toEqual(["MyClusterManagementEndpoint"]);
    expect(resource("MyClusterManagementEndpoint").inputs.serviceName).toBe(
      "com.amazonaws.us-east-1.dsql",
    );
    expect(
      resource("MyClusterDsqlEndpointSecurityGroup").inputs.ingress,
    ).toMatchObject([{ fromPort: 443, toPort: 443 }]);
    // No endpoint to connect through, so connections use the public one
    expect(await pulumi.resolve(cluster.endpoint)).toBe(
      "myclustercluster.dsql.us-east-1.on.aws",
    );
    expect(cluster.nodes.connectionEndpoint).toBe(undefined);
  });

  it("takes either kind of Vpc", async () => {
    new Dsql("MyCluster", { vpc: new VpcV5("MyVpc") });
    await pulumi.settle();

    const subnets = pulumi.resources
      .filter((r) => r.type === "aws:ec2/subnet:Subnet")
      .filter((r) => r.name.startsWith("MyVpcPrivateSubnet"))
      .map((r) => `${r.name}_id`)
      .sort();
    expect(subnets).toHaveLength(2);
    expect(resource("MyClusterConnectionEndpoint").inputs).toMatchObject({
      vpcId: "MyVpcVpc_id",
      subnetIds: subnets,
    });
    expect(
      resource("MyClusterDsqlEndpointSecurityGroup").inputs.ingress,
    ).toMatchObject([{ fromPort: 5432, cidrBlocks: ["10.0.0.0/16"] }]);
  });

  it("refuses a vpc that isn't a Vpc", () => {
    const message =
      /The "vpc" of the "MyCluster" DSQL cluster isn't a "Vpc" component/;
    expect(
      () => new Dsql("MyCluster", { vpc: { id: "vpc-123" } as any }),
    ).toThrow(message);
    expect(
      () =>
        new Dsql("MyCluster", {
          vpc: { instance: { id: "vpc-123" } as any },
        }),
    ).toThrow(message);
  });

  it("refuses a witness that's its peer region", () => {
    expect(
      () =>
        new Dsql("MyCluster", {
          regions: { witness: "us-east-2", peer: "us-east-2" },
        }),
    ).toThrow(
      /The witness region of the "MyCluster" DSQL cluster is its peer region, "us-east-2"/,
    );
  });

  it("can't have VPC endpoints for a multi-region cluster", () => {
    expect(
      () => new Dsql("MyCluster", { regions, vpc: new Vpc("MyVpc") }),
    ).toThrow(
      `"vpc" isn't an option for the "MyCluster" DSQL cluster, which has a peer in "regions". VPC endpoints are only for a cluster in one region.`,
    );
  });

  it("backs up daily and keeps a week by default", async () => {
    new Dsql("MyCluster", { backup: true });
    await pulumi.settle();

    expect(created(VAULT)).toEqual(["MyClusterBackupVault"]);
    expect(resource("MyClusterBackupPlan").inputs.rules).toEqual([
      {
        ruleName: "MyClusterBackupRule",
        targetVaultName: expect.any(String),
        schedule: "cron(0 5 ? * * *)",
        scheduleExpressionTimezone: "UTC",
        lifecycle: { deleteAfter: 7 },
      },
    ]);
    expect(resource("MyClusterBackupSelection").inputs).toMatchObject({
      planId: "MyClusterBackupPlan_id",
      iamRoleArn: "arn:aws:mock:us-east-1:123456789012:MyClusterBackupRole",
      resources: ["arn:aws:dsql:us-east-1:123456789012:cluster/myclustercluster"],
    });
    expect(resource("MyClusterBackupRole").inputs.managedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    ]);
  });

  it("copies a multi-region cluster's backups to the peer region", async () => {
    new Dsql("MyCluster", { regions, backup: { retention: "30 days" } });
    await pulumi.settle();

    expect(created(VAULT)).toEqual([
      "MyClusterBackupVault",
      "MyClusterPeerBackupVault",
    ]);
    expect(resource("MyClusterPeerBackupVault").options.provider).toMatch(
      /::AwsProvider\.sst\.us-east-2::/,
    );
    expect(resource("MyClusterBackupPlan").inputs.rules[0]).toMatchObject({
      lifecycle: { deleteAfter: 30 },
      copyActions: [
        {
          destinationVaultArn:
            "arn:aws:mock:us-east-1:123456789012:MyClusterPeerBackupVault",
          lifecycle: { deleteAfter: 30 },
        },
      ],
    });
  });

  it("transforms the peer region's vault after the shared transform", async () => {
    const seen: string[] = [];
    new Dsql("MyCluster", {
      regions,
      backup: true,
      transform: {
        backupVault: (args, opts, name) => {
          seen.push(name);
          // Each vault is the component's, whichever region it's in
          expect(opts.parent).toBeDefined();
          args.forceDestroy = true;
          args.tags = { team: "data" };
        },
        peerBackupVault: { tags: { team: "replica" } },
      },
    });
    await pulumi.settle();

    expect(seen).toEqual(["MyClusterBackupVault", "MyClusterPeerBackupVault"]);
    expect(resource("MyClusterBackupVault").inputs).toMatchObject({
      forceDestroy: true,
      tags: { team: "data" },
    });
    expect(resource("MyClusterPeerBackupVault").inputs).toMatchObject({
      forceDestroy: true,
      tags: { team: "replica" },
    });
  });

  it("transforms the parts Dsql had no transform for", async () => {
    new Dsql("MyCluster", {
      regions,
      backup: true,
      transform: {
        clusterPeering: (_args, opts) => {
          opts.protect = true;
        },
        peerClusterPeering: (_args, opts) => {
          opts.protect = true;
        },
        backupRole: { description: "Backs up the cluster" },
      },
    });
    await pulumi.settle();

    expect(resource("MyClusterClusterPeering").options.protect).toBe(true);
    expect(resource("MyClusterPeerClusterPeering").options.protect).toBe(true);
    expect(resource("MyClusterBackupRole").inputs.description).toBe(
      "Backs up the cluster",
    );
  });

  it("links its region and endpoint", async () => {
    const cluster = new Dsql("MyCluster");
    await pulumi.settle();

    const link = (cluster as any).getSSTLink();
    expect(await pulumi.resolve(link.properties)).toEqual({
      region: "us-east-1",
      endpoint: "myclustercluster.dsql.us-east-1.on.aws",
      peer: undefined,
    });
    expect(await pulumi.resolve(link.include)).toEqual([
      {
        type: "aws.permission",
        actions: ["dsql:DbConnect", "dsql:DbConnectAdmin", "dsql:GetCluster"],
        resources: ["arn:aws:dsql:us-east-1:123456789012:cluster/myclustercluster"],
      },
    ]);
  });

  it("links the peer of a multi-region cluster", async () => {
    const cluster = new Dsql("MyCluster", { regions });
    await pulumi.settle();

    const link = (cluster as any).getSSTLink();
    expect(await pulumi.resolve(link.properties.peer)).toEqual({
      region: "us-east-2",
      endpoint: "myclusterpeercluster.dsql.us-east-2.on.aws",
    });
    expect(await pulumi.resolve(link.include[0].resources)).toEqual([
      "arn:aws:dsql:us-east-1:123456789012:cluster/myclustercluster",
      "arn:aws:dsql:us-east-2:123456789012:cluster/myclusterpeercluster",
    ]);
  });

  describe("an existing cluster", () => {
    it("is referenced with get", async () => {
      const cluster = Dsql.get("MyCluster", { id: "abc123" });
      await pulumi.settle();

      expect(names()).toEqual(["MyCluster", "MyClusterCluster"]);
      expect(
        await pulumi.resolve([cluster.id, cluster.region, cluster.endpoint]),
      ).toEqual(["abc123", "us-east-1", "abc123.dsql.us-east-1.on.aws"]);
      expect(() => cluster.peer).toThrow(/is in one region, so it has no "peer"/);
    });

    it("is referenced with its peer", async () => {
      const cluster = Dsql.get("MyCluster", {
        id: "abc123",
        peer: { id: "def456", region: "us-east-2" },
      });
      await pulumi.settle();

      // The peer is read with a provider for its region
      expect(names()).toEqual([
        "AwsProvider.sst.us-east-2",
        "MyCluster",
        "MyClusterCluster",
        "MyClusterPeerCluster",
      ]);
      expect(
        await pulumi.resolve([
          cluster.endpoint,
          cluster.peer.region,
          cluster.peer.endpoint,
        ]),
      ).toEqual([
        "abc123.dsql.us-east-1.on.aws",
        "us-east-2",
        "def456.dsql.us-east-2.on.aws",
      ]);
    });

    it("creates nothing around it", async () => {
      new Dsql("MyCluster", {
        existing: { cluster: "abc123" },
        backup: true,
      });
      await pulumi.settle();

      expect(names()).toEqual(["MyCluster", "MyClusterCluster"]);
    });

    it("takes its peer as a resource", async () => {
      const { dsql } = await import("@pulumi/aws");
      const peerCluster = dsql.Cluster.get("Elsewhere", "def456");
      const cluster = new Dsql("MyCluster", {
        existing: { cluster: "abc123", peerCluster },
      });
      await pulumi.settle();

      expect(cluster.nodes.peerCluster).toBe(peerCluster);
      expect(await pulumi.resolve(cluster.peer.endpoint)).toBe(
        "def456.dsql.us-east-1.on.aws",
      );
    });

    it("takes its peer's id as an output", async () => {
      const cluster = Dsql.get("MyCluster", {
        id: "abc123",
        peer: { id: output("def456"), region: "us-east-2" },
      });
      await pulumi.settle();

      expect(resource("MyClusterPeerCluster")).toMatchObject({
        kind: "read",
        options: { id: "def456" },
      });
      expect(await pulumi.resolve(cluster.peer.region)).toBe("us-east-2");
    });

    it("needs the region of a peer given by id", () => {
      expect(
        () =>
          new Dsql("MyCluster", {
            existing: { cluster: "abc123", peerCluster: "def456" },
          }),
      ).toThrow(/Set "regions.peer" to that region, or pass the cluster itself/);
    });

    it("can be the peer of a new cluster", async () => {
      new Dsql("MyCluster", {
        regions,
        existing: { peerCluster: "def456" },
      });
      await pulumi.settle();

      expect(resource("MyClusterPeerCluster")).toMatchObject({
        kind: "read",
        options: {
          id: "def456",
          provider: expect.stringMatching(/::AwsProvider\.sst\.us-east-2::/),
        },
      });
      expect(resource("MyClusterClusterPeering").inputs.clusters).toEqual([
        "arn:aws:dsql:us-east-2:123456789012:cluster/def456",
      ]);
    });
  });

  describe("args that decide what's created", () => {
    it("rejects regions given as an output", () => {
      expect(
        () => new Dsql("MyCluster", { regions: output(regions) as any }),
      ).toThrow(/The "regions" of the "MyCluster" DSQL cluster has to be a plain value/);
    });

    it("rejects a peer region given as an output", () => {
      expect(
        () =>
          new Dsql("MyCluster", {
            regions: { witness: "us-west-2", peer: output("us-east-2") as any },
          }),
      ).toThrow(/The "regions.peer" of the "MyCluster" DSQL cluster has to be a plain value/);
    });

    it("rejects backup given as an output", () => {
      expect(
        () => new Dsql("MyCluster", { backup: output(true) as any }),
      ).toThrow(/The "backup" of the "MyCluster" DSQL cluster has to be a plain value/);
    });

    it("rejects an endpoint switch given as an output", () => {
      expect(
        () =>
          new Dsql("MyCluster", {
            vpc: {
              instance: new Vpc("MyVpc"),
              endpoints: { management: output(true) as any },
            },
          }),
      ).toThrow(/The "management" of the "vpc.endpoints" of the "MyCluster" DSQL cluster has to be a plain value/);
    });

    it("rejects a part it doesn't have", () => {
      expect(
        () =>
          new Dsql("MyCluster", {
            transform: { peering: {} } as any,
          }),
      ).toThrow(/"peering" is not something you can transform/);
    });
  });
});
