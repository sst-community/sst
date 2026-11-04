import { CustomResource, CustomResourceOptions, Input } from "@pulumi/pulumi";

export interface FunctionEnvironmentUpdateArgs {
  /** The name of the function. */
  functionName: Input<string>;
  /** The variables to add to its environment, or to change. */
  environment: Input<Record<string, Input<string>>>;
  /** The function's region. */
  region: Input<string>;
  /**
   * When the function was last changed: a change to the function writes its
   * own environment, so this one is written again after it.
   */
  functionLastModified: Input<string>;
}

/**
 * The `FunctionEnvironmentUpdate` resource is used by the `Function` component to add
 * variables to a function's environment after it's created, keeping the ones it has. It's
 * one of SST's own resources, which the `sst` binary serves as a Pulumi provider.
 *
 * :::note
 * This resource is not intended to be created directly.
 * :::
 *
 * You'll find it returned by the `addEnvironment` method of the `Function` component.
 */
export class FunctionEnvironmentUpdate extends CustomResource {
  constructor(
    name: string,
    args: FunctionEnvironmentUpdateArgs,
    opts?: CustomResourceOptions,
  ) {
    super("sst:aws:FunctionEnvironmentUpdate", name, { ...args }, opts);
  }
}
