import path from "path";
import { ComponentResourceOptions, all, output } from "@pulumi/pulumi";
import { rds } from "@pulumi/aws";
import { type ComponentArgs, component, optional } from "../../parts-component";
import { notAnOption } from "../../args";
import { context } from "../../contract";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { type AnyVpc, assertVpcIds, isVpc } from "../helpers/vpc";
import { permission } from "../permission";
import { VectorTable } from "../providers/vector-table";
import { Function } from "./function";

type ACU = `${number} ACU`;

const parts = {
  /**
   * The RDS Aurora Serverless v2 Postgres cluster the vectors are stored in.
   */
  cluster: rds.Cluster,
  /**
   * The cluster's serverless instance.
   */
  instance: rds.ClusterInstance,
  /**
   * The DB subnet group the cluster is in. Only created with a `vpc`.
   */
  subnetGroup: optional(rds.SubnetGroup),
  /**
   * The table the vectors are stored in, with the `vector` extension. Not created for a
   * cluster passed in `existing`, or by `get`, which use the table that database has.
   */
  table: optional(VectorTable),
  /**
   * The function that queries the vectors, which the SDK invokes.
   */
  query: Function,
  /**
   * The function that puts a vector, which the SDK invokes.
   */
  put: Function,
  /**
   * The function that removes vectors, which the SDK invokes.
   */
  remove: Function,
};

export interface VectorArgs extends ComponentArgs<typeof parts> {
  /**
   * The dimension size of each vector.
   *
   * The maximum supported dimension is 2000. To store vectors with greater dimension,
   * use dimensionality reduction to reduce the dimension to 2000 or less. OpenAI supports
   * [dimensionality reduction](https://platform.openai.com/docs/api-reference/embeddings/create#embeddings-create-dimensions) automatically when generating embeddings.
   *
   * :::caution
   * Changing the dimension will cause the data to be cleared.
   * :::
   *
   * @example
   * ```js
   * {
   *   dimension: 1536
   * }
   * ```
   */
  dimension: Input<number>;
  /**
   * The VPC to put the database in, in its private subnets. By default it's in your
   * account's default VPC.
   *
   * :::caution
   * Changing the VPC replaces the database, and clears the data.
   * :::
   *
   * @example
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * Or pass in the subnets and security groups of an existing VPC.
   *
   * ```js
   * {
   *   vpc: {
   *     privateSubnets: ["subnet-0b6a2b73896dc8c4c", "subnet-021389ebee680c2f0"],
   *     securityGroups: ["sg-0399348378a4c256c"]
   *   }
   * }
   * ```
   */
  vpc?:
    | AnyVpc
    | Input<{
        /**
         * A list of private subnet IDs in the VPC.
         */
        privateSubnets: Input<Input<string>[]>;
        /**
         * A list of VPC security group IDs.
         */
        securityGroups: Input<Input<string>[]>;
      }>;
  /**
   * The Postgres engine version. Check out the [available versions in your region](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html#Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.apg).
   *
   * Without it, the cluster is created with version 17, and a later change of version is
   * ignored.
   *
   * @default `"17"`
   * @example
   * ```js
   * {
   *   version: "16.4"
   * }
   * ```
   */
  version?: Input<string>;
  /**
   * The name of the database the vectors are stored in, created inside the cluster.
   *
   * The name must begin with a letter and contain only lowercase letters, numbers, or
   * underscores. By default, it takes the name of the app, and replaces the hyphens with
   * underscores.
   *
   * :::caution
   * Changing the name replaces the database, and clears the data.
   * :::
   *
   * @default Based on the name of the current app
   */
  databaseName?: Input<string>;
  /**
   * The Aurora Serverless v2 scaling config. The instance scales from the minimum number of
   * ACUs to the maximum. An ACU, or Aurora Capacity Unit, is roughly 2 GB of memory with
   * the CPU to go with it.
   *
   * @default `{ min: "0.5 ACU", max: "4 ACU" }`
   * @example
   * ```js
   * {
   *   scaling: {
   *     min: "2 ACU",
   *     max: "16 ACU"
   *   }
   * }
   * ```
   */
  scaling?: Input<{
    /**
     * The minimum number of ACUs, from 0.5 to 128, in increments of 0.5.
     * @default `"0.5 ACU"`
     */
    min?: Input<ACU>;
    /**
     * The maximum number of ACUs, from 1 to 128, in increments of 0.5.
     * @default `"4 ACU"`
     */
    max?: Input<ACU>;
  }>;
}

/**
 * The `Vector` component has been deprecated. It should not be used for new projects.
 *
 * :::caution
 * This component has been deprecated.
 * :::
 *
 * The `Vector` component lets you store and retrieve vector data in your app.
 *
 * - It uses a vector database powered by [RDS Postgres Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html).
 * - Provides a [SDK](/docs/reference/sdk/) to query, put, and remove the vector data.
 *
 * @deprecated Use a dedicated vector database provider instead.
 *
 * @example
 *
 * #### Create the database
 *
 * ```ts title="sst.config.ts"
 * const vector = new sst.aws.v5.Vector("MyVectorDB", {
 *   dimension: 1536
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link it to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [vector]
 * });
 * ```
 *
 * Once linked, you can query it in your function code using the [SDK](/docs/reference/sdk/).
 *
 * ```ts title="app/page.tsx"
 * import { VectorClient } from "sst";
 *
 * await VectorClient("MyVectorDB").query({
 *   vector: [32.4, 6.55, 11.2, 10.3, 87.9]
 * });
 * ```
 *
 * #### Switch from `sst.aws.Vector`
 *
 * Change `sst.aws.Vector` to `sst.aws.v5.Vector` and keep the name. The database and its
 * data are kept: the cluster, its instance and its subnet group, which `sst.aws.Vector`
 * kept in a `Postgres` component of its own, move into the vector with the same ids.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const vector = new sst.aws.Vector("MyVectorDB", { dimension: 1536 });
 * const vector = new sst.aws.v5.Vector("MyVectorDB", { dimension: 1536 });
 * ```
 *
 * A few things work differently:
 *
 * - `transform.postgres` is gone, with the `Postgres` component, and is refused with what
 *   to write. Its `vpc`, `version`, `scaling` and `databaseName` are the vector's args of
 *   the same names, and `vpc: "default"` is leaving `vpc` out. Its `transform` is the
 *   vector's, for the `cluster`, the `instance` and the `subnetGroup`. Resource options a
 *   function in it set, like `protect`, go in a function for each of those three.
 * - A `$transform` of `sst.aws.Postgres` or `sst.aws.Postgres.v1` doesn't reach the
 *   vector's database any more: transform the vector.
 * - `nodes.postgres` is gone: `nodes.cluster` and `nodes.instance` are the database.
 *   `nodes` also has the table, the subnet group and the three functions.
 * - If you set `serverlessv2ScalingConfiguration` on the cluster with an object in
 *   `transform`, it keeps the capacity SST sets that you don't, where SST 4 replaced it.
 * - `get` looks the cluster and its instance up inside the vector. `sst.aws.Vector`
 *   looked them up in a `Postgres` component at the top of your app, which a switch takes
 *   out of the state, as it does the lookups. Nothing in AWS changes.
 */
export class Vector extends component("sst:aws:Vector", parts) {
  constructor(
    name: string,
    args: VectorArgs,
    opts: ComponentResourceOptions = {},
  ) {
    // SST 4's, refused before the component turns down a key it doesn't have
    notAnOption(
      args?.transform ?? {},
      "postgres",
      `The "${name}" vector database has no Postgres component. Set its "vpc", "version", "scaling" and "databaseName" on the vector itself, and transform its database with "transform.cluster", "transform.instance" and "transform.subnetGroup".`,
    );
    // SST 4's Postgres took the default VPC by name
    if ((args?.vpc as unknown) === "default")
      throw new VisibleError(
        `The "vpc" of the "${name}" vector database is "default". Leave "vpc" out to use the default VPC.`,
      );
    super(name, args, opts);

    const self = this;
    const tableName = "embeddings";
    // Without a version, the one it was created with is kept
    const versionIgnored = args.version ? [] : ["engineVersion"];

    // A database that's already deployed: its table is already there
    const existing = this.existingPart("cluster");
    const cluster = existing ?? createCluster();
    const instance = existing ? lookUpInstance() : createInstance();
    if (!existing)
      this.part(
        "table",
        {
          clusterArn: cluster.arn,
          secretArn: cluster.masterUserSecrets[0].secretArn,
          databaseName: cluster.databaseName,
          tableName,
          dimension: args.dimension,
        },
        { dependsOn: instance },
      );

    for (const key of ["query", "put", "remove"] as const)
      this.part(key, {
        description: `${name} ${key} handler`,
        bundle: path.join(context().paths.platform, "dist", "vector-handler"),
        handler: `index.${key}`,
        environment: {
          CLUSTER_ARN: cluster.arn,
          SECRET_ARN: cluster.masterUserSecrets[0].secretArn,
          DATABASE_NAME: cluster.databaseName,
          TABLE_NAME: tableName,
        },
        permissions: [
          {
            actions: ["secretsmanager:GetSecretValue"],
            resources: [cluster.masterUserSecrets[0].secretArn],
          },
          {
            actions: ["rds-data:ExecuteStatement"],
            resources: [cluster.arn],
          },
        ],
        dev: false,
      });

    function createCluster() {
      const vpc = normalizeVpc();
      const subnetGroup = vpc
        ? self.part("subnetGroup", { subnetIds: vpc.privateSubnets })
        : undefined;
      return self.part(
        "cluster",
        {
          engine: rds.EngineType.AuroraPostgresql,
          engineMode: "provisioned",
          engineVersion: output(args.version).apply(
            (version) => version ?? "17",
          ),
          databaseName: output(args.databaseName).apply(
            (name) => name ?? context().app.name.replaceAll("-", "_"),
          ),
          masterUsername: "postgres",
          manageMasterUserPassword: true,
          serverlessv2ScalingConfiguration: output(args.scaling).apply(
            (scaling) => ({
              minCapacity: parseACU(scaling?.min ?? "0.5 ACU"),
              maxCapacity: parseACU(scaling?.max ?? "4 ACU"),
            }),
          ),
          applyImmediately: true,
          allowMajorVersionUpgrade: true,
          skipFinalSnapshot: true,
          enableHttpEndpoint: true,
          dbSubnetGroupName: subnetGroup?.name,
          vpcSecurityGroupIds: vpc?.securityGroups,
        },
        { ignoreChanges: versionIgnored },
      );
    }

    function createInstance() {
      return self.part(
        "instance",
        {
          clusterIdentifier: cluster.id,
          instanceClass: "db.serverless",
          engine: rds.EngineType.AuroraPostgresql,
          engineVersion: cluster.engineVersion,
          dbSubnetGroupName: self.nodes.subnetGroup?.name,
          autoMinorVersionUpgrade: false,
        },
        { ignoreChanges: versionIgnored },
      );
    }

    function parseACU(acu: ACU) {
      return parseFloat(acu.split(" ")[0]);
    }

    function lookUpInstance() {
      return (
        self.existingPart("instance") ??
        self.lookupPart(
          "instance",
          all([
            cluster.id,
            rds.getInstancesOutput(
              { filters: [{ name: "db-cluster-id", values: [cluster.id] }] },
              { parent: self },
            ).instanceIdentifiers,
          ]).apply(([id, instances]) => {
            if (!instances.length)
              throw new VisibleError(
                `The "${name}" vector database found no instance in the cluster "${id}".`,
              );
            return instances[0];
          }),
        )
      );
    }

    // The private subnets and security groups the database is put in
    function normalizeVpc() {
      const vpc = args.vpc;
      if (!vpc) return;
      if (isVpc(vpc)) {
        // The two `Vpc`s type these differently
        const privateSubnets: Input<Input<string>[]> = vpc.privateSubnets;
        const securityGroups: Input<Input<string>[]> = vpc.securityGroups;
        return {
          privateSubnets: output(privateSubnets),
          securityGroups: output(securityGroups),
        };
      }
      assertVpcIds(vpc, `the "${name}" vector database`);
      const ids = output(vpc);
      return {
        privateSubnets: ids.privateSubnets,
        securityGroups: ids.securityGroups,
      };
    }
  }

  /**
   * Reference an existing Vector database with the given name. This is useful when you
   * create a Vector database in one stage and want to share it in another. It avoids having to
   * create a new Vector database in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share Vector databases across stages.
   * :::
   *
   * @param name The name of the component.
   * @param clusterID The RDS cluster id of the existing Vector database.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a vector database  in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new database, you want to share the same database from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const vector = $app.stage === "frank"
   *   ? sst.aws.v5.Vector.get("MyVectorDB", "app-dev-myvectordb")
   *   : new sst.aws.v5.Vector("MyVectorDB", {
   *       dimension: 1536
   *     });
   * ```
   *
   * Here `app-dev-myvectordb` stands for the ID of the underlying Postgres cluster created in the `dev` stage.
   * You can find this by outputting the cluster ID in the `dev` stage.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   cluster: vector.clusterID
   * };
   * ```
   *
   * :::note
   * The Vector component creates a Postgres cluster and lambda functions for interfacing with the VectorDB.
   * The `static get` method only shares the underlying Postgres cluster. Each stage will have its own
   * lambda functions.
   * :::
   */
  public static get(
    name: string,
    clusterID: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Vector(
      name,
      { existing: { cluster: clusterID } } as VectorArgs,
      opts,
    );
  }

  /**
   * The ID of the RDS Postgres Cluster.
   */
  public get clusterID() {
    return this.nodes.cluster.id;
  }

  /**
   * Linking a vector database lets the [SDK](/docs/reference/sdk/) query, put and remove
   * its vectors, by invoking its three functions.
   */
  public link() {
    const { query, put, remove } = this.nodes;
    return {
      properties: {
        /** @internal */
        queryFunction: query.name,
        /** @internal */
        putFunction: put.name,
        /** @internal */
        removeFunction: remove.name,
      },
      include: [
        permission({
          actions: ["lambda:InvokeFunction"],
          resources: [
            query.nodes.function.arn,
            put.nodes.function.arn,
            remove.nodes.function.arn,
          ],
        }),
      ],
    };
  }
}
