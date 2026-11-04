import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  type ComponentResourceOptions,
  Output,
  all,
  interpolate,
  jsonStringify,
  output,
} from "@pulumi/pulumi";
import * as cf from "@pulumi/cloudflare";
import { iam } from "@pulumi/aws";
import type { Loader } from "esbuild";
import type { EsbuildOptions } from "../../esbuild";
import {
  type ComponentArgs,
  component,
  many,
  named,
  optional,
} from "../../parts-component";
import type { Input } from "../../input";
import { Link } from "../../link";
import type { Permission } from "../../aws/permission";
import { notAnExistingPart, plain, withoutDependencies } from "../../args";
import { VisibleError } from "../../error";
import { context } from "../../contract";
import { rpc } from "../../rpc/rpc";
import { prefixName } from "../../naming";
import { binding, type BindingInclude } from "../binding";
import { DEFAULT_ACCOUNT_ID } from "../account-id";
import { normalizeCompatibility } from "../helpers/compatibility";
import { cfFetch } from "../helpers/fetch";
import { zoneOf } from "../helpers/zone";
import { WorkerUrl } from "../resources/worker-url";
import { WorkerPlacement } from "../resources/worker-placement";

const parts = {
  /**
   * The Cloudflare Worker script.
   */
  worker: named(cf.WorkersScript, "Script"),
  /**
   * Turns the Worker's `workers.dev` URL on or off, as `url` says.
   */
  url: WorkerUrl,
  /**
   * The Worker's placement, when `placement` is set.
   */
  placement: optional(WorkerPlacement),
  /**
   * The Worker's custom domain, when `domain` is set.
   */
  domain: optional(cf.WorkersCustomDomain),
  /**
   * A custom domain for each of the domain's `aliases`, by domain.
   */
  alias: many(cf.WorkersCustomDomain),
  /**
   * A DNS record for each of the domain's `redirects`, by domain.
   */
  redirectRecord: many(cf.DnsRecord),
  /**
   * The page rule that redirects each of the domain's `redirects` to its
   * `name`, by domain.
   */
  redirectRule: many(cf.PageRule),
  /**
   * The IAM user the Worker calls AWS as, when it's linked to something in
   * AWS.
   */
  awsUser: optional(iam.User),
  /**
   * The IAM user's policy, with what the Worker's links allow.
   */
  awsPolicy: optional(iam.UserPolicy),
  /**
   * The IAM user's access key, which the Worker is given.
   */
  awsCredentials: optional(iam.AccessKey),
};

export interface WorkerDurableObjectMigration {
  /**
   * A unique identifier for this migration.
   */
  tag: Input<string>;
  /**
   * New Durable Object classes backed by the legacy KV storage backend.
   */
  newClasses?: Input<Input<string>[]>;
  /**
   * New Durable Object classes backed by the SQLite storage backend.
   */
  newSqliteClasses?: Input<Input<string>[]>;
  /**
   * Durable Object classes to delete.
   */
  deletedClasses?: Input<Input<string>[]>;
  /**
   * Durable Object classes to rename.
   */
  renamedClasses?: Input<
    Input<{
      from: Input<string>;
      to: Input<string>;
    }>[]
  >;
  /**
   * Durable Object classes to transfer from another script.
   */
  transferredClasses?: Input<
    Input<{
      from: Input<string>;
      fromScript: Input<string>;
      to: Input<string>;
    }>[]
  >;
}

export interface WorkerDomainArgs {
  /**
   * The custom domain you want to use.
   *
   * @example
   * ```js
   * {
   *   domain: {
   *     name: "example.com"
   *   }
   * }
   * ```
   */
  name: Input<string>;
  /**
   * Alternate domains to be used. Visitors to the alternate domains will be redirected to the
   * main `name`.
   *
   * :::note
   * Unlike the `aliases` option, this will redirect visitors back to the main `name`.
   * :::
   *
   * @example
   * Use this to create a `www.` version of your domain and redirect visitors to the apex domain.
   * ```js {4}
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  redirects?: string[];
  /**
   * Alias domains that should be used. Unlike the `redirects` option, this keeps your visitors
   * on this alias domain.
   *
   * @example
   * So if your users visit `app2.domain.com`, they will stay on `app2.domain.com` in their
   * browser.
   * ```js {4}
   * {
   *   domain: {
   *     name: "app1.domain.com",
   *     aliases: ["app2.domain.com"]
   *   }
   * }
   * ```
   */
  aliases?: string[];
}

export interface WorkerArgs extends ComponentArgs<typeof parts> {
  /**
   * Path to the handler file for the worker.
   *
   * The handler path is relative to the root your repo or the `sst.config.ts`.
   *
   * @example
   *
   * ```js
   * {
   *   handler: "packages/functions/src/worker.ts"
   * }
   * ```
   */
  handler: Input<string>;
  /**
   * Enable a dedicated endpoint for your Worker.
   * @default `false`
   */
  url?: Input<boolean>;
  /**
   * Set a custom domain for your Worker. Supports domains hosted on Cloudflare.
   *
   * :::tip
   * You can migrate an externally hosted domain to Cloudflare by
   * [following this guide](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
   * :::
   *
   * A domain given as an object is a plain value, not an output: each of
   * its `aliases` and `redirects` creates resources of its own. Its `name`
   * can be an output, and so can a domain given as a string.
   *
   * @example
   *
   * ```js
   * {
   *   domain: "domain.com"
   * }
   * ```
   *
   * You can also redirect alternate domains to the main domain.
   *
   * ```js
   * {
   *   domain: {
   *     name: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   *
   * Or keep visitors on alternate domains with aliases.
   *
   * ```js
   * {
   *   domain: {
   *     name: "app1.domain.com",
   *     aliases: ["app2.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: Input<string> | WorkerDomainArgs;
  /**
   * Configure how your function is bundled.
   *
   * SST bundles your worker code using [esbuild](https://esbuild.github.io/). This tree shakes your code to only include what's used.
   */
  build?: Input<{
    /**
     * Configure additional esbuild loaders for other file extensions. This is useful
     * when your code is importing non-JS files like `.png`, `.css`, etc.
     *
     * @example
     * ```js
     * {
     *   build: {
     *     loader: {
     *      ".png": "file"
     *     }
     *   }
     * }
     * ```
     */
    loader?: Input<Record<string, Loader>>;
    /**
     * Use this to insert a string at the beginning of the generated JS file.
     *
     * @example
     * ```js
     * {
     *   build: {
     *     banner: "console.log('Function starting')"
     *   }
     * }
     * ```
     */
    banner?: Input<string>;
    /**
     * This allows you to customize esbuild config that is used.
     *
     * :::tip
     * Check out the _JS tab_ in the code snippets in the esbuild docs for the
     * [`BuildOptions`](https://esbuild.github.io/api/#build).
     * :::
     *
     */
    esbuild?: Input<EsbuildOptions>;
    /**
     * Disable if the worker code should be minified when bundled.
     *
     * @default `true`
     *
     * @example
     * ```js
     * {
     *   build: {
     *     minify: false
     *   }
     * }
     * ```
     */
    minify?: Input<boolean>;
  }>;
  /**
   * Configure Cloudflare compatibility for the Worker.
   */
  compatibility?: Input<{
    /**
     * The Cloudflare compatibility date for the Worker.
     *
     * SST uses this for both the uploaded Worker and for deciding which native
     * Node.js modules should stay external during bundling.
     *
     * @default `"2025-05-05"`
     */
    date?: Input<string>;
    /**
     * The Cloudflare compatibility flags for the Worker.
     *
     * SST uses this for both the uploaded Worker and for deciding which native
     * Node.js modules should stay external during bundling.
     *
     * @default `["nodejs_compat"]`
     */
    flags?: Input<Input<string>[]>;
  }>;
  /**
   * [Link resources](/docs/linking/) to your worker. This will:
   *
   * 1. Handle the credentials needed to access the resources.
   * 2. Allow you to access it in your site using the [SDK](/docs/reference/sdk/).
   *
   * A link to something in AWS gives the Worker an IAM user to call it as, so
   * the list is a plain value, not an output.
   *
   * @example
   *
   * Takes a list of components to link to the function.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: any[];
  /**
   * Key-value pairs that are set as [Worker environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/).
   *
   * They can be accessed in your worker through `env.<key>`.
   *
   * @example
   *
   * ```js
   * {
   *   environment: {
   *     DEBUG: "true"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Durable Object migrations for this worker.
   *
   * This follows Wrangler's top-level `migrations` config. Keep the full,
   * ordered migration history here; SST reads the Worker's current migration
   * tag and uploads the pending migrations as Cloudflare's `oldTag`, `newTag`,
   * and `steps` payload. If there is no current tag, SST uploads the full
   * history as the initial migration payload. If the current tag is not in the
   * configured history, SST follows Wrangler and uploads all configured
   * migrations with the current tag as `oldTag`.
   *
   * Each migration needs a unique `tag`. Add a migration when you create,
   * rename, delete, or transfer a Durable Object class. Updating code for an
   * existing class does not require one.
   *
   * On the first deploy, add each new class with `newSqliteClasses`. For a
   * rename, keep the original migration and append a new migration with
   * `renamedClasses`. Do not declare the renamed class as a new class, or
   * Cloudflare will reject the deploy or create a separate namespace.
   *
   * @example
   * ```ts
   * {
   *   migrations: [{
   *     tag: "v1",
   *     newSqliteClasses: ["Counter"]
   *   }]
   * }
   * ```
   *
   * @example
   * ```ts
   * {
   *   migrations: [
   *     {
   *       tag: "v1",
   *       newSqliteClasses: ["Counter"],
   *     },
   *     {
   *       tag: "v2",
   *       renamedClasses: [{ from: "Counter", to: "CounterV2" }],
   *     },
   *   ]
   * }
   * ```
   */
  migrations?: Input<Input<WorkerDurableObjectMigration>[]>;
  /** @internal */
  assets?: Input<{
    directory: Input<string>;
    htmlHandling?: Input<
      | "auto-trailing-slash"
      | "force-trailing-slash"
      | "drop-trailing-slash"
      | "none"
    >;
    notFoundHandling?: Input<"404-page" | "single-page-application" | "none">;
    runWorkerFirst?: Input<boolean | Input<string>[]>;
  }>;
  /**
   * Configure [placement](https://developers.cloudflare.com/workers/configuration/placement/)
   * for your Worker.
   *
   * @example
   *
   * #### Smart Placement
   * ```js
   * {
   *   placement: {
   *     mode: "smart"
   *   }
   * }
   * ```
   *
   * #### Explicit region
   * ```js
   * {
   *   placement: {
   *     region: "aws:us-east-1"
   *   }
   * }
   * ```
   */
  placement?: Input<{
    mode?: Input<string>;
    region?: Input<string>;
    host?: Input<string>;
    hostname?: Input<string>;
  }>;
  /**
   * The Cloudflare account ID to use for this Worker and all its sub-resources.
   * Overrides the default account ID set via `CLOUDFLARE_DEFAULT_ACCOUNT_ID`.
   * @internal
   */
  accountId?: Input<string>;
  /**
   * Whether the Worker runs in `sst dev`, for a component that runs it some
   * other way.
   * @internal
   */
  dev?: boolean;
}

// The binding type Cloudflare's API gives each of SST's binding kinds
const BINDING_TYPES: Record<BindingInclude["binding"], string> = {
  aiBindings: "ai",
  plainTextBindings: "plain_text",
  secretTextBindings: "secret_text",
  queueBindings: "queue",
  serviceBindings: "service",
  durableObjectNamespaceBindings: "durable_object_namespace",
  kvNamespaceBindings: "kv_namespace",
  d1DatabaseBindings: "d1",
  r2BucketBindings: "r2_bucket",
  hyperdriveBindings: "hyperdrive",
  versionMetadataBindings: "version_metadata",
  workflowBindings: "workflow",
  rateLimitBindings: "ratelimit",
};

/**
 * Check a Worker's `domain`, for what it's given for: an output is the
 * domain's name, which is one custom domain whatever it is, and an object is
 * a plain value, as each of its aliases and redirects creates resources of
 * its own. Its `name` can be an output. A site checks the domain it gives its
 * Worker this way, so a mistake is said of the site.
 *
 * @param owner The component, in messages: `the "Api" Worker`.
 * @internal
 */
export function checkDomain(
  given: WorkerArgs["domain"],
  owner: string,
): WorkerArgs["domain"] {
  if (Output.isInstance(given) || given instanceof Promise)
    return output(given).apply((domain: unknown) => {
      if (typeof domain === "string" && domain) return domain;
      throw new VisibleError(
        `The "domain" of ${owner} is an output that isn't a domain's name. A domain given as an object has to be a plain value, since its aliases and redirects each create resources; its "name" can be an output.`,
      );
    });
  if (given && typeof given === "object" && "name" in given)
    for (const list of ["aliases", "redirects"] as const)
      plain(
        given[list],
        `The "domain.${list}" of ${owner}`,
        "Each one's resources are named after it, so they're known before they're created.",
      )?.forEach((hostname) =>
        plain(
          hostname,
          `Each of the "domain.${list}" of ${owner}`,
          "Each one's resources are named after it, so they're known before they're created.",
        ),
      );
  return given;
}

/**
 * The `Worker` component lets you create a Cloudflare Worker.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "src/worker.handler"
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to the Worker. This will handle the credentials
 * and allow you to access it in your handler.
 *
 * ```ts {5} title="sst.config.ts"
 * const bucket = new sst.aws.v5.Bucket("MyBucket");
 *
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "src/worker.handler",
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your handler.
 *
 * ```ts title="src/worker.ts" {3}
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 *
 * #### Enable URLs
 *
 * Enable worker URLs to invoke the worker over HTTP.
 *
 * ```ts {3} title="sst.config.ts"
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "src/worker.handler",
 *   url: true
 * });
 * ```
 *
 * #### Bundling
 *
 * Customize how SST uses [esbuild](https://esbuild.github.io/) to bundle your worker code with the `build` property.
 *
 * ```ts title="sst.config.ts" {3-5}
 * new sst.cloudflare.v5.Worker("MyWorker", {
 *   handler: "src/worker.handler",
 *   build: {
 *     minify: false
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.cloudflare.Worker`
 *
 * Change `sst.cloudflare.Worker` to `sst.cloudflare.v5.Worker` and keep the
 * name. The Worker and everything it created are kept. Its `workers.dev`
 * URL and its placement are set again by resources of a new type, which the
 * `sst` binary serves, and `sst migrate` takes SST 4's out of the state.
 *
 * - `link` is a plain value, not an output: a link to something in AWS gives
 *   the Worker an IAM user. Each link's values can still be outputs.
 * - `domain` given as an object is a plain value, not an output: its
 *   `aliases` and `redirects` each create resources. Its `name` can still be
 *   an output, and so can a domain given as a string.
 * - Each of the domain's `aliases` and `redirects` is kept by its domain, not
 *   by its place in the list, so reordering them replaces nothing. Each is a
 *   string, not an output. On the switch, each is matched to the one SST 4
 *   had at its place in the list: switch first, then reorder them.
 * - The zone of each domain is found with Cloudflare's provider. SST 4
 *   looked it up with a resource of its own, `ZoneLookup`, which a switch
 *   takes out of the state; nothing changes in Cloudflare.
 * - A domain's zone is the longest zone in the account that the domain ends
 *   with. SST 4 took the first one Cloudflare listed that it ends with, so in
 *   an account with both `example.com` and `sub.example.com`, a domain under
 *   `sub.example.com` can be in another zone now. `sst migrate --check` shows
 *   that as a replace of its custom domain, DNS record or page rule.
 * - The IAM user, policy and access key a link to AWS gives it are created
 *   directly. A `transform` for them is given outputs where SST 4 gave plain
 *   values. You can change them in `transform` now: `awsUser`, `awsPolicy`,
 *   `awsCredentials`.
 * - `transform` takes each resource it creates, like `domain` and `url`, next
 *   to `worker`.
 */
export class Worker extends component("sst:cloudflare:Worker", parts) {
  constructor(
    name: string,
    args: WorkerArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const self = this;
    const owner = `the "${name}" Worker`;
    // A Worker builds its code, and creates the rest from its args
    for (const key of Object.keys(args.existing ?? {}))
      notAnExistingPart(
        args.existing,
        key,
        owner,
        key === "worker"
          ? "A Worker builds its own code, so it can't use a script you have. To call another Worker of your app, link it. A script outside the app can't be put in place of a Worker."
          : `A Worker creates it from its args. Change how it's created in "transform.${key}".`,
      );
    const accountId = args.accountId ?? DEFAULT_ACCOUNT_ID;
    const dev = context().dev && args.dev !== false;
    const compatibility = normalizeCompatibility(args);
    const domain = domainOf();
    this.hostnames = {
      alias: domain?.alias ?? [],
      redirect: domain?.redirect ?? [],
    };
    const links = linksOf();

    const buildInput = all([args.handler, args.build, compatibility]).apply(
      ([handler, build, compatibility]) => ({
        functionID: name,
        links: {},
        handler,
        runtime: "worker",
        properties: { accountID: accountId, build, compatibility },
      }),
    );
    const build = buildInput.apply(async (input) => {
      const result = await rpc.call<{
        handler: string;
        out: string;
        errors: string[];
      }>("Runtime.Build", input);
      if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
      return result;
    });

    const credentials = awsCredentials();
    const script = createScript();
    const workerUrl = this.part("url", {
      accountId,
      scriptName: script.scriptName,
      enabled: output(args.url).apply((url) => url ?? false),
      etag: script.etag,
    });
    if (args.placement) {
      // Read field by field: `placement` can be an output
      const placement = output(args.placement);
      this.part("placement", {
        accountId,
        scriptName: script.scriptName,
        // Applied again after each update of the script. A Worker with
        // assets can have its settings rewritten, placement included.
        etag: script.etag,
        mode: placement.apply((placement) => placement.mode),
        region: placement.apply((placement) => placement.region),
        host: placement.apply((placement) => placement.host),
        hostname: placement.apply((placement) => placement.hostname),
      });
    }
    const customDomain = createDomains();
    this.endpoint = customDomain
      ? interpolate`https://${customDomain.hostname}`
      : workerUrl.url.apply((url) => (url ? `https://${url}` : url));

    if (dev)
      all([buildInput, script.scriptName]).apply(([input, scriptName]) =>
        rpc.call("Runtime.AddTarget", {
          ...input,
          properties: { ...input.properties, scriptName },
        }),
      );

    this.report({ function: { handler: args.handler } });
    this.registerOutputs({
      // What `sst dev` runs, as SST 4 writes it
      _live: dev
        ? all([args.handler, args.build, compatibility]).apply(
            ([handler, build, compatibility]) => ({
              functionID: name,
              links: [],
              handler,
              runtime: "worker",
              properties: {
                accountID: accountId,
                scriptName: script.scriptName,
                build,
                compatibility,
              },
            }),
          )
        : undefined,
    });

    function domainOf() {
      const given = checkDomain(args.domain, owner);
      if (!given) return;
      if (typeof given === "object" && "name" in given)
        return {
          name: given.name,
          alias: given.aliases ?? [],
          redirect: given.redirects ?? [],
        };
      return { name: given as Input<string>, alias: [], redirect: [] };
    }

    // The components the Worker is linked to, and what each gives it
    function linksOf() {
      const given = plain(
        args.link ?? [],
        `The "link" of ${owner}`,
        "A link to something in AWS gives the Worker an IAM user, so the list has to be known before the user is created.",
      );
      return given
        .map((link) => {
          if (!link)
            throw new VisibleError(
              `An undefined link was passed into the "link" of ${owner}.`,
            );
          return link;
        })
        .filter(Link.isLinkable)
        .map((link) => ({
          // The name is read from the component without waiting on it: a
          // Worker inside a component can be linked to that component
          name: withoutDependencies(output(link.urn)).apply(
            (urn) => urn.split("::").at(-1)!,
          ),
          definition: link.getSSTLink(),
        }));
    }

    function awsCredentials() {
      const permissions = links.flatMap(
        ({ definition }) =>
          (definition.include ?? []).filter(
            (include) => include.type === "aws.permission",
          ) as Permission[],
      );
      if (permissions.length === 0) return;

      const user = self.part("awsUser", { forceDestroy: true });
      self.part("awsPolicy", {
        user: user.name,
        policy: output(permissions).apply((permissions) =>
          JSON.stringify({
            Statement: permissions.map((p) => ({
              Effect: (() => {
                const effect = p.effect ?? "allow";
                return effect.charAt(0).toUpperCase() + effect.slice(1);
              })(),
              Action: p.actions,
              Resource: p.resources,
              ...("conditions" in p && p.conditions
                ? {
                    Condition: Object.fromEntries(
                      p.conditions.map((c) => [
                        c.test,
                        { [c.variable]: c.values },
                      ]),
                    ),
                  }
                : {}),
            })),
          }),
        ),
      });
      return self.part("awsCredentials", { user: user.name });
    }

    function bindings() {
      const app = context().app;
      // Read together, as SST 4 reads them: one of them that's secret, like
      // a secret's value, keeps them all secret in the state
      const linked = [
        {
          type: "plain_text",
          name: "SST_RESOURCE_App",
          text: jsonStringify({ name: app.name, stage: app.stage }),
        },
        ...links.map(({ name, definition }) => {
          const include = definition.include?.find(
            (include) => include.type === "cloudflare.binding",
          ) as BindingInclude | undefined;
          return include
            ? {
                type: BINDING_TYPES[include.binding],
                name,
                ...include.properties,
              }
            : {
                type: "secret_text",
                name: interpolate`SST_RESOURCE_${name}`,
                text: jsonStringify(definition.properties),
              };
        }),
      ];
      return all([args.environment, credentials, linked]).apply(
        ([environment, credentials, linked]) => [
          ...linked,
          ...(credentials
            ? [
                {
                  type: "plain_text",
                  name: "AWS_ACCESS_KEY_ID",
                  text: credentials.id,
                },
                {
                  type: "secret_text",
                  name: "AWS_SECRET_ACCESS_KEY",
                  text: credentials.secret,
                },
              ]
            : []),
          ...(args.assets ? [{ type: "assets", name: "ASSETS" }] : []),
          ...Object.entries(environment ?? {}).map(([key, value]) => ({
            type: "plain_text",
            name: key,
            text: value,
          })),
        ],
      ) as cf.WorkersScriptArgs["bindings"];
    }

    function createScript() {
      // workers.dev URLs fail above 54 chars when previews are enabled
      const scriptName = prefixName(54, `${name}Script`).toLowerCase();
      const contentFile = build.apply((build) =>
        path.join(build.out, build.handler),
      );
      const migrations = args.migrations
        ? migrationState(scriptName)
        : undefined;
      return self.part(
        "worker",
        {
          scriptName,
          mainModule: "placeholder",
          accountId,
          contentFile,
          contentSha256: contentFile.apply(async (file) =>
            crypto
              .createHash("sha256")
              .update(await fs.readFile(file, "utf-8"))
              .digest("hex"),
          ),
          compatibilityDate: compatibility.apply((value) => value.date),
          compatibilityFlags: compatibility.apply((value) => value.flags),
          ...(migrations
            ? {
                migrations: migrations.apply(
                  (state) => state.migrations,
                ) as Input<cf.types.input.WorkersScriptMigrations>,
                migrationTag: migrations.apply(
                  (state) => state.migrationTag,
                ) as Input<string>,
              }
            : {}),
          assets: args.assets ? assetsOf(args.assets) : undefined,
          bindings: bindings(),
        },
        { ignoreChanges: ["scriptName"] },
      );
    }

    // The migrations still to apply to the Worker's Durable Objects, from the
    // tag it has now, as Wrangler works them out
    function migrationState(scriptName: string) {
      return all([args.migrations!, accountId]).apply(
        async ([migrations, accountId]) => {
          const latest = migrations.at(-1);
          if (!latest)
            return { migrationTag: undefined, migrations: undefined };

          let currentTag: string | undefined;
          try {
            const published = await cfFetch<
              { id?: string; migration_tag?: string }[]
            >(`/accounts/${accountId}/workers/scripts`);
            currentTag = published.result.find(
              (script) => script.id === scriptName,
            )?.migration_tag;
          } catch (error) {
            const code =
              typeof error === "object" &&
              error !== null &&
              "errors" in error &&
              Array.isArray(error.errors) &&
              typeof error.errors[0]?.code === "number"
                ? error.errors[0].code
                : undefined;
            // Wrangler takes these to mean the script or its environment
            // isn't deployed yet, so it has no tag:
            // workers.api.error.service_not_found and environment_not_found
            if (code !== 10090 && code !== 10092) throw error;
          }

          if (currentTag) {
            const found = migrations.findIndex(
              (migration) => migration.tag === currentTag,
            );
            if (found === migrations.length - 1)
              return { migrationTag: currentTag, migrations: undefined };
            const pending =
              found === -1 ? migrations : migrations.slice(found + 1);
            return {
              migrationTag: currentTag,
              migrations: {
                oldTag: currentTag,
                newTag: latest.tag,
                steps: pending.map(({ tag: _tag, ...step }) => step),
              },
            };
          }

          return {
            migrationTag: "",
            migrations: {
              newTag: latest.tag,
              steps: migrations.map(({ tag: _tag, ...step }) => step),
            },
          };
        },
      );
    }

    function assetsOf(assets: NonNullable<WorkerArgs["assets"]>) {
      return output(assets).apply(async (assets) => {
        const directory = path.isAbsolute(assets.directory)
          ? assets.directory
          : path.join(context().paths.root, assets.directory);
        const read = (file: string) =>
          fs
            .readFile(path.join(directory, file), "utf-8")
            .catch(() => undefined);
        return {
          directory,
          config: {
            headers: await read("_headers"),
            redirects: await read("_redirects"),
            htmlHandling: assets.htmlHandling,
            notFoundHandling: assets.notFoundHandling,
            runWorkerFirst: assets.runWorkerFirst,
          },
        };
      });
    }

    function createDomains() {
      if (!domain) return;

      const customDomain = self.part("domain", {
        accountId,
        service: script.scriptName,
        hostname: domain.name,
        zoneId: zoneOf(domain.name, accountId, self).id,
        environment: "production",
      });

      for (const hostname of domain.alias)
        self.part("alias", hostname, {
          accountId,
          service: script.scriptName,
          hostname,
          zoneId: zoneOf(hostname, accountId, self).id,
          environment: "production",
        });

      domain.redirect.forEach((hostname, i) => {
        const zoneId = zoneOf(hostname, accountId, self).id;
        self.part("redirectRecord", hostname, {
          zoneId,
          name: hostname,
          type: "AAAA",
          content: "100::",
          proxied: true,
          ttl: 1,
        });
        self.part("redirectRule", hostname, {
          zoneId,
          target: `${hostname}/*`,
          priority: i + 1,
          status: "active",
          actions: {
            forwardingUrl: {
              statusCode: 301,
              url: interpolate`https://${domain.name}/$1`,
            },
          },
        });
      });

      return customDomain;
    }
  }

  private endpoint!: Output<string | undefined>;
  // The domain's aliases and redirects, by part, in the order they're given
  private hostnames!: { alias: string[]; redirect: string[] };

  /**
   * The Worker URL if `url` is enabled.
   */
  public get url() {
    return this.endpoint;
  }

  /**
   * When you link a worker, say WorkerA, to another worker, WorkerB; it automatically creates
   * a service binding between the workers. It allows WorkerA to call WorkerB without going
   * through a publicly-accessible URL.
   *
   * @example
   * ```ts title="index.ts" {3}
   * import { Resource } from "sst";
   *
   * await Resource.WorkerB.fetch(request);
   * ```
   *
   * Read more about [binding Workers](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
   *
   * @internal
   */
  public link() {
    return {
      properties: { url: this.url },
      include: [
        binding({
          type: "serviceBindings",
          properties: { service: this.nodes.worker.id },
        }),
      ],
    };
  }
}
