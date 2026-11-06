import { checkFlociRegion, isFlociPreflight } from "../../../floci/check";
import { rpc } from "../../rpc/rpc";

interface BootstrapData {
  asset: string;
  assetEcrRegistryId: string;
  assetEcrUrl: string;
  state: string;
  appsyncHttp: string;
  appsyncRealtime: string;
}

export const bootstrap = {
  forRegion(region: string): Promise<BootstrapData> {
    checkFlociRegion(region);
    if (isFlociPreflight())
      return Promise.resolve({
        asset: "sst-floci-preflight-assets",
        assetEcrRegistryId: "000000000000",
        assetEcrUrl:
          "000000000000.dkr.ecr.us-east-1.localhost.floci.io/sst-assets",
        state: "sst-floci-preflight-state",
        appsyncHttp: "",
        appsyncRealtime: "",
      });
    return rpc.call("Provider.Aws.Bootstrap", { region });
  },
};
