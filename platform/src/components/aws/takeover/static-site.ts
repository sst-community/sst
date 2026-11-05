import { sstResource, takeover } from "../../takeover";
import { StaticSite } from "../static-site";

takeover(StaticSite, {
  // The site's files, its entries in the key-value store, its route in the
  // router's list, its invalidation and its origin access control were SST's
  // own dynamic resources. The origin access control is adopted by its id:
  // a create would make a second one.
  released: {
    assetFiles: (_, { name }) =>
      sstResource("aws.BucketFiles", { name: `${name}AssetFiles` }),
    kvKeys: (_, { name }) =>
      sstResource("aws.KvKeys", { name: `${name}KvKeys` }),
    routesUpdate: (_, { name }) =>
      sstResource("aws.KvRoutesUpdate", { name: `${name}RoutesUpdate` }),
    invalidation: (_, { name }) =>
      sstResource("aws.DistributionInvalidation", {
        name: `${name}Invalidation`,
      }),
    accessControl: (_, { name }) =>
      sstResource("aws.OriginAccessControl", {
        name: `${name}S3AccessControl`,
      }),
  },
});
