import { CustomResourceOptions, Input, Output, dynamic } from "@pulumi/pulumi";
import { rpc } from "../../../../../../src/components/rpc/rpc.js";
import { DEFAULT_ACCOUNT_ID } from "../../../../../../src/components/cloudflare/account-id";

export interface WorkerAssetsInputs {
  directory: Input<string>;
  scriptName: Input<string>;
  manifest: Input<
    Record<string, { hash: string; size: number; contentType: string }>
  >;
  accountId?: Input<string>;
}

export interface WorkerAssets {
  jwt: Output<string>;
  scriptName: Output<string>;
}

export class WorkerAssets extends dynamic.Resource {
  constructor(
    name: string,
    args: WorkerAssetsInputs,
    opts?: CustomResourceOptions,
  ) {
    super(
      new rpc.Provider("Cloudflare.WorkerAssets"),
      `${name}.sst.cloudflare.WorkerAssets`,
      {
        ...args,
        jwt: undefined,
        accountId: args.accountId ?? DEFAULT_ACCOUNT_ID,
        // The CLI calls Cloudflare's API with its own credentials: inputs are
        // saved to the state.
        // always trigger an update b/c a new completion token is required
        timestamp: Date.now(),
      },
      opts,
    );
  }
}
