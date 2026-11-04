import {
  ComponentResourceOptions,
  jsonStringify,
  Output,
} from "@pulumi/pulumi";
import {
  type ComponentArgs,
  component,
  deferred,
  named,
  optional,
} from "../../parts-component";
import { notAnExistingPart, notAnOption, plain } from "../../args";
import { VisibleError } from "../../error";
import type { Prettify } from "../../component";
import { functionPart } from "../helpers/function-part";
import type { CdnDomainArgs } from "./cdn";
import { Dynamo } from "./dynamo";
import { Function, type FunctionArgs } from "./function";
import { Router } from "./router";

const parts = () => ({
  /**
   * The DynamoDB table OpenAuth keeps its data in.
   */
  table: named(Dynamo, "Storage"),
  /**
   * The AWS Lambda function that runs the OpenAuth issuer. An output, as it's created
   * once its args are known.
   */
  issuer: deferred(Function),
  /**
   * With `domain`, the `Router` that serves the issuer at the domain. It's the auth
   * server's own: one you have isn't taken in `existing`.
   */
  router: optional(Router),
});

export interface AuthArgs extends ComponentArgs<typeof parts> {
  /**
   * The function that's running your OpenAuth server.
   *
   * @example
   * ```js
   * {
   *   issuer: "src/auth.handler"
   * }
   * ```
   *
   * You can also pass in the full `FunctionArgs`.
   *
   * ```js
   * {
   *   issuer: {
   *     handler: "src/auth.handler",
   *     link: [table]
   *   }
   * }
   * ```
   *
   * Since the `issuer` function is a Hono app, you want to export it with the Lambda adapter.
   *
   * ```ts title="src/auth.ts"
   * import { handle } from "hono/aws-lambda";
   * import { issuer } from "@openauthjs/openauth";
   *
   * const app = issuer({
   *   // ...
   * });
   *
   * export const handler = handle(app);
   * ```
   *
   * This `Auth` component will always use the
   * [`DynamoStorage`](https://openauth.js.org/docs/storage/dynamo/) storage provider.
   *
   * :::note
   * This will always use the `DynamoStorage` storage provider.
   * :::
   *
   * The function always has a URL, without CORS: the issuer is reached through it. A
   * handler or the function's args have to be plain values, not outputs; what's in the
   * args can be an output.
   *
   * Learn more on the [OpenAuth docs](https://openauth.js.org/docs/issuer/) on how to configure
   * the `issuer` function.
   */
  issuer: string | FunctionArgs;
  /**
   * Set a custom domain for your Auth server.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * :::tip
   * Built-in support for AWS Route 53, Cloudflare, and Vercel. And manual setup for other
   * providers.
   * :::
   *
   * Whether there's a domain decides whether the `Router` is created, so `domain` has to
   * be a plain value, not an output. So do its `name`, `aliases` and `redirects`.
   *
   * @example
   *
   * By default this assumes the domain is hosted on Route 53.
   *
   * ```js
   * {
   *   domain: "auth.example.com"
   * }
   * ```
   *
   * For domains hosted on Cloudflare.
   *
   * ```js
   * {
   *   domain: {
   *     name: "auth.example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   */
  domain?: string | Prettify<CdnDomainArgs>;
}

/**
 * The `Auth` component lets you create centralized auth servers on AWS. It deploys
 * [OpenAuth](https://openauth.js.org) to [AWS Lambda](https://aws.amazon.com/lambda/)
 * and uses [Amazon DynamoDB](https://aws.amazon.com/dynamodb/) for storage.
 *
 * :::note
 * `Auth` and OpenAuth are currently in beta.
 * :::
 *
 * @example
 *
 * #### Create an OpenAuth server
 *
 * ```ts title="sst.config.ts"
 * const auth = new sst.aws.v5.Auth("MyAuth", {
 *   issuer: "src/auth.handler"
 * });
 * ```
 *
 * Where the `issuer` function might look like this.
 *
 * ```ts title="src/auth.ts"
 * import { handle } from "hono/aws-lambda";
 * import { issuer } from "@openauthjs/openauth";
 * import { CodeProvider } from "@openauthjs/openauth/provider/code";
 * import { subjects } from "./subjects";
 *
 * const app = issuer({
 *   subjects,
 *   providers: {
 *     code: CodeProvider()
 *   },
 *   success: async (ctx, value) => {}
 * });
 *
 * export const handler = handle(app);
 * ```
 *
 * This `Auth` component will always use the
 * [`DynamoStorage`](https://openauth.js.org/docs/storage/dynamo/) storage provider.
 *
 * Learn more on the [OpenAuth docs](https://openauth.js.org/docs/issuer/) on how to configure
 * the `issuer` function.
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your auth server.
 *
 * ```js {3} title="sst.config.ts"
 * new sst.aws.v5.Auth("MyAuth", {
 *   issuer: "src/auth.handler",
 *   domain: "auth.example.com"
 * });
 * ```
 *
 * To attach a WAF to the domain's CloudFront distribution, transform the router.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Auth("MyAuth", {
 *   issuer: "src/auth.handler",
 *   domain: "auth.example.com",
 *   transform: {
 *     router: {
 *       transform: {
 *         cdn: {
 *           transform: {
 *             distribution: {
 *               webAclId: "arn:aws:wafv2:..."
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * #### Link to a resource
 *
 * You can link the auth server to other resources, like a function or your Next.js app,
 * that needs authentication.
 *
 * ```ts title="sst.config.ts" {2}
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [auth]
 * });
 * ```
 *
 * Once linked, you can now use it to create an [OpenAuth
 * client](https://openauth.js.org/docs/client/).
 *
 * ```ts title="app/page.tsx" {1,6}
 * import { Resource } from "sst"
 * import { createClient } from "@openauthjs/openauth/client"
 *
 * export const client = createClient({
 *   clientID: "nextjs",
 *   issuer: Resource.MyAuth.url
 * });
 * ```
 *
 * #### Switch from `sst.aws.Auth`
 *
 * Change `sst.aws.Auth` to `sst.aws.v5.Auth` and keep the name. The table, the issuer
 * function and the router are kept: each becomes its V5 form, the `Dynamo`, the
 * `Function` and the `Router`, as each one's own "Switch from" says. A few things are
 * written differently:
 *
 * - `authorizer` is gone. Use `issuer`, which is required.
 * - `forceUpgrade` is gone. The 5.0 `Auth` is the one OpenAuth runs on, and SST 4's
 *   record of its version goes with the switch.
 * - `nodes.authorizer` is gone. Use `nodes.issuer`.
 * - `domain` has to be a plain value, not an output: it decides whether the router is
 *   created. A handler or the issuer's args have to be plain values too; what's in the
 *   args can be an output.
 * - `transform.router` transforms the V5 `Router`, whose own `transform` is shaped by its
 *   parts.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - `sst.aws.Auth.v1`, the auth server before OpenAuth, has no 5.0 form.
 */
export class Auth extends component("sst:aws:Auth", parts) {
  private readonly issuerUrl: Output<string>;

  constructor(name: string, args: AuthArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);
    const owner = `the "${name}" auth server`;
    notAnOption(args, "authorizer", `Use "issuer".`, owner);
    notAnOption(
      args,
      "forceUpgrade",
      `Remove it: the 5.0 "Auth" is the one OpenAuth runs on.`,
      owner,
    );

    // The issuer is a function the auth server creates, with its table linked
    // and a URL it's reached through
    notAnExistingPart(
      args.existing,
      "issuer",
      owner,
      `Pass the handler or the function's args in "issuer": the auth server creates its function, links its table and gives it a URL.`,
    );
    // The router serves the issuer at the auth server's domain
    notAnExistingPart(
      args.existing,
      "router",
      owner,
      `Its router serves the issuer at its "domain". To serve the issuer through a router you have, route that router to the issuer's URL: router.route("/", auth.url).`,
    );
    const domain = plain(
      args.domain,
      `The "domain" of the "${name}" auth server`,
    );

    const table = this.part("table", {
      fields: { pk: "string", sk: "string" },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "expiry",
    });

    const issuer = functionPart(this, "issuer", withUrl(issuerOf()), {
      link: [table],
      environment: {
        OPENAUTH_STORAGE: jsonStringify({
          type: "dynamo",
          options: { table: table.name },
        }),
      },
      _skipHint: true,
    }).apply((fn) => fn.getFunction());

    const router = domain
      ? this.part("router", { domain, _skipHint: true })
      : undefined;
    router?.route(
      "/",
      issuer.url.apply((url) => url!),
    );

    this.issuerUrl =
      router?.url ??
      issuer.url.apply((url) => (url?.endsWith("/") ? url.slice(0, -1) : url));
    this.report({ hint: this.issuerUrl });

    // The issuer is a function the component creates: it's reached through
    // its URL
    function issuerOf() {
      const issuer = plain(
        args.issuer,
        `The "issuer" of the "${name}" auth server`,
      );
      if (!issuer)
        throw new VisibleError(
          `The "${name}" auth server needs an "issuer": the handler of the function that runs OpenAuth, or the function's args.`,
        );
      if (typeof issuer === "string" && issuer.startsWith("arn:"))
        throw new VisibleError(
          `The "issuer" of the "${name}" auth server is the ARN of a function. Pass the handler or the function's args: the issuer is reached through the URL of a function the auth server creates.`,
        );
      return issuer;
    }

    // Through its URL, without CORS, whatever the function's own `url` says
    function withUrl(issuer: string | FunctionArgs): FunctionArgs {
      if (typeof issuer === "string")
        return { handler: issuer, url: { cors: false } };
      return {
        ...issuer,
        url: {
          ...(typeof issuer.url === "object" ? issuer.url : {}),
          cors: false,
        },
      };
    }
  }

  /**
   * The URL of the Auth component.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated function URL for the issuer.
   */
  public get url() {
    return this.issuerUrl;
  }

  link() {
    return {
      properties: {
        url: this.url,
      },
      include: [
        // What a linked function is given in its environment
        {
          type: "environment" as const,
          env: { OPENAUTH_ISSUER: this.url.apply((url) => url!) },
        },
      ],
    };
  }
}
