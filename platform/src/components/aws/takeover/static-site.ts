import { takeover } from "../../takeover";
import { StaticSite } from "../v5/static-site";
import { sstResource } from "./helpers";

takeover(StaticSite, {
  // The site's files and its entries in the key-value store were SST's own
  // dynamic resources
  released: {
    assetFiles: (_, { name }) =>
      sstResource("BucketFiles", { name: `${name}AssetFiles` }),
    kvKeys: (_, { name }) => sstResource("KvKeys", { name: `${name}KvKeys` }),
  },
});
