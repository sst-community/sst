import { Link } from "../components/link";
import {
  ResourceTransformationArgs,
  runtime,
  automation,
  output,
} from "@pulumi/pulumi";

import { VisibleError } from "../components/error";
import { checkNames } from "../components/check";
import { newRun } from "../util/lazy";
import { leaveMarker, recordVersions } from "../components/move";

export async function run(program: automation.PulumiFn) {
  process.chdir($cli.paths.root);

  addTransformationToRetainResourcesOnDelete();
  addTransformationToAddTags();
  addTransformationToCheckBucketsHaveMultiplePolicies();

  newRun();
  Link.reset();
  // The marker that says the stage is on SST 5's components
  leaveMarker("before");
  let outputs: Record<string, any>;
  try {
    outputs = (await program()) || {};
  } catch (error) {
    explainUndefined(error);
  }
  leaveMarker("after");
  // What each component is at, once everything is deployed
  recordVersions();
  outputs._protect = $app.protect;
  // Kept with the state, so the next deploy runs a preview first and a
  // check's finding stops it before anything changes
  const checks = checkNames();
  if (checks.length) outputs._checks = checks;
  return outputs;
}

/**
 * A provider the app hasn't added is a name that isn't defined, often in a
 * package that uses it. Say how to add it.
 * @internal
 */
export function explainUndefined(error: unknown): never {
  const name =
    error instanceof ReferenceError &&
    error.message.match(/^(\w+) is not defined$/)?.[1];
  if (name) {
    const hint = `If "${name}" is a provider, add it to your app with "sst add ${name}".`;
    error.stack = error.stack?.replace(
      error.message,
      `${error.message}. ${hint}`,
    );
    error.message = `${error.message}. ${hint}`;
  }
  throw error;
}

function addTransformationToRetainResourcesOnDelete() {
  runtime.registerStackTransformation((args: ResourceTransformationArgs) => {
    if (
      $app.removal === "retain-all" ||
      ($app.removal === "retain" &&
        [
          "aws:dynamodb/table:Table",
          "aws:ec2/defaultSecurityGroup:DefaultSecurityGroup",
          "aws:ec2/subnet:Subnet",
          "aws:ec2/vpc:Vpc",
          "aws:rds/cluster:Cluster",
          "aws:rds/clusterParameterGroup:ClusterParameterGroup",
          "aws:rds/instance:Instance",
          "aws:rds/parameterGroup:ParameterGroup",
          "aws:rds/subnetGroup:SubnetGroup",
          "aws:dsql/cluster:Cluster",
          "aws:s3/bucket:Bucket",
          "aws:s3/bucketV2:BucketV2",
          "planetscale:index/database:Database",
          "planetscale:index/branch:Branch",
          "planetscale:index/vitessBranch:VitessBranch",
          "planetscale:index/postgresBranch:PostgresBranch",
        ].includes(args.type))
    ) {
      args.opts.retainOnDelete = args.opts.retainOnDelete ?? true;
      return args;
    }
    return undefined;
  });
}

function addTransformationToAddTags() {
  runtime.registerStackTransformation((args: ResourceTransformationArgs) => {
    if ("import" in args.opts && args.opts.import) {
      if (!args.opts.ignoreChanges) args.opts.ignoreChanges = [];
      args.opts.ignoreChanges.push("tags");
      args.opts.ignoreChanges.push("tagsAll");
    }
    return args;
  });
}

function addTransformationToCheckBucketsHaveMultiplePolicies() {
  const bucketsWithPolicy: Record<string, string> = {};
  runtime.registerStackTransformation((args: ResourceTransformationArgs) => {
    if (args.type !== "aws:s3/bucketPolicy:BucketPolicy") return;

    output(args.props.bucket).apply((bucket: string) => {
      if (bucketsWithPolicy[bucket])
        throw new VisibleError(
          `Cannot add bucket policy "${args.name}" to the AWS S3 Bucket "${bucket}". The bucket already has a policy attached "${bucketsWithPolicy[bucket]}".`,
        );

      bucketsWithPolicy[bucket] = args.name;
    });

    return undefined;
  });
}
