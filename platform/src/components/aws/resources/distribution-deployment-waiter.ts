import {
  CustomResource,
  CustomResourceOptions,
  Input,
  Output,
} from "@pulumi/pulumi";

export interface DistributionDeploymentWaiterArgs {
  distributionId: Input<string>;
  /** The distribution's etag: a new one waits again. */
  etag: Input<string>;
  /** Whether to wait, up to five minutes, for the distribution to deploy. */
  wait: Input<boolean>;
}

export interface DistributionDeploymentWaiter {
  /** Whether the distribution has deployed, or wasn't waited for. */
  isDone: Output<boolean>;
}

/**
 * Waits for a CloudFront distribution to deploy, when it's created and each
 * time the distribution changes. One of SST's own resources, which the `sst`
 * binary serves as a Pulumi provider.
 */
export class DistributionDeploymentWaiter extends CustomResource {
  constructor(
    name: string,
    args: DistributionDeploymentWaiterArgs,
    opts?: CustomResourceOptions,
  ) {
    super(
      "sst:aws:DistributionDeploymentWaiter",
      name,
      { ...args, isDone: undefined },
      opts,
    );
  }
}
