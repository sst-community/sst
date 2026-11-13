import {
  ComponentResourceOptions,
  Input,
  Output,
  ProviderResource,
  output,
} from "@pulumi/pulumi";
import { ecr, getRegionOutput, s3 } from "@pulumi/aws";
import { type ComponentArgs, component, optional } from "../parts-component";
import { plain } from "../args";
import { VisibleError } from "../error";
import { checkDeclarable, declareStore } from "./helpers/bootstrap";

const parts = {
  /**
   * The bucket that keeps the functions' code and source maps, and the
   * MicroVMs' code. It's emptied when it's deleted.
   */
  bucket: s3.Bucket,
  /**
   * The repository that keeps the images built for functions, services and
   * tasks. It isn't created when `repository` is `false`. Its images are
   * deleted with it.
   */
  repository: optional(ecr.Repository),
};

export interface AssetsArgs extends ComponentArgs<typeof parts> {
  /**
   * Whether to create an image repository, for a function, service or task
   * built from a Dockerfile.
   *
   * @default `true`
   * @example
   * ```ts
   * {
   *   repository: false
   * }
   * ```
   */
  repository?: boolean;
}

/**
 * Where a store's bucket and repository come from, for `Assets.use()`.
 */
export interface AssetsUseArgs {
  /**
   * The name of the bucket the functions' code and source maps are kept in.
   * It has to be in their region.
   */
  bucket?: Input<string>;
  /**
   * The URL of the ECR repository built images are pushed to, like
   * `123456789012.dkr.ecr.us-east-1.amazonaws.com/images`. It has to be in
   * their region.
   */
  repository?: Input<string>;
}

/**
 * The `Assets` component is where SST's components keep what they deploy
 * from: a bucket for the functions' code, and a repository for the images
 * they build.
 *
 * A Pulumi program that uses SST's components declares one, before the
 * components that use it. An SST app doesn't need one: SST's CLI keeps its
 * code and images in SST's bootstrap of the account, which every app shares.
 * One that declares `Assets` keeps them there instead.
 *
 * They're deleted with the program, emptied first: what they keep is built
 * again on the next deploy. Pass `protect` to guard them, or `retainOnDelete`
 * to keep them.
 *
 * @example
 *
 * #### Declare it
 *
 * ```ts title="index.ts"
 * import { Assets, Function } from "sst/components/aws";
 *
 * new Assets("Assets");
 *
 * new Function("Api", { handler: "functions/api.handler" });
 * ```
 *
 * #### In another region
 *
 * A function's code is kept in its own region. For a component given a
 * provider for another region, declare assets with that provider too.
 *
 * ```ts title="index.ts"
 * const east = new aws.Provider("East", { region: "us-east-1" });
 *
 * new Assets("Assets");
 * new Assets("EastAssets", {}, { provider: east });
 * ```
 *
 * #### Without a repository
 *
 * ```ts title="index.ts"
 * new Assets("Assets", { repository: false });
 * ```
 *
 * #### Your own bucket and repository
 *
 * To keep them in a bucket and repository of your own, from this program or
 * another stack, point the components at them with `Assets.use()`.
 *
 * ```ts title="index.ts"
 * const infra = new pulumi.StackReference("acme/infra/prod");
 *
 * Assets.use({
 *   bucket: infra.getOutput("assetBucket"),
 *   repository: infra.getOutput("assetRepositoryUrl"),
 * });
 * ```
 */
export class Assets extends component("sst:aws:Assets", parts) {
  constructor(
    name: string,
    args: AssetsArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    const label = `Assets("${name}")`;
    checkDeclarable(label);

    // Pulumi passes `protect` from a component to its parts, and not
    // `retainOnDelete`, so it's passed here
    const keep =
      opts?.retainOnDelete === undefined
        ? undefined
        : { retainOnDelete: opts.retainOnDelete };
    const bucket = this.part("bucket", { forceDestroy: true }, keep);
    const repository =
      plain(args.repository, `The "repository" of ${label}`) === false
        ? undefined
        : this.part("repository", { forceDelete: true }, keep);

    declareStore({
      label,
      bucket: bucket.bucket,
      repositoryUrl: output(repository?.repositoryUrl),
      registryId: output(repository?.registryId),
      region: getRegionOutput({}, { parent: this }).region,
      provider: this.getProvider("aws::"),
      owned: true,
    });
  }

  /**
   * The name of the bucket.
   */
  public get bucketName() {
    return this.nodes.bucket.bucket;
  }

  /**
   * The URL of the image repository, unless `repository` is `false`.
   */
  public get repositoryUrl(): Output<string> | undefined {
    return this.nodes.repository?.repositoryUrl;
  }

  /**
   * Points SST's components at a bucket and repository of your own, in place
   * of declaring `Assets`. Each has to be in the region of the components
   * that use it: for a component given a provider for another region, call
   * it again with that provider.
   *
   * Under SST's CLI it works the same, in place of SST's bootstrap.
   *
   * Call it before the components that use them.
   *
   * @param store The bucket, the repository, or both.
   * @param opts The AWS provider of the region they're in. Defaults to the
   * program's.
   *
   * @example
   * ```ts title="index.ts"
   * const code = new aws.s3.Bucket("Code", { forceDestroy: true });
   * const images = new aws.ecr.Repository("Images", { forceDelete: true });
   *
   * Assets.use({ bucket: code.bucket, repository: images.repositoryUrl });
   * ```
   */
  public static use(
    store: AssetsUseArgs,
    opts: { provider?: ProviderResource } = {},
  ) {
    if (store.bucket === undefined && store.repository === undefined)
      throw new VisibleError(
        "Assets.use() takes a bucket, a repository, or both.",
      );
    const repositoryUrl = output(store.repository);
    // Two in a region have providers of their own, which tell them apart
    const provider = (opts.provider as { __name?: string } | undefined)?.__name;
    declareStore({
      label: provider
        ? `Assets.use() with the "${provider}" provider`
        : "Assets.use()",
      bucket: output(store.bucket),
      repositoryUrl,
      // The account the repository is in starts its URL
      registryId: repositoryUrl.apply((url) => url?.split(".")[0]),
      region: getRegionOutput({}, { provider: opts.provider }).region,
      provider: opts.provider,
      owned: false,
    });
  }
}
