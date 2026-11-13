import {
  type Input,
  type Output,
  type ProviderResource,
  type Resource,
  all,
  output,
} from "@pulumi/pulumi";
import { rpc } from "../../rpc/rpc";
import { underCore } from "../../context";
import { lazy, perRun } from "../../../util/lazy";
import { VisibleError } from "../../error";

interface BootstrapData {
  asset: string;
  assetEcrRegistryId: string;
  assetEcrUrl: string;
  state: string;
  appsyncHttp: string;
  appsyncRealtime: string;
}

export const bootstrap = {
  /**
   * SST's bootstrap in a region: its asset bucket and ECR repository, which
   * every app in the account shares. SST's CLI looks it up, and sets it up if
   * the region has none yet.
   *
   * Only under SST's CLI: a program Pulumi runs on its own declares where
   * its code and images are kept ({@link assetStore}).
   *
   * @param _component The component that uploads. SST 4's components, which
   * the tests load, give none.
   */
  async forRegion(
    region: string,
    _component?: Resource,
  ): Promise<BootstrapData> {
    return rpc.call("Provider.Aws.Bootstrap", { region });
  },
};

/** Where a component keeps its code and images in a region. */
export interface AssetStore {
  /**
   * Whether others may use what's kept in it: SST's bootstrap, which every
   * app and stage in the account shares, or a store the program points at
   * with `Assets.use()`, which can be another stack's. What a stage stops
   * using is kept in it, as another may use it. Known before the bucket's
   * name is, in a new stack's preview.
   */
  readonly shared: Output<boolean>;
  /**
   * Which store it is, to tell two apart: one the program declared, by its
   * place, or SST's bootstrap. Known in a new stack's preview too.
   */
  readonly which: Output<string>;
  /** The bucket, for code: a store without one is an error. */
  readonly bucket: Output<string>;
  /** The image repository, for images: a store without one is an error. */
  readonly repository: Output<{ url: string; registryId: string }>;
  /**
   * Where a function's source maps are kept. Under SST's CLI, in SST's
   * bootstrap whatever the store, as SST's Console reads them there, and
   * kept when they're deleted. Otherwise in the store, with the code.
   */
  readonly sourcemaps: { bucket: Output<string>; retained: boolean };
}

/** A store the program declared, with `Assets` or `Assets.use()`. */
export interface DeclaredStore {
  /** What it is, in messages: `Assets("Assets")` or `Assets.use()`. */
  label: string;
  bucket: Output<string | undefined>;
  repositoryUrl: Output<string | undefined>;
  registryId: Output<string | undefined>;
  /** The region it's in, which a component's own region is matched with. */
  region: Output<string>;
  /** The AWS provider it was declared with, for two in one region. */
  provider: ProviderResource | undefined;
  /**
   * Whether the stack makes it, as `Assets` does, so nothing else keeps
   * anything in it. One from `Assets.use()` can be another stack's.
   */
  owned: boolean;
}

// The stores the program declared in this run, and the first component that
// looked for one, after which none can be declared, so which store a
// component uses never depends on when a value resolves
const stores = perRun(() => ({
  declared: [] as DeclaredStore[],
  firstToAsk: undefined as string | undefined,
}));

/**
 * Declares a store, as `Assets` and `Assets.use()` do.
 *
 * @internal
 */
export function declareStore(store: DeclaredStore) {
  checkDeclarable(store.label);
  stores().declared.push(store);
}

/**
 * Fails if a component has already looked for the program's stores.
 *
 * @internal
 */
export function checkDeclarable(label: string) {
  const { firstToAsk } = stores();
  if (firstToAsk !== undefined)
    throw new VisibleError(
      `${label} comes after ${firstToAsk}, which keeps its code or images in the program's assets. Declare the assets before the components that use them.`,
    );
}

/**
 * Forgets the stores declared, for a new run of a program in the tests.
 *
 * @internal
 */
export function resetAssetStores() {
  const run = stores();
  run.declared.length = 0;
  run.firstToAsk = undefined;
}

/**
 * Where a component keeps its code and images: the store the program
 * declared for the component's region, or under SST's CLI, SST's bootstrap
 * when it declared none there.
 *
 * Called when the component is created, after which no store can be
 * declared. Which store, and its bucket and repository, are found only when
 * they're used, so a component that keeps nothing, like a service that runs
 * an image it's given, needs no store.
 *
 * @param component The component that keeps code or images.
 * @param what The component, in messages: `the "Api" function`.
 */
export function assetStore(component: Resource, what: string) {
  const run = stores();
  run.firstToAsk ??= what;
  const declared = [...run.declared];
  const provider = component.getProvider("aws::");
  return {
    /** The store in a region. */
    forRegion(region: Input<string>): AssetStore {
      // Which store: one the program declared, by its place in the list, or
      // SST's bootstrap. Found when it's first used, so one that's never
      // used is never looked for.
      const chosen = lazy(() =>
        all([region, all(declared.map((store) => store.region))]).apply(
          ([region, regions]) => {
            const here = declared.filter(
              (_, index) => regions[index] === region,
            );
            const store =
              here.length === 1
                ? here[0]
                : here.find((store) => store.provider === provider);
            if (here.length > 1 && !store)
              throw new VisibleError(
                `The program declares more than one assets in ${region}: ${here
                  .map((store) => store.label)
                  .join(
                    ", ",
                  )}. Give ${what} the provider of the one it keeps its code or images in.`,
              );
            if (store) return { region, index: declared.indexOf(store) };
            if (underCore()) return { region, index: -1 };
            if (declared.length === 0)
              throw new VisibleError(
                `There's nowhere to keep the code or images of ${what}. In a Pulumi program, SST's components keep them in the assets it declares: add \`new Assets("Assets")\` from "sst/components/aws" before the components that use it, or point \`Assets.use()\` at a bucket and repository of your own.`,
              );
            const elsewhere = [...new Set(regions)].join(", ");
            throw new VisibleError(
              `There's nowhere to keep the code or images of ${what} in ${region}: the program's assets are in ${elsewhere}. They have to be in a component's own region, so declare assets for ${region} too, with its provider, like \`new Assets("${regionName(
                region,
              )}Assets", {}, { provider })\`.`,
            );
          },
        ),
      );
      // One of what's in it, with what it is for messages. An output of a
      // declared store's resource keeps it, so what's kept in the bucket is
      // created after the bucket and deleted before it, and depends on it
      // alone.
      const field = (key: "bucket" | "repositoryUrl" | "registryId") =>
        chosen().apply(({ region, index }) => {
          if (index !== -1)
            return declared[index][key].apply((value) => ({
              label: declared[index].label,
              value,
            }));
          return output(bootstrap.forRegion(region, component)).apply(
            (data) => ({
              label: "SST's bootstrap",
              value: {
                bucket: data.asset,
                repositoryUrl: data.assetEcrUrl,
                registryId: data.assetEcrRegistryId,
              }[key] as string | undefined,
            }),
          );
        });
      let shared: Output<boolean> | undefined;
      let which: Output<string> | undefined;
      let bucket: Output<string> | undefined;
      let repository: Output<{ url: string; registryId: string }> | undefined;
      let sourcemaps: AssetStore["sourcemaps"] | undefined;
      return {
        get shared() {
          return (shared ??= chosen().apply(
            ({ index }) => index === -1 || !declared[index].owned,
          ));
        },
        get which() {
          return (which ??= chosen().apply(({ index }) =>
            index === -1 ? "SST's bootstrap" : declared[index].label,
          ));
        },
        get bucket() {
          return (bucket ??= field("bucket").apply(({ label, value }) => {
            if (value === undefined)
              throw new VisibleError(
                `${label} has no bucket, and ${what} keeps its code in one. Give it a bucket: \`Assets.use({ bucket, repository })\`.`,
              );
            return value;
          }));
        },
        get repository() {
          return (repository ??= all([
            field("repositoryUrl"),
            field("registryId"),
          ]).apply(([url, registryId]) => {
            if (url.value === undefined || registryId.value === undefined)
              throw new VisibleError(
                `${url.label} has no image repository, and ${what} keeps its images in one. Give it a repository: \`Assets.use({ bucket, repository })\`, or leave on the repository of \`Assets\`.`,
              );
            return { url: url.value, registryId: registryId.value };
          }));
        },
        get sourcemaps() {
          return (sourcemaps ??= underCore()
            ? {
                bucket: chosen().apply(({ region }) =>
                  bootstrap
                    .forRegion(region, component)
                    .then((data) => data.asset),
                ),
                retained: true,
              }
            : { bucket: this.bucket, retained: false });
        },
      };
    },
  };
}

// us-east-1 → UsEast1, for a name in a message
function regionName(region: string) {
  return region
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
