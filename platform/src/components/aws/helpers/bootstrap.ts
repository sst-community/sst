import { type Resource } from "@pulumi/pulumi";
import { ssm } from "@pulumi/aws";
import { rpc } from "../../rpc/rpc";
import { underCore } from "../../context";
import { VisibleError } from "../../error";

interface BootstrapData {
  asset: string;
  assetEcrRegistryId: string;
  assetEcrUrl: string;
  state: string;
  appsyncHttp: string;
  appsyncRealtime: string;
}

// Where SST's CLI keeps the bootstrap of a region (pkg/project/provider)
const parameter = "/sst/bootstrap";

export const bootstrap = {
  /**
   * SST's bootstrap in a region: its asset bucket and ECR repository, which
   * every app in the account shares.
   *
   * SST's CLI looks it up, and sets it up if the region has none yet. A
   * program Pulumi runs on its own reads it through the AWS provider the
   * component creates its parts with, so it needs no credentials of its own,
   * and uploads to the same bucket as SST's CLI does. It doesn't set it up.
   *
   * @param component The component that uploads, whose provider is used. SST
   * 4's components, which the tests load, don't give it, and only run under
   * SST's CLI.
   */
  async forRegion(
    region: string,
    component?: Resource,
  ): Promise<BootstrapData> {
    if (underCore()) return rpc.call("Provider.Aws.Bootstrap", { region });
    const found = await ssm
      .getParameter(
        { name: parameter, withDecryption: true },
        { parent: component },
      )
      .catch((error: Error) => {
        if (!String(error?.message).includes("ParameterNotFound")) throw error;
        throw new VisibleError(
          `SST's components keep code in SST's asset bucket, and this account has none in ${region} yet. SST's CLI makes it the first time it deploys to the region.`,
        );
      });
    return JSON.parse(found.value);
  },
};
