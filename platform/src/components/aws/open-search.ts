import {
  ComponentResourceOptions,
  type Output,
  interpolate,
  jsonStringify,
  output,
} from "@pulumi/pulumi";
import { RandomPassword } from "@pulumi/random";
import { iam, opensearch, secretsmanager } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  named,
  optional,
} from "../parts-component";
import { plain, onlyExisting, getArgs } from "../args";
import { context } from "../contract";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { type SizeGbTb, toGBs } from "../size";
import {
  devValue,
  localPassword,
  localServerPane,
} from "./helpers/local-server";
import { secretField, tagOf } from "./helpers/secret";
import { parseOpenSearch } from "./helpers/arn";

const parts = {
  /**
   * The master user's password, generated when `password` isn't set.
   */
  password: optional(RandomPassword),
  /**
   * The Secrets Manager secret the master user's username and password are kept in. Not
   * created by `get`, which reads the password from the one the domain is tagged with, or
   * from the one given here.
   */
  secret: optional(secretsmanager.Secret),
  /**
   * The secret's value. Not created by `get`.
   */
  secretVersion: optional(secretsmanager.SecretVersion),
  /**
   * The OpenSearch domain.
   */
  domain: opensearch.Domain,
  /**
   * The OpenSearch domain policy. Not created by `get`.
   */
  policy: named(optional(opensearch.DomainPolicy), "DomainPolicy"),
};

export interface OpenSearchArgs extends ComponentArgs<typeof parts> {
  /**
   * The OpenSearch engine version. Check out the [available versions](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html#choosing-version).
   *
   * :::caution
   * Changing the version will cause the domain to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"OpenSearch_2.17"`
   * @example
   * ```js
   * {
   *   version: "OpenSearch_2.5"
   * }
   * ```
   */
  version?: Input<string>;
  /**
   * The username of the master user.
   *
   * :::danger
   * Changing the username will cause the domain to be destroyed and recreated.
   * :::
   *
   * @default `"admin"`
   * @example
   * ```js
   * {
   *   username: "admin"
   * }
   * ```
   */
  username?: Input<string>;
  /**
   * The password of the master user.
   * @default A random password is generated.
   * @example
   * ```js
   * {
   *   password: "^Passw0rd^"
   * }
   * ```
   *
   * Use [Secrets](/docs/component/secret) to manage the password.
   * ```js
   * {
   *   password: new sst.Secret("MyDomainPassword").value
   * }
   * ```
   *
   * Whether it's set decides whether a password is generated, so it has to be set or left
   * out, not given as an output that may be `undefined`.
   */
  password?: Input<string>;
  /**
   * The type of instance to use for the domain. Check out the [supported instance types](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-instance-types.html).
   *
   * :::caution
   * Changing the instance type will cause the domain to restart on the next `sst deploy`,
   * causing downtime. Learn more about [upgrading databases](/docs/upgrade-aws-databases/).
   * :::
   *
   * @default `"t3.small"`
   * @example
   * ```js
   * {
   *   instance: "m6g.large"
   * }
   * ```
   */
  instance?: Input<string>;
  /**
   * The storage limit for the domain.
   *
   * @default `"10 GB"`
   * @example
   * ```js
   * {
   *   storage: "100 GB"
   * }
   * ```
   */
  storage?: Input<SizeGbTb>;
  /**
   * Configure how this component works in `sst dev`.
   *
   * By default, your OpenSearch domain is deployed in `sst dev`. But if you want to
   * instead connect to a locally running OpenSearch, you can configure the `dev` prop.
   *
   * :::note
   * By default, this creates a new OpenSearch domain even in `sst dev`.
   * :::
   *
   * This will skip deploying an OpenSearch domain and link to the locally running
   * OpenSearch process instead. It has to be a plain value: it decides what's deployed.
   *
   * @example
   *
   * Setting the `dev` prop also means that any linked resources will connect to the right
   * instance both in `sst dev` and `sst deploy`.
   *
   * ```ts
   * {
   *   dev: {
   *     username: "admin",
   *     password: "Passw0rd!",
   *     url: "http://localhost:9200"
   *   }
   * }
   * ```
   */
  dev?: {
    /**
     * The URL of the local OpenSearch to connect to when running in dev.
     * @default `"http://localhost:9200"`
     */
    url?: Input<string>;
    /**
     * The username of the local OpenSearch to connect to when running in dev.
     * @default Inherit from the top-level [`username`](#username).
     */
    username?: Input<string>;
    /**
     * The password of the local OpenSearch to connect to when running in dev.
     * @default Inherit from the top-level [`password`](#password).
     */
    password?: Input<string>;
  };
}

/**
 * The `OpenSearch` component lets you add a deployed instance of OpenSearch, or an
 * OpenSearch _domain_ to your app using [Amazon OpenSearch Service](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html).
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create the instance
 *
 * ```js title="sst.config.ts"
 * const search = new sst.aws.OpenSearch("MySearch");
 * ```
 *
 * #### Link to a resource
 *
 * You can link your instance to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [search]
 * });
 * ```
 *
 * Once linked, you can connect to it from your function code.
 *
 * ```ts title="app/page.tsx" {1,5-9}
 * import { Resource } from "sst";
 * import { Client } from "@opensearch-project/opensearch";
 *
 * const client = new Client({
 *   node: Resource.MySearch.url,
 *   auth: {
 *     username: Resource.MySearch.username,
 *     password: Resource.MySearch.password
 *   }
 * });
 *
 * // Add a document
 * await client.index({
 *   index: "my-index",
 *   body: { message: "Hello world!" }
 * });
 *
 * // Search for documents
 * const result = await client.search({
 *   index: "my-index",
 *   body: { query: { match: { message: "world" } } }
 * });
 * ```
 *
 * #### Running locally
 *
 * By default, your OpenSearch domain is deployed in `sst dev`. But let's say you are
 * running OpenSearch locally.
 *
 * ```bash
 * docker run \
 *   --rm \
 *   -p 9200:9200 \
 *   -v $(pwd)/.sst/storage/opensearch:/usr/share/opensearch/data \
 *   -e discovery.type=single-node \
 *   -e plugins.security.disabled=true \
 *   -e OPENSEARCH_INITIAL_ADMIN_PASSWORD=^Passw0rd^ \
 *   opensearchproject/opensearch:2.17.0
 * ```
 *
 * You can connect to it in `sst dev` by configuring the `dev` prop.
 *
 * ```ts title="sst.config.ts" {3-5}
 * const opensearch = new sst.aws.OpenSearch("MyOpenSearch", {
 *   dev: {
 *     url: "http://localhost:9200",
 *     username: "admin",
 *     password: "^Passw0rd^"
 *   }
 * });
 * ```
 *
 * This will skip deploying an OpenSearch domain and link to the locally running
 * OpenSearch process instead.
 *
 * #### Switch from SST 4's `sst.aws.OpenSearch`
 *
 * Keep the name, and `sst migrate` moves it. The domain,
 * its policy, its password and the secret it's kept in are kept.
 *
 * A few things work differently:
 *
 * - With `dev` set, SST 4's `OpenSearch` created a component for the pane `sst dev`
 *   shows, in every deploy. SST 5's tells `sst dev` itself, so a deploy drops that
 *   component. It has nothing in AWS behind it. An empty local password is shown as
 *   "[no password]" in the pane.
 * - `nodes` has every resource. Reading one that isn't created in `sst dev` with `dev`
 *   set throws an error that says why, where SST 4's `OpenSearch` gave `undefined`.
 * - If you set `tags` on the domain with an object in `transform`, it keeps the tags SST
 *   sets next to yours. They're added back when you switch. SST 4's `OpenSearch`
 *   replaced them, which left `get` unable to find the domain's username and password.
 * - The same goes for the domain's other settings SST sets as objects: `clusterConfig`,
 *   `ebsOptions`, `advancedSecurityOptions`, `nodeToNodeEncryption`, `encryptAtRest` and
 *   `domainEndpointOptions`. One you set with an object in `transform` keeps what SST
 *   sets in it that you don't, where SST 4's `OpenSearch` replaced it whole. So a master
 *   user given by its ARN would get SST's username and password next to it: replace
 *   `advancedSecurityOptions` in a function, as
 *   `domain: (args) => { args.advancedSecurityOptions = { ... } }`.
 * - `get` takes the domain's name, or its ARN, which is the component's `id`.
 *   SST 4's `OpenSearch.get` was documented to take the `id`, but couldn't look a domain
 *   up by its ARN.
 * - `get` looks the domain up inside the component, with the component's `provider`.
 *   SST 4's `OpenSearch.get` looked it up at the top of your app, with your app's
 *   provider, so a switch takes that lookup out of the state, which changes nothing in
 *   AWS.
 *
 * ---
 *
 * ### Cost
 *
 * By default this component uses a _Single-AZ Deployment_, _On-Demand Instances_ of a
 * `t3.small.search` at $0.036 per hour. And 10GB of _General Purpose gp3 Storage_
 * at $0.122 per GB per month.
 *
 * That works out to $0.036 x 24 x 30 + $0.122 x 10 or **$27 per month**. Adjust this for
 * the `instance` type and the `storage` you are using.
 *
 * The above are rough estimates for _us-east-1_, check out the [OpenSearch Service pricing](https://aws.amazon.com/opensearch-service/pricing/)
 * for more details.
 */
export class OpenSearch extends component("sst:aws:OpenSearch", parts) {
  private readonly connection: {
    id: Output<string>;
    username: Output<string>;
    password: Output<string>;
    url: Output<string>;
  };

  constructor(
    name: string,
    args: OpenSearchArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);
    const self = this;

    const owner = `the "${name}" OpenSearch domain`;
    const username = output(args.username).apply((v) => v ?? "admin");

    // Given a domain that's already deployed, it uses the secret with its
    // password, and creates nothing else
    if (args.existing?.domain !== undefined)
      onlyExisting(args.existing, ["domain", "secret"], owner);

    // In `sst dev`, an OpenSearch on the user's machine stands in for the
    // domain. This is the only place the component handles dev mode.
    const dev = plain(args.dev, `The "dev" of ${owner}`);
    if (dev && context().dev) {
      this.runsLocally();
      this.connection = runLocally(dev);
      return;
    }

    // A domain that's already deployed
    const existing = this.existingPart("domain");
    if (existing) {
      this.connection = reference(existing);
      return;
    }

    const password = createPassword();
    const secret = this.part("secret", { recoveryWindowInDays: 0 });
    this.part("secretVersion", {
      secretId: secret.id,
      secretString: jsonStringify({ username, password }),
    });

    const domain = this.part("domain", {
      engineVersion: output(args.version).apply((v) => v ?? "OpenSearch_2.17"),
      clusterConfig: {
        instanceType: interpolate`${output(args.instance).apply(
          (v) => v ?? "t3.small",
        )}.search`,
        instanceCount: 1,
        dedicatedMasterEnabled: false,
        zoneAwarenessEnabled: false,
      },
      ebsOptions: {
        ebsEnabled: true,
        volumeSize: normalizeStorage(),
        volumeType: "gp3",
      },
      advancedSecurityOptions: {
        enabled: true,
        internalUserDatabaseEnabled: true,
        masterUserOptions: {
          masterUserName: username,
          masterUserPassword: password,
        },
      },
      nodeToNodeEncryption: { enabled: true },
      encryptAtRest: { enabled: true },
      domainEndpointOptions: {
        enforceHttps: true,
        tlsSecurityPolicy: "Policy-Min-TLS-1-2-2019-07",
      },
      // How `get` finds the username and the password
      tags: {
        "sst:ref:password": secret.id,
        "sst:ref:username": username,
      },
    });

    this.part("policy", {
      domainName: domain.domainName,
      accessPolicies: iam.getPolicyDocumentOutput({
        statements: [
          {
            principals: [{ type: "*", identifiers: ["*"] }],
            actions: ["*"],
            resources: ["*"],
          },
        ],
      }).json,
    });

    this.connection = {
      id: domain.id,
      username,
      password,
      url: interpolate`https://${domain.endpoint}`,
    };
    this.report({ hint: this.connection.url });

    function createPassword() {
      // As in SST 4, an empty password is generated too
      return args.password
        ? output(args.password)
        : self.part("password", {
            length: 32,
            minLower: 1,
            minUpper: 1,
            minNumeric: 1,
            minSpecial: 1,
          }).result;
    }

    function normalizeStorage() {
      return output(args.storage ?? "10 GB").apply((v) => {
        const size = toGBs(v);
        if (size < 10) {
          throw new VisibleError(
            `The "storage" of ${owner} is ${v}. It has to be at least 10 GB.`,
          );
        }
        return size;
      });
    }

    // A domain created by this component, or by `sst.aws.OpenSearch`, is
    // tagged with its username and the secret that holds its password. Given
    // its own, or the secret, it uses those.
    function reference(domain: opensearch.Domain) {
      const secret = self.existingPart("secret");
      return {
        id: domain.id,
        username: args.username
          ? output(args.username)
          : tagOf(
              domain,
              "sst:ref:username",
              `The "${name}" OpenSearch domain can't find its username: its domain has no "sst:ref:username" tag. Set "username".`,
            ),
        password: args.password
          ? output(args.password)
          : secretField(
              secret
                ? secret.id
                : tagOf(
                    domain,
                    "sst:ref:password",
                    `The "${name}" OpenSearch domain can't find its password: its domain has no "sst:ref:password" tag, which names the secret that holds it. Pass the secret in "existing.secret", or set "password".`,
                  ),
              "password",
              self,
            ),
        url: interpolate`https://${domain.endpoint}`,
      };
    }

    // What `sst dev` connects to, and the pane that says how the local server
    // has to be set up
    function runLocally(dev: NonNullable<OpenSearchArgs["dev"]>) {
      const local = {
        id: output("placeholder"),
        url: devValue(dev.url, "http://localhost:9200"),
        username: devValue(dev.username, username, true),
        password: localPassword(dev.password, args.password, owner),
      };

      self.report({
        dev: localServerPane(
          "OpenSearch server",
          { username: local.username, password: local.password },
          local.url,
        ),
      });

      return local;
    }
  }

  /**
   * The ID of the OpenSearch component.
   */
  public get id() {
    return this.connection.id;
  }

  /** The username of the master user. */
  public get username() {
    return this.connection.username;
  }

  /** The password of the master user. */
  public get password() {
    return this.connection.password;
  }

  /**
   * The endpoint of the domain.
   */
  public get url() {
    return this.connection.url;
  }

  /**
   * Linking an OpenSearch domain gives the linked resource its URL and its master user's
   * username and password.
   */
  public link() {
    return {
      properties: {
        username: this.username,
        password: this.password,
        url: this.url,
      },
    };
  }

  /**
   * Reference an existing OpenSearch domain with the given name. This is useful when you
   * create a domain in one stage and want to share it in another. It avoids
   * having to create a new domain in the other stage.
   *
   * :::tip
   * You can use the `static get` method to share OpenSearch domains across stages.
   * :::
   *
   * @param name The name of the component.
   * @param id The name of the existing OpenSearch domain, or its ARN, which is the
   * component's `id`.
   * @param opts Resource options.
   *
   * @example
   * Imagine you create a domain in the `dev` stage. And in your personal stage `frank`,
   * instead of creating a new domain, you want to share the same domain from `dev`.
   *
   * ```ts title="sst.config.ts"
   * const search = $app.stage === "frank"
   *   ? sst.aws.OpenSearch.get("MyOpenSearch", "app-dev-myopensearch-efsmkrbt")
   *   : new sst.aws.OpenSearch("MyOpenSearch");
   * ```
   *
   * Here `app-dev-myopensearch-efsmkrbt` is the name of the domain created in the
   * `dev` stage. You can find it by outputting the component's ID there: its ARN, which
   * `get` takes too.
   *
   * ```ts title="sst.config.ts"
   * return {
   *   id: search.id
   * };
   * ```
   */
  public static get(
    name: string,
    id: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    // A domain is looked up by its name. Its `id` is its ARN, which ends in
    // the name.
    const domain = output(id).apply((id) =>
      id.startsWith("arn:") ? parseOpenSearch(id).domainName : id,
    );
    return new OpenSearch(
      name,
      getArgs({ existing: { domain } }) as OpenSearchArgs,
      opts,
    );
  }
}
