import * as pulumi from "@pulumi/pulumi";
import {
  type Input,
  type Output,
  ProviderResource,
  type Resource,
  secret,
} from "@pulumi/pulumi";
import { underCore } from "./context";
import { sstPackage } from "./sst-package";
import { VisibleError } from "./error";
import { perRun } from "../util/lazy";

/**
 * Where Pulumi downloads the provider SST's own resources run on: this repo's
 * GitHub releases, which have a `pulumi-resource-sst` archive for each
 * platform. The repo is the one `pkg/global/distribution.go` releases from.
 */
export const pluginDownloadURL = "github://api.github.com/sst-community/sst";

/**
 * The options SST's own resources and functions are registered with, for the
 * provider the `sst` binary serves.
 *
 * Under SST's CLI they're as given: Pulumi finds the provider from the CLI's
 * work folder, and a stage's state names no version. Under a program Pulumi
 * runs on its own, they name the `sst` package's version and where its
 * release is, so Pulumi downloads the plugin as it does any third party's,
 * and the state keeps both, for a `pulumi destroy` without SST installed.
 */
export function withPlugin<
  T extends { version?: string; pluginDownloadURL?: string },
>(opts?: T): T | undefined {
  if (underCore()) return opts;
  const pkg = sstPackage();
  if (!pkg) return opts;
  return {
    ...opts,
    version: opts?.version ?? pkg.version,
    pluginDownloadURL: opts?.pluginDownloadURL ?? pluginDownloadURL,
  } as T;
}

/**
 * The options SST's own AWS resources and functions are registered with.
 *
 * Under SST's CLI they're as given (`withPlugin`): the CLI gives the provider
 * the stage's AWS setup in its environment. A program Pulumi runs on its own
 * has no CLI to, so they're given an SST provider of their own for the AWS
 * provider their component uses, whose config names that provider's profile,
 * region and roles (pkg/provider/aws.go). Both then reach the same account,
 * with the same credentials. One is made for each AWS provider.
 */
export function withAwsPlugin<T extends PluginOptions>(
  opts?: T,
): T | undefined {
  return withSetup("aws", opts);
}

/**
 * The options SST's own Cloudflare resources are registered with, as
 * `withAwsPlugin` for AWS: under SST's CLI as given, as the CLI gives the
 * provider its credentials in its environment, and in a program Pulumi runs
 * on its own, an SST provider whose config has the credentials of the
 * Cloudflare provider their component uses (pkg/provider/cloudflare.go), kept
 * in the state as a secret, as Pulumi keeps that provider's own.
 */
export function withCloudflarePlugin<T extends PluginOptions>(
  opts?: T,
): T | undefined {
  return withSetup("cloudflare", opts);
}

/**
 * The options SST's own Vercel resources are registered with, as
 * `withCloudflarePlugin` for Cloudflare.
 */
export function withVercelPlugin<T extends PluginOptions>(
  opts?: T,
): T | undefined {
  return withSetup("vercel", opts);
}

type PluginOptions = {
  parent?: Resource;
  provider?: ProviderResource;
  version?: string;
  pluginDownloadURL?: string;
};

// The clouds SST's provider takes a setup for
type Cloud = "aws" | "cloudflare" | "vercel";

function withSetup<T extends PluginOptions>(
  cloud: Cloud,
  opts?: T,
): T | undefined {
  if (underCore() || !sstPackage() || opts?.provider) return withPlugin(opts);
  return {
    ...opts,
    provider: sstProvider(cloud, opts?.parent?.getProvider(`${cloud}::`)),
  } as T;
}

// SST's provider, as one of the program's own: Pulumi's class for it is
// abstract
class SstProvider extends ProviderResource {
  constructor(
    name: string,
    props: Record<string, Input<string | undefined>>,
    opts: pulumi.ResourceOptions,
  ) {
    super("sst", name, props, opts);
  }
}

// The SST provider made for each provider of a cloud in this run, the
// stack's default one under undefined
const providers = perRun(() => ({
  made: new Map<string, Map<ProviderResource | undefined, ProviderResource>>(),
  names: new Set<string>(),
}));

function sstProvider(cloud: Cloud, given: ProviderResource | undefined) {
  const { made, names } = providers();
  const ofCloud = made.get(cloud) ?? new Map();
  made.set(cloud, ofCloud);
  const found = ofCloud.get(given);
  if (found) return found;
  // Named after the provider, as a stack's provider names are its own. The
  // stack's default AWS one is `sst`, as it was before SST's provider took
  // other clouds' setups.
  const base = given
    ? `sst-${(given as { __name?: string }).__name}`
    : cloud === "aws"
      ? "sst"
      : `sst-${cloud}`;
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
  names.add(name);
  const pkg = sstPackage()!;
  const region = given && stackCopies.get(given);
  const setup = {
    aws: () =>
      !given
        ? stackSetup()
        : region
          ? { ...stackSetup(), awsRegion: region }
          : explicitSetup(given),
    cloudflare: () => cloudflareSetup(given),
    vercel: () => vercelSetup(given),
  }[cloud]();
  const provider = new SstProvider(name, setup, {
    version: pkg.version,
    pluginDownloadURL,
  });
  ofCloud.set(given, provider);
  return provider;
}

// The AWS providers SST's components make from the stack's config for
// another region (useProvider), by their region: SST's provider for one is
// set up as the stack's is, roles and all, in that region
const stackCopies = new WeakMap<ProviderResource, string>();

/**
 * Says an AWS provider is the stack's, as its config sets it up, for another
 * region, so SST's provider for it is too.
 *
 * @internal
 */
export function madeFromStack(provider: ProviderResource, region: string) {
  stackCopies.set(provider, region);
}

// An AWS provider of the program's: its profile and region. Its roles aren't
// among its outputs, so SST's provider can't take them.
function explicitSetup(
  aws: ProviderResource,
): Record<string, Input<string | undefined>> {
  const { profile, region } = aws as {
    profile?: Output<string | undefined>;
    region?: Output<string | undefined>;
  };
  return {
    ...(profile ? { awsProfile: profile } : {}),
    ...(region ? { awsRegion: region } : {}),
  };
}

// The stack's default AWS provider, as its config sets it up: aws:profile,
// aws:region and the roles in aws:assumeRoles or the older aws:assumeRole, as
// sst dev reads them for a Pulumi program (pkg/pulumidev). A secret one isn't
// read: SST's provider's config is kept in the state as it is.
function stackSetup(): Record<string, string> {
  const config = new pulumi.Config("aws");
  for (const key of ["profile", "region", "assumeRoles", "assumeRole"]) {
    if (config.get(key) !== undefined && isSecret(`aws:${key}`))
      throw new VisibleError(
        `SST's components set up SST's provider as the stack's config sets up the AWS provider, and the stack's aws:${key} is a secret, which isn't read.`,
      );
  }
  type Role = { roleArn?: string; sessionName?: string; externalId?: string };
  const listed = config.getObject<Role[]>("assumeRoles");
  const one = config.getObject<Role>("assumeRole");
  const roles = (listed ?? (one ? [one] : [])).filter((role) => role.roleArn);
  for (const role of roles)
    if (role.externalId)
      throw new VisibleError(
        `SST's components can't take a role with an external ID yet, as the stack's aws:assumeRoles asks for ${role.roleArn}.`,
      );
  const profile = config.get("profile");
  const region = config.get("region");
  return {
    ...(profile ? { awsProfile: profile } : {}),
    ...(region ? { awsRegion: region } : {}),
    ...(roles.length > 0
      ? {
          awsAssumeRoles: JSON.stringify(
            roles.map(({ roleArn, sessionName }) => ({ roleArn, sessionName })),
          ),
        }
      : {}),
  };
}

// Whether a key of the stack's config is a secret, which Config.get gives as
// plain text without a word. The SDK has isConfigSecret, which it doesn't
// declare.
function isSecret(key: string): boolean {
  const check = (
    pulumi.runtime as { isConfigSecret?: (key: string) => boolean }
  ).isConfigSecret;
  return check?.(key) ?? false;
}

// The credentials of a Cloudflare provider of the program's, or of the stack's
// default one as its config sets it up, as secrets. With none, SST's provider
// reads the environment's, as Pulumi's does.
function cloudflareSetup(
  given: ProviderResource | undefined,
): Record<string, Input<string | undefined>> {
  if (given) {
    const { apiToken, apiKey, email } = given as {
      apiToken?: Output<string | undefined>;
      apiKey?: Output<string | undefined>;
      email?: Output<string | undefined>;
    };
    return {
      ...(apiToken ? { cloudflareApiToken: secret(apiToken) } : {}),
      ...(apiKey ? { cloudflareApiKey: secret(apiKey) } : {}),
      ...(email ? { cloudflareEmail: email } : {}),
    };
  }
  const config = new pulumi.Config("cloudflare");
  const apiToken = config.getSecret("apiToken");
  const apiKey = config.getSecret("apiKey");
  const email = config.get("email");
  return {
    ...(apiToken ? { cloudflareApiToken: apiToken } : {}),
    ...(apiKey ? { cloudflareApiKey: apiKey } : {}),
    ...(email ? { cloudflareEmail: email } : {}),
  };
}

// The token of a Vercel provider of the program's, or of the stack's default
// one, as a secret. With none, SST's provider reads VERCEL_API_TOKEN.
function vercelSetup(
  given: ProviderResource | undefined,
): Record<string, Input<string | undefined>> {
  const apiToken = given
    ? (given as { apiToken?: Output<string | undefined> }).apiToken
    : new pulumi.Config("vercel").getSecret("apiToken");
  return apiToken ? { vercelApiToken: secret(apiToken) } : {};
}
