import { all, ComponentResourceOptions } from "@pulumi/pulumi";
import { backup, dsql, ec2, iam, type Region } from "@pulumi/aws";
import {
  ComponentArgs,
  component,
  named,
  optional,
} from "../../parts-component";
import { plain, withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { type DurationDays, toDays } from "../../duration";
import { transformPart } from "../../transform";
import {
  parseDsqlPrivateEndpoint,
  parseDsqlPublicEndpoint,
} from "../helpers/arn";
import { useProvider } from "../helpers/provider";
import { permission } from "../permission";
import { Vpc } from "../vpc";

const parts = {
  /**
   * The DSQL cluster.
   */
  cluster: dsql.Cluster,
  /**
   * The peer DSQL cluster, in the peer region. Multi-region only.
   */
  peerCluster: optional(dsql.Cluster),
  /**
   * The peering that tells the cluster about its peer. Multi-region only.
   */
  clusterPeering: optional(dsql.ClusterPeering),
  /**
   * The peering that tells the peer cluster about the cluster, in the peer region.
   * Multi-region only.
   */
  peerClusterPeering: optional(dsql.ClusterPeering),
  /**
   * The EC2 security group for the DSQL VPC endpoints.
   */
  // A security group is named with a tag made from its logical name, so it
  // keeps the name it was first deployed with.
  endpointSecurityGroup: named(
    optional(ec2.SecurityGroup),
    "DsqlEndpointSecurityGroup",
  ),
  /**
   * The EC2 VPC endpoint for DSQL management operations.
   */
  managementEndpoint: optional(ec2.VpcEndpoint),
  /**
   * The EC2 VPC endpoint for DSQL connections.
   */
  connectionEndpoint: optional(ec2.VpcEndpoint),
  /**
   * The IAM role AWS Backup uses to back up the cluster.
   */
  backupRole: optional(iam.Role),
  /**
   * The AWS Backup vault.
   */
  backupVault: optional(backup.Vault),
  /**
   * The AWS Backup vault in the peer region, which the backups are copied to.
   * Multi-region only.
   */
  peerBackupVault: optional(backup.Vault),
  /**
   * The AWS Backup plan.
   */
  backupPlan: optional(backup.Plan),
  /**
   * The AWS Backup selection.
   */
  backupSelection: optional(backup.Selection),
};

export interface DsqlArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure multi-region cluster peering.
   *
   * Creates a cluster in the current region and a peer cluster in another region,
   * linked via a witness region. The witness must differ from both cluster regions.
   *
   * Learn more about [AWS DSQL regions](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html#region-availability).
   *
   * Whether the cluster is multi-region, and its peer region, have to be plain values.
   *
   * @example
   *
   * ```ts
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   regions: {
   *     witness: "us-west-2",
   *     peer: "us-east-2"
   *   }
   * });
   * ```
   */
  regions?: {
    /** The witness region. Must differ from both cluster regions. */
    witness: Input<string>;
    /** The AWS region for the peer cluster. */
    peer: string;
  };

  /**
   * Configure automatic backups for the cluster using AWS Backup.
   *
   * Set to `true` to use the defaults, or pass an object to customize the schedule and retention.
   *
   * :::tip
   * If multi-region is enabled, backups are scheduled in the current region and
   * copied to the peer region.
   * :::
   *
   * Omit or set to `false` to skip backup creation entirely.
   *
   * @example
   * Enable with defaults (daily at 5 AM UTC, 7-day retention).
   * ```ts title="sst.config.ts"
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   backup: true
   * });
   * ```
   *
   * Custom schedule and retention.
   * ```ts title="sst.config.ts"
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   backup: {
   *     schedule: "cron(0 2 ? * * *)",
   *     retention: "90 days"
   *   }
   * });
   * ```
   */
  backup?:
    | boolean
    | {
        /**
         * The schedule for the backups as an [AWS Backup cron expression](https://docs.aws.amazon.com/aws-backup/latest/devguide/API_BackupRule.html).
         *
         * This uses the same 6-field `cron(...)` format as EventBridge and is evaluated in UTC.
         *
         * @default `"cron(0 5 ? * * *)"`
         * @example
         * Back up every day at midnight UTC.
         * ```ts
         * schedule: "cron(0 0 ? * * *)"
         * ```
         *
         * Back up every Monday at 3 AM UTC.
         * ```ts
         * schedule: "cron(0 3 ? * MON *)"
         * ```
         */
        schedule?: Input<string>;
        /**
         * How long to retain backups. Use a day duration like `"7 days"`.
         * @default `"7 days"`
         */
        retention?: Input<DurationDays>;
      };

  /**
   * Create AWS PrivateLink interface endpoints in a VPC for private connectivity.
   * This allows lambdas placed inside a VPC without NAT gateways to connect to the DSQL instance.
   *
   * :::note
   * Currently only single region VPC is supported.
   * :::
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const myVpc = new sst.aws.Vpc("MyVpc");
   *
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   vpc: myVpc
   * });
   * ```
   *
   * #### Customize VPC endpoints
   *
   * ```ts title="sst.config.ts"
   * const myVpc = new sst.aws.Vpc("MyVpc");
   *
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   vpc: {
   *     instance: myVpc,
   *     endpoints: {
   *       management: true,
   *       connection: true,
   *     }
   *   }
   * });
   * ```
   */
  vpc?:
    | Vpc
    | {
        /** The VPC to create the endpoints in. */
        instance: Vpc;
        endpoints?: {
          /**
           * Endpoint for control plane ops (create, get, update, delete clusters).
           *
           * @default `false`
           */
          management?: boolean;
          /**
           * Endpoint for PostgreSQL client connections.
           *
           * @default `true`
           */
          connection?: boolean;
        };
      };
}

/**
 * The `Dsql` component lets you add an [Amazon Aurora DSQL](https://aws.amazon.com/rds/aurora/dsql/) cluster to your app.
 *
 * It takes the same args as [`sst.aws.Dsql`](/docs/component/aws/dsql) and creates the same
 * resources. It's built from parts, so every resource it creates can be transformed, is
 * available in `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Single-region cluster
 *
 * ```ts title="sst.config.ts"
 * const cluster = new sst.aws.v5.Dsql("MyCluster");
 * ```
 *
 * Once linked, you can connect to it from your function code.
 *
 * ```ts title="src/lambda.ts"
 * import { Resource } from "sst";
 * import { AuroraDSQLClient } from "@aws/aurora-dsql-node-postgres-connector";
 *
 * const client = new AuroraDSQLClient({
 *   host: Resource.MyCluster.endpoint,
 *   user: "admin",
 * });
 *
 * await client.connect();
 * const result = await client.query("SELECT NOW() as now");
 * await client.end();
 * ```
 *
 * #### Multi-region cluster
 *
 * ```ts title="sst.config.ts"
 * const cluster = new sst.aws.v5.Dsql("MyCluster", {
 *   regions: {
 *     witness: "us-west-2",
 *     peer: "us-east-2"
 *   }
 * });
 * ```
 *
 * #### With private VPC endpoints
 *
 * ```ts title="sst.config.ts"
 * const vpc = new sst.aws.Vpc("MyVpc");
 *
 * const cluster = new sst.aws.v5.Dsql("MyCluster", {
 *   vpc: {
 *     instance: vpc,
 *     endpoints: { connection: true }
 *   }
 * });
 * ```
 *
 * #### With backups
 *
 * ```ts title="sst.config.ts"
 * const cluster = new sst.aws.v5.Dsql("MyCluster", {
 *   backup: true
 * });
 * ```
 *
 * #### Link to a function
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 *   link: [cluster]
 * });
 * ```
 *
 * #### Switch from `sst.aws.Dsql`
 *
 * Change `sst.aws.Dsql` to `sst.aws.v5.Dsql` and keep the name. The cluster you've
 * deployed is kept, and so is everything around it: its peer, VPC endpoints and backups.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const cluster = new sst.aws.Dsql("MyCluster");
 * const cluster = new sst.aws.v5.Dsql("MyCluster");
 * ```
 *
 * A few things are written differently:
 *
 * - `regions.peer` is a plain value, not an output. It decides which region the peer's
 *   resources are created in.
 * - `nodes` has every resource, not only the two clusters. Each can be transformed, the
 *   two sides of the peering and the backup role included.
 * - `transform.backupVault` still applies to the vault in the peer region as well. To
 *   change only that one, use `transform.peerBackupVault`, which is applied after it.
 *   A function that told the two apart by name now gets `MyClusterPeerBackupVault` for
 *   the peer's.
 * - If you set `multiRegionProperties` on the cluster with an object in `transform`, it
 *   keeps its witness region.
 *
 * ---
 *
 * ### Cost
 *
 * Aurora DSQL is serverless and uses a pay-per-use pricing model. You are charged for
 * database activity measured in _Distributed Processing Units_ (DPUs) at $8 per million
 * DPUs, and storage at $0.33 per GB-month. When idle, usage scales to zero and you incur
 * no DPU charges.
 *
 * There is a free tier of 100,000 DPUs and 1 GB of storage per month.
 *
 * For example, a single-region cluster averaging 1.3M DPUs per month with 15 GB of storage
 * costs roughly 1.3 x $8 + 15 x $0.33 or **$15 per month**.
 *
 * Check out the [Aurora DSQL pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/) for more details.
 */
export class Dsql extends component("sst:aws:Dsql", parts) {
  constructor(
    name: string,
    args: DsqlArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const regions = plain(
      args.regions,
      `The "regions" of the "${name}" DSQL cluster`,
    );
    // What's in the peer region is created with a provider for that region
    const peer = regions
      ? {
          provider: useProvider(
            plain(
              regions.peer,
              `The "regions.peer" of the "${name}" DSQL cluster`,
            ) as Region,
          ),
        }
      : undefined;

    // A cluster that's already deployed, and its peer when it has one
    if (this.existingPart("cluster")) {
      const peerCluster = args.existing?.peerCluster;
      if (peerCluster === undefined) return;
      if (!peer && !(peerCluster instanceof dsql.Cluster))
        throw new VisibleError(
          `The "${name}" DSQL cluster is given the id of an existing "peerCluster", which is in another region. Set "regions.peer" to that region, or pass the cluster itself.`,
        );
      this.part("peerCluster", {}, peer);
      return;
    }

    const vpc = plain(args.vpc, `The "vpc" of the "${name}" DSQL cluster`);
    const backups = plain(
      args.backup,
      `The "backup" of the "${name}" DSQL cluster`,
    );
    if (regions && vpc)
      throw new VisibleError(
        `Cannot use "vpc" with multi-region "regions". VPC endpoints are only supported for single-region clusters.`,
      );

    const cluster = this.part("cluster", {
      multiRegionProperties: regions
        ? { witnessRegion: regions.witness }
        : undefined,
    });

    if (regions) {
      const peerCluster = this.part(
        "peerCluster",
        { multiRegionProperties: { witnessRegion: regions.witness } },
        peer,
      );
      // DSQL requires both clusters to declare each other: a two-way handshake.
      this.part("clusterPeering", {
        identifier: cluster.identifier,
        clusters: [peerCluster.arn],
        witnessRegion: regions.witness,
      });
      this.part(
        "peerClusterPeering",
        {
          identifier: peerCluster.identifier,
          clusters: [cluster.arn],
          witnessRegion: regions.witness,
        },
        peer,
      );
    }

    if (vpc) {
      const instance = vpc instanceof Vpc ? vpc : vpc.instance;
      const endpoints = vpc instanceof Vpc ? undefined : vpc.endpoints;
      const what = `of the "vpc.endpoints" of the "${name}" DSQL cluster`;
      const management =
        plain(endpoints?.management, `The "management" ${what}`) ?? false;
      const connection =
        plain(endpoints?.connection, `The "connection" ${what}`) ?? true;

      const fromVpc = (port: number) => ({
        protocol: "tcp",
        fromPort: port,
        toPort: port,
        cidrBlocks: [instance.nodes.vpc.cidrBlock],
      });
      const securityGroup = this.part("endpointSecurityGroup", {
        vpcId: instance.id,
        description: "Allow DSQL access to VPC endpoints",
        ingress: [
          ...(management ? [fromVpc(443)] : []),
          ...(connection ? [fromVpc(5432)] : []),
        ],
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
      });

      const endpoint = (serviceName: Input<string>) => ({
        vpcId: instance.id,
        serviceName,
        vpcEndpointType: "Interface",
        subnetIds: instance.privateSubnets,
        privateDnsEnabled: true,
        securityGroupIds: [securityGroup.id],
      });
      // For control plane operations: creating, updating and deleting clusters
      if (management)
        this.part(
          "managementEndpoint",
          endpoint(
            cluster.arn.apply(
              (arn) => `com.amazonaws.${arn.split(":")[3]}.dsql`,
            ),
          ),
        );
      // For PostgreSQL client connections
      if (connection)
        this.part(
          "connectionEndpoint",
          endpoint(cluster.vpcEndpointServiceName),
        );
    }

    if (backups) {
      const config = backups === true ? {} : backups;
      const schedule = withDefault(config.schedule, "cron(0 5 ? * * *)");
      const retention = withDefault<DurationDays, number>(
        config.retention,
        "7 days",
        toDays,
      );

      const role = this.part("backupRole", {
        assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
          Service: "backup.amazonaws.com",
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
        ],
      });

      const vault = this.part("backupVault", {});
      // A multi-region cluster's backups are copied to a vault in the peer
      // region. The vault's transform applies to that one as well.
      const peerVault = peer
        ? this.part(
            "peerBackupVault",
            ...peerVaultArgs(args.transform?.backupVault, peer),
          )
        : undefined;

      const plan = this.part("backupPlan", {
        rules: [
          {
            ruleName: `${name}BackupRule`,
            targetVaultName: vault.name,
            schedule,
            scheduleExpressionTimezone: "UTC",
            lifecycle: { deleteAfter: retention },
            copyActions: peerVault
              ? [
                  {
                    destinationVaultArn: peerVault.arn,
                    lifecycle: { deleteAfter: retention },
                  },
                ]
              : undefined,
          },
        ],
      });

      this.part("backupSelection", {
        planId: plan.id,
        iamRoleArn: role.arn,
        resources: [cluster.arn],
      });
    }

    function peerVaultArgs(
      transform: NonNullable<DsqlArgs["transform"]>["backupVault"],
      peer: { provider: $util.ProviderResource },
    ) {
      const [, vaultArgs, vaultOpts] = transformPart<backup.VaultArgs>(
        transform,
        `${name}PeerBackupVault`,
        {},
        { ...peer },
      );
      return [vaultArgs, vaultOpts] as const;
    }
  }

  /** The region of the cluster. */
  public get region() {
    return this.nodes.cluster.region;
  }

  /** The endpoint of the cluster. */
  public get endpoint() {
    // Use the private VPC endpoint hostname when available so linked functions
    // inside the VPC don't route through the public IP.
    return all([
      this.nodes.cluster.arn,
      this.nodes.connectionEndpoint?.dnsEntries,
    ]).apply(([arn, dns]) =>
      dns ? parseDsqlPrivateEndpoint(arn, dns) : parseDsqlPublicEndpoint(arn),
    );
  }

  /**
   * The peer cluster info. Only available for multi-region clusters.
   *
   * @example
   * ```ts title="sst.config.ts"
   * const cluster = new sst.aws.v5.Dsql("MyCluster", {
   *   regions: { witness: "us-west-2", peer: "us-east-2" },
   * });
   *
   * return {
   *   peerRegion: cluster.peer.region,
   *   peerEndpoint: cluster.peer.endpoint,
   * };
   * ```
   */
  public get peer() {
    const peerCluster = this.nodes.peerCluster;
    if (!peerCluster)
      throw new VisibleError(
        `Cannot access "peer" on "${this.componentName}" because it is a single-region cluster. Set "regions.peer" to enable multi-region.`,
      );
    return {
      /** The region of the peer cluster. */
      region: peerCluster.region,
      /** The endpoint of the peer cluster. */
      endpoint: peerCluster.arn.apply(parseDsqlPublicEndpoint),
    };
  }

  /**
   * Linking a cluster gives the linked resource its region and endpoint, and its
   * peer's when it has one. It also lets the resource connect to the cluster.
   */
  public link() {
    const { cluster, peerCluster } = this.nodes;
    return {
      properties: {
        region: this.region,
        endpoint: this.endpoint,
        peer: peerCluster ? this.peer : undefined,
      },
      include: [
        permission({
          actions: ["dsql:DbConnect", "dsql:DbConnectAdmin", "dsql:GetCluster"],
          resources: peerCluster
            ? [cluster.arn, peerCluster.arn]
            : [cluster.arn],
        }),
      ],
    };
  }

  /**
   * Reference an existing DSQL cluster by identifier. Useful for sharing a cluster
   * across stages without creating a new one.
   *
   * :::tip
   * You can use the `static get` method to share a cluster across stages.
   * :::
   *
   * @param name The name of the component.
   * @param args The identifier of the cluster, and of its peer when it has one.
   * @param opts Component resource options.
   *
   * @example
   *
   * #### Single-region cluster
   *
   * ```ts title="sst.config.ts"
   * const cluster = $app.stage === "frank"
   *   ? sst.aws.v5.Dsql.get("MyCluster", { id: "kzttrvbdg4k2o5ze2m2rrwdj7u" })
   *   : new sst.aws.v5.Dsql("MyCluster");
   * ```
   * #### Multi-region cluster
   *
   * ```ts title="sst.config.ts"
   * const cluster = sst.aws.v5.Dsql.get("MyCluster", {
   *   id: "app-dev-mycluster",
   *   peer: {
   *     id: "kzttrvbdg4k2o5ze2m2rrwdj7u",
   *     region: "us-east-2",
   *   }
   * });
   * ```
   */
  public static get(
    name: string,
    args: {
      id: Input<string>;
      peer?: {
        id: string;
        region: string;
      };
    },
    opts?: ComponentResourceOptions,
  ) {
    return new Dsql(
      name,
      {
        existing: {
          cluster: args.id,
          ...(args.peer ? { peerCluster: args.peer.id } : {}),
        },
        ...(args.peer ? { regions: { peer: args.peer.region } } : {}),
      } as DsqlArgs,
      opts,
    );
  }
}
