import {
  all,
  ComponentResourceOptions,
  Config,
  type Inputs,
  interpolate,
  Output,
  output,
  Resource,
} from "@pulumi/pulumi";
import { apigateway, cloudwatch, getRegionOutput, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../parts-component";
import type { Prettify } from "../component";
import { knownValue, notAnOption, plain } from "../args";
import { context } from "../contract";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { hashStringToPrettyString, logicalName } from "../naming";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function } from "./function";
import { ApiGatewayRestUsagePlan } from "./apigateway-rest-usage-plan";
import {
  type ApiDomain,
  type ApiGatewayAccessLogArgs,
  type ApiGatewayDomainArgs,
  accessLogGroup,
  apiDomainOf,
  authorizerPermissionArgs,
  notAnOldTransform,
  parseRoute,
  routePermissionArgs,
} from "./helpers/apigateway";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "./helpers/function-part";
import { apiGatewayAccount } from "./helpers/apigateway-account";
import { useProvider } from "./helpers/provider";

const parts = () => ({
  /**
   * The Amazon API Gateway REST API.
   */
  api: apigateway.RestApi,
  /**
   * The resource of each segment of the routes' paths, by a hash of its path, the name
   * SST 4 gave it.
   */
  resource: many(apigateway.Resource),
  /**
   * The function each route invokes, by the route's name, or the route itself, like
   * `GET /notes`.
   */
  handler: many(deferred(Function)),
  /**
   * The permission for API Gateway to invoke each route's function.
   */
  permission: many(lambda.Permission),
  /**
   * Each route's method.
   */
  method: many(apigateway.Method),
  /**
   * Each route's integration.
   */
  integration: many(apigateway.Integration),
  /**
   * Each authorizer, by its name.
   */
  authorizer: many(apigateway.Authorizer),
  /**
   * Each authorizer's function, by the authorizer's name.
   */
  authorizerFunction: many(deferred(Function)),
  /**
   * The permission for API Gateway to invoke each authorizer's function.
   */
  authorizerPermission: many(lambda.Permission),
  /**
   * With `cors`, the `OPTIONS` method of each path with a route, by the path.
   */
  corsMethod: many(apigateway.Method),
  /**
   * With `cors`, the response of each path's `OPTIONS` method.
   */
  corsMethodResponse: many(apigateway.MethodResponse),
  /**
   * With `cors`, the integration of each path's `OPTIONS` method.
   */
  corsIntegration: many(apigateway.Integration),
  /**
   * With `cors`, the integration response of each path's `OPTIONS` method.
   */
  corsIntegrationResponse: many(apigateway.IntegrationResponse),
  /**
   * With `cors`, the API's responses to errors, by their kind: `4XX` and `5XX`.
   */
  corsResponse: many(apigateway.Response),
  /**
   * The deployment of the routes, made by `deploy()`.
   */
  deployment: optional(apigateway.Deployment),
  /**
   * The CloudWatch LogGroup for the access logs, made by `deploy()`.
   */
  logGroup: optional(cloudwatch.LogGroup),
  /**
   * The API's stage, named after the app's stage, made by `deploy()`.
   */
  stage: optional(apigateway.Stage),
  /**
   * The certificate of the custom domain, unless one is given in `domain.cert`.
   */
  certificate: deferred(optional(DnsValidatedCertificate)),
  /**
   * The API Gateway domain name, with a custom domain.
   */
  domainName: optional(apigateway.DomainName),
  /**
   * The mapping of the API's stage to the domain name, with a custom domain.
   */
  domainMapping: optional(apigateway.BasePathMapping),
});

export interface ApiGatewayRestArgs
  extends ComponentArgs<typeof parts>,
    ApiGatewayAccessLogArgs {
  /**
   * Set a custom domain for your REST API.
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
   * Whether there's a domain decides what's created, so `domain` has to be a plain value,
   * not an output. To use a domain name you already have in API Gateway, pass it in
   * `existing.domainName`, with the `path` here.
   *
   * The domain is created by `deploy()`, with the stage. With an `edge` endpoint, the
   * certificate is created in `us-east-1`, as API Gateway needs.
   *
   * @example
   *
   * By default this assumes the domain is hosted on Route 53.
   *
   * ```js
   * {
   *   domain: "example.com"
   * }
   * ```
   *
   * For domains hosted on Cloudflare.
   *
   * ```js
   * {
   *   domain: {
   *     name: "example.com",
   *     dns: sst.cloudflare.dns()
   *   }
   * }
   * ```
   */
  domain?: string | Prettify<Partial<ApiGatewayDomainArgs>>;
  /**
   * Configure the type of API Gateway REST API endpoint.
   *
   * - `edge`: The default; it creates a CloudFront distribution for the API.
   *   Useful for cases where requests are geographically distributed.
   * - `regional`: Endpoints are deployed in specific AWS regions and are
   *   intended to be accessed directly by clients within or near that region.
   * - `private`: Endpoints allows access to the API only from within a specified
   *   Amazon VPC (Virtual Private Cloud) using VPC endpoints. These do not expose
   *   the API to the public internet.
   *
   * Learn more about the [different types of endpoints](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-endpoint-types.html).
   *
   * The type decides where the domain's certificate is created, so `endpoint` has to be a
   * plain value, not an output. Its `vpcEndpointIds` can be an output.
   *
   * @default `{type: "edge"}`
   * @example
   *
   * For example, to create a regional endpoint.
   * ```js
   * {
   *   endpoint: {
   *     type: "regional"
   *   }
   * }
   * ```
   *
   * And to create a private endpoint.
   * ```js
   * {
   *   endpoint: {
   *     type: "private",
   *     vpcEndpointIds: ["vpce-0dccab6fb1e828f36"]
   *   }
   * }
   * ```
   */
  endpoint?: {
    /**
     * The type of the API Gateway REST API endpoint.
     */
    type: "edge" | "regional" | "private";
    /**
     * The VPC endpoint IDs for the `private` endpoint.
     */
    vpcEndpointIds?: Input<Input<string>[]>;
  };
  /**
   * Enable the CORS or Cross-origin resource sharing for your API.
   *
   * With CORS, `deploy()` adds an `OPTIONS` method to each path with a route, and the CORS
   * headers to API Gateway's responses to errors. Whether it does decides what's created,
   * so `cors` has to be a plain value, not an output.
   *
   * @default `true`
   * @example
   * Disable CORS.
   * ```js
   * {
   *   cors: false
   * }
   * ```
   */
  cors?: boolean;
}

export interface ApiGatewayRestAuthorizerArgs {
  /**
   * The name of the authorizer.
   * @example
   * ```js
   * {
   *   name: "myAuthorizer"
   * }
   * ```
   */
  name: string;
  /**
   * The Lambda token authorizer function. Takes the handler path, the function args, a
   * `Function`, or the ARN of a function.
   * @example
   * ```js
   * {
   *   tokenFunction: "src/authorizer.index"
   * }
   * ```
   */
  tokenFunction?: FunctionInput;
  /**
   * The Lambda request authorizer function. Takes the handler path, the function args, a
   * `Function`, or the ARN of a function.
   * @example
   * ```js
   * {
   *   requestFunction: "src/authorizer.index"
   * }
   * ```
   */
  requestFunction?: FunctionInput;
  /**
   * A list of user pools used as the authorizer.
   * @example
   * ```js
   * {
   *   name: "myAuthorizer",
   *   userPools: [userPool.arn]
   * }
   * ```
   *
   * Where `userPool` is:
   *
   * ```js
   * const userPool = new aws.cognito.UserPool();
   * ```
   */
  userPools?: Input<Input<string>[]>;
  /**
   * Time to live for cached authorizer results in seconds.
   * @default `300`
   * @example
   * ```js
   * {
   *   ttl: 30
   * }
   * ```
   */
  ttl?: Input<number>;
  /**
   * Specifies where to extract the authorization token from the request.
   * @default `"method.request.header.Authorization"`
   * @example
   * ```js
   * {
   *   identitySource: "method.request.header.AccessToken"
   * }
   * ```
   */
  identitySource?: Input<string>;
}

export interface ApiGatewayRestUsagePlanArgs {
  /**
   * Configure rate limits to protect your API from being overwhelmed by too many
   * requests at once.
   *
   * @example
   * ```js
   * {
   *   throttle: {
   *     rate: 100,
   *     burst: 200
   *   }
   * }
   * ```
   */
  throttle?: Input<{
    /**
     * The maximum number of requests permitted in a short-term spike beyond the
     * rate limit.
     */
    burst?: Input<number>;
    /**
     * The steady-state maximum number of requests allowed per second.
     */
    rate?: Input<number>;
  }>;
  /**
   * Configure a cap on the total number of requests allowed within a specified time
   * period.
   * @example
   * ```js
   * {
   *   quota: {
   *     limit: 1000,
   *     period: "month",
   *     offset: 0
   *   }
   * }
   * ```
   */
  quota?: Input<{
    /**
     * The maximum number of requests that can be made in the specified period of
     * time.
     */
    limit: Input<number>;
    /**
     * The time period for which the quota applies.
     */
    period: Input<"day" | "week" | "month">;
    /**
     * The number of days into the period when the quota counter is reset.
     *
     * For example, this resets the quota at the beginning of each month.
     *
     * ```js
     * {
     *   period: "month",
     *   offset: 0
     * }
     * ```
     */
    offset?: Input<number>;
  }>;
}

export interface ApiGatewayRestApiKeyArgs {
  /**
   * The value of the API key. If not provided, it will be generated automatically.
   * @example
   * ```js
   * {
   *   value: "d41d8cd98f00b204e9800998ecf8427e"
   * }
   * ```
   */
  value?: Input<string>;
}

export interface ApiGatewayRestRouteArgs {
  /**
   * Enable auth for your REST API. By default, auth is disabled.
   * @default `false`
   * @example
   * ```js
   * {
   *   auth: {
   *     iam: true
   *   }
   * }
   * ```
   */
  auth?: Input<
    | false
    | {
        /**
         * Enable IAM authorization for a given API route.
         *
         * When IAM auth is enabled, clients need to use Signature Version 4 to sign their requests with their AWS credentials.
         */
        iam?: Input<boolean>;
        /**
         * Enable custom Lambda authorization for a given API route. Pass in the authorizer ID.
         * @example
         * ```js
         * {
         *   auth: {
         *     custom: myAuthorizer.id
         *   }
         * }
         * ```
         *
         * Where `myAuthorizer` is:
         *
         * ```js
         * const userPool = new aws.cognito.UserPool();
         * const myAuthorizer = api.addAuthorizer({
         *   name: "MyAuthorizer",
         *   userPools: [userPool.arn]
         * });
         * ```
         */
        custom?: Input<string>;
        /**
         * Enable Cognito User Pool authorization for a given API route.
         *
         * @example
         * You can configure JWT auth.
         *
         * ```js
         * {
         *   auth: {
         *     cognito: {
         *       authorizer: myAuthorizer.id,
         *       scopes: ["read:profile", "write:profile"]
         *     }
         *   }
         * }
         * ```
         *
         * Where `myAuthorizer` is:
         *
         * ```js
         * const userPool = new aws.cognito.UserPool();
         *
         * const myAuthorizer = api.addAuthorizer({
         *   name: "MyAuthorizer",
         *   userPools: [userPool.arn]
         * });
         * ```
         */
        cognito?: Input<{
          /**
           * Authorizer ID of the Cognito User Pool authorizer.
           */
          authorizer: Input<string>;
          /**
           * Defines the permissions or access levels that the authorization token grants.
           */
          scopes?: Input<Input<string>[]>;
        }>;
      }
  >;
  /**
   * Specify if an API key is required for the route. By default, an API key is not
   * required.
   * @default `false`
   * @example
   * ```js
   * {
   *   apiKey: true
   * }
   * ```
   */
  apiKey?: Input<boolean>;
  /**
   * The name of the route.
   *
   * By default, a route is known by the route itself, like `GET /users/{id}`, and its
   * resources are named after it. Setting `name` gives them a stable, human-readable
   * name instead, like `MyApiHandlerGetUser` for its function.
   *
   * Must be unique across all routes.
   *
   * @example
   * ```js
   * {
   *   name: "GetUser"
   * }
   * ```
   */
  name?: string;
}

export interface ApiGatewayRestIntegrationArgs {
  /**
   * The type of the API Gateway REST API integration.
   */
  type: Input<"aws" | "aws-proxy" | "mock" | "http" | "http-proxy">;
  /**
   * The URI of the API Gateway REST API integration.
   */
  uri?: Input<string>;
  /**
   * The credentials to use to call the AWS service.
   */
  credentials?: Input<string>;
  /**
   * The HTTP method to use to call the integration.
   */
  integrationHttpMethod?: Input<
    "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "ANY" | "PATCH"
  >;
  /**
   * Map of request query string parameters and headers that should be passed to the backend responder.
   */
  requestParameters?: Input<Record<string, Input<string>>>;
  /**
   * Map of the integration's request templates.
   */
  requestTemplates?: Input<Record<string, Input<string>>>;
  /**
   * The passthrough behavior to use to call the integration.
   *
   * Required if `requestTemplates` is set.
   */
  passthroughBehavior?: Input<"when-no-match" | "never" | "when-no-templates">;
}

/**
 * The `ApiGatewayRest` component lets you add an [Amazon API Gateway REST API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-rest-api.html) to your app.
 *
 * @example
 *
 * #### Create the API
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.ApiGatewayRest("MyApi");
 * ```
 *
 * #### Add routes
 *
 * ```ts title="sst.config.ts"
 * api.route("GET /", "src/get.handler");
 * api.route("POST /", "src/post.handler");
 *
 * api.deploy();
 * ```
 *
 * :::note
 * You need to call `deploy` after you've added all your routes.
 * :::
 *
 * #### Configure the routes
 *
 * ```ts title="sst.config.ts"
 * api.route("GET /", "src/get.handler", {
 *   auth: { iam: true }
 * });
 * ```
 *
 * #### Configure the route handler
 *
 * You can configure the Lambda function that'll handle the route.
 *
 * ```ts title="sst.config.ts"
 * api.route("POST /", {
 *   handler: "src/post.handler",
 *   memory: "2048 MB"
 * });
 * ```
 *
 * #### Default props for all routes
 *
 * You can use a `transform` to set some default props for all your routes. For
 * example, instead of setting the `memory` for each route.
 *
 * ```ts title="sst.config.ts"
 * api.route("GET /", { handler: "src/get.handler", memory: "2048 MB" });
 * api.route("POST /", { handler: "src/post.handler", memory: "2048 MB" });
 * ```
 *
 * You can set it through the `transform`.
 *
 * ```ts title="sst.config.ts" {4}
 * const api = new sst.aws.ApiGatewayRest("MyApi", {
 *   transform: {
 *     handler: (args, opts) => {
 *       // Set the default if it's not set by the route
 *       args.memory ??= "2048 MB";
 *     }
 *   }
 * });
 *
 * api.route("GET /", "src/get.handler");
 * api.route("POST /", "src/post.handler");
 * ```
 *
 * With this we set the `memory` if it's not overridden by the route.
 *
 * #### Switch from SST 4's `sst.aws.ApiGatewayV1`
 *
 * Change `sst.aws.ApiGatewayV1` to `sst.aws.ApiGatewayRest` and keep the name. The API,
 * its resources, routes, authorizers, stage, access log, domain and usage plans are kept.
 * The deployment is made again once, with the same routes, since it's made again whenever
 * what it's made of moves.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const api = new sst.aws.ApiGatewayV1("MyApi");
 * const api = new sst.aws.ApiGatewayRest("MyApi");
 * ```
 *
 * A few things are written differently:
 *
 * - It's named `ApiGatewayRest`, for the REST API it creates. `sst.aws.ApiGatewayV1` was
 *   named after the version of API Gateway's API that creates one. It keeps its type,
 *   `sst:aws:ApiGatewayV1`, which is what a deployed one has, so `sst-env.d.ts` still
 *   lists a linked one as `sst.aws.ApiGatewayV1`. Its args' types are renamed the same
 *   way: `ApiGatewayRestArgs`, `ApiGatewayRestRouteArgs` and the others.
 * - The routes and authorizers are inside the component, where `sst.aws.ApiGatewayV1`
 *   kept each in a component of its own. A route is kept by its name, or the route itself,
 *   like `GET /notes`. `route` and `routeIntegration` return the API, and `addAuthorizer`
 *   returns the authorizer, with its `id`, not those components.
 * - A route's and an authorizer's own `transform`, and `transform.route.handler`, become the
 *   API's `transform` for `handler`, `method`, `integration` and `authorizer`, which apply
 *   to every route or authorizer and are given its name in a function.
 *   `transform.route.args` is gone: give each route its `auth` and `apiKey`. Each is
 *   refused with what to write. `transform.accessLog` is `transform.logGroup`, and the
 *   certificate is `nodes.certificate`, an output.
 * - `domain`, `endpoint` and `cors` have to be plain values, not outputs. `domain.nameId` is
 *   `existing.domainName`.
 * - `domain.dns` is an adapter SST 5's components use, like `sst.aws.dns()`,
 *   `sst.cloudflare.dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work.
 * - The DNS records that validate the certificate are named after the domain they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - A route's `streaming` is refused. Set `streaming: true` on the route's function
 *   instead: `api.route("GET /", { handler: "src/get.handler", streaming: true })`. A route
 *   to a function you have, or to its ARN, doesn't stream.
 * - A route added after `deploy()`, or a second `deploy()`, is refused.
 *   `sst.aws.ApiGatewayV1` deployed such a route, but without CORS for its path. If your
 *   app adds one, move it above `deploy()` and deploy with SST 4 first, which adds CORS
 *   for its path; then switch.
 * - `nodes.domainName` is `undefined` without a domain or before `deploy()`, where
 *   `sst.aws.ApiGatewayV1` threw.
 * - A refresh doesn't make the API deploy again. `sst.aws.ApiGatewayV1` deployed it again
 *   after every refresh, which reads empty settings back from AWS.
 * - An authorizer's `tokenFunction` and `requestFunction` take a `Function`, or the ARN of a
 *   function, as well as a handler or the function's args.
 * - A route's handler and an authorizer's function have to be plain values: whether a
 *   function is created is decided from them. A function you have, or its ARN, can be an
 *   output.
 * - A function's args are typed as
 *   [`sst.aws.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.Function`](/docs/component/aws/v5/function) takes them.
 * - Next to `existing.domainName`, a domain's `name`, `dns` and `cert` are refused: the
 *   domain name is used the way it is.
 * - API Gateway's account settings, which give the API a role to write its access log
 *   with, are read and set up with the provider the API has. `sst.aws.ApiGatewayV1` used
 *   only a `provider` passed to the API itself, so an API that takes its provider from a
 *   parent component or from `providers` has the account of that provider's region set
 *   up, where it had the default region's. The setup is kept when the API is removed.
 * - The routes and authorizers are created with the provider the API has.
 *   `sst.aws.ApiGatewayV1` gave them only a `provider` passed to the API itself. So if your
 *   API takes its provider from a parent component or from `providers`, the switch gives
 *   its routes and authorizers that provider and keeps them, with the provider's default
 *   tags.
 */
export class ApiGatewayRest extends component("sst:aws:ApiGatewayV1", parts) {
  private readonly endpointType: "EDGE" | "REGIONAL" | "PRIVATE";
  // The custom domain, checked: made by `deploy()`, with the stage
  private readonly domain?: ReturnType<typeof apiDomainOf>;
  private readonly cors: boolean;
  private readonly logGroupArgs: ReturnType<typeof accessLogGroup>;
  private readonly region: Output<string>;
  // The id of each path's resource, from the root's on
  private readonly resources: Map<string, Output<string>>;
  // Each route, by its name or the route itself
  private readonly routes: Map<string, Route>;
  private deployed: boolean;

  constructor(
    name: string,
    args: ApiGatewayRestArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    // SST 4's transforms, before the component turns down a key it doesn't
    // have, with what to write instead
    const owner = `the "${name}" API`;
    notAnOldTransform(args.transform, "accessLog", owner);
    notAnOldTransform(args.transform, "route", owner);
    super(name, args, opts);
    this.resources = new Map();
    this.routes = new Map();
    this.deployed = false;
    const endpoint = plain(args.endpoint, `The "endpoint" of ${owner}`);
    if (endpoint?.type === "private" && !endpoint.vpcEndpointIds)
      throw new VisibleError(
        `The private endpoint of ${owner} needs the IDs of its VPC endpoints. Give them in "endpoint.vpcEndpointIds".`,
      );
    this.endpointType =
      endpoint?.type === "regional"
        ? "REGIONAL"
        : endpoint?.type === "private"
          ? "PRIVATE"
          : "EDGE";
    this.domain = apiDomainOf(args.domain, args.existing, owner);
    this.cors = plain(args.cors, `The "cors" of ${owner}`) !== false;
    this.logGroupArgs = accessLogGroup(name, args, owner);
    this.region = getRegionOutput(undefined, { parent: this }).region;

    // The account's role for API Gateway to write logs with, made once for
    // the account when it has none
    const account = apiGatewayAccount(this.builder(), name);
    const api = this.part(
      "api",
      {
        endpointConfiguration:
          this.endpointType === "PRIVATE"
            ? { types: "PRIVATE", vpcEndpointIds: endpoint!.vpcEndpointIds }
            : { types: this.endpointType },
      },
      { dependsOn: account },
    );
    this.resources.set("/", api.rootResourceId);
  }

  // Pulumi registers a component's outputs once its constructor is done.
  // This API's are registered by `deploy()`, with the URL it reports, since a
  // config may wait for something between the two. One that's never deployed
  // has none, as in SST 4.
  protected registerOutputs(
    outputs?: Inputs | Promise<Inputs> | Output<Inputs>,
  ) {
    if (this.deployed) super.registerOutputs(outputs);
  }

  /**
   * The URL of the API.
   */
  public get url() {
    const { api, stage, domainName, domainMapping } = this.nodes;
    // With a base path, the URL needs a trailing slash
    return domainName && domainMapping
      ? output([domainName.domainName, domainMapping.basePath]).apply(
          ([domain, key]) =>
            key ? `https://${domain}/${key}/` : `https://${domain}`,
        )
      : interpolate`https://${api.id}.execute-api.${
          this.region
        }.amazonaws.com/${stage?.stageName ?? context().app.stage}/`;
  }

  /**
   * Add a route to the API Gateway REST API. The route is a combination of an HTTP method and a path, `{METHOD} /{path}`.
   *
   * :::caution
   * [API Gateway has strict rate limits](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html) for creating and updating resources. Creating one Lambda function for every endpoint can significantly slow down your deployments.
   *
   * Use a single Lambda and handle routing in code if you don't need specific API Gateway features.
   * :::
   *
   * A method could be one of `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, or `ANY`. Here `ANY` matches any HTTP method.
   *
   * The path can be a combination of
   * - Literal segments, `/notes`, `/notes/new`, etc.
   * - Parameter segments, `/notes/{noteId}`, `/notes/{noteId}/attachments/{attachmentId}`, etc.
   * - Greedy segments, `/{proxy+}`, `/notes/{proxy+}`,  etc. The `{proxy+}` segment is a greedy segment that matches all child paths. It needs to be at the end of the path.
   *
   * :::tip
   * The `{proxy+}` is a greedy segment, it matches all its child paths.
   * :::
   *
   * When a request comes in, the API Gateway will look for the most specific match.
   *
   * :::note
   * You cannot have duplicate routes.
   * :::
   *
   * @param route The path for the route.
   * @param handler The function that'll be invoked.
   * @param args Configure the route.
   *
   * @example
   * Add a simple route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", "src/get.handler");
   * ```
   *
   * Match any HTTP method.
   *
   * ```js title="sst.config.ts"
   * api.route("ANY /", "src/route.handler");
   * ```
   *
   * Add a default or fallback route. Here for every request other than `GET /hi`,
   * the `default.handler` function will be invoked.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /hi", "src/get.handler");
   *
   * api.route("ANY /", "src/default.handler");
   * api.route("ANY /{proxy+}", "src/default.handler");
   * ```
   *
   * The `/{proxy+}` matches any path that starts with `/`, so if you want a
   * fallback route for the root `/` path, you need to add a `ANY /` route as well.
   *
   * Add a parameterized route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /notes/{id}", "src/get.handler");
   * ```
   *
   * Add a greedy route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /notes/{proxy+}", "src/greedy.handler");
   * ```
   *
   * Enable auth for a route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", "src/get.handler")
   * api.route("POST /", "src/post.handler", {
   *   auth: {
   *     iam: true
   *   }
   * });
   * ```
   *
   * Customize the route handler.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", {
   *   handler: "src/get.handler",
   *   memory: "2048 MB"
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   */
  public route(
    route: string,
    handler: FunctionInput,
    args: ApiGatewayRestRouteArgs = {},
  ) {
    const name = this.componentName;
    const { id, method, path, resourceId } = this.addRoute(
      route,
      args,
      "lambda",
    );
    const { api } = this.nodes;
    const definition = plainFunction(
      handler,
      `The handler of the "${route}" route of the "${name}" API`,
    );
    // The route streams when its function does
    const streaming: Output<boolean> = output(definition as any).apply(
      (fn: unknown) =>
        fn && typeof fn === "object" && "streaming" in fn
          ? (fn.streaming as boolean | undefined) ?? false
          : false,
    );
    const fn = functionPart(this, "handler", id, definition, {
      description: `${name} route ${method} ${path}`,
      streaming,
    });
    const permission = this.part(
      "permission",
      id,
      routePermissionArgs(fn, api.executionArn),
    );
    const httpMethod = this.createMethod(id, method, resourceId, args);
    this.part(
      "integration",
      id,
      {
        restApi: api.id,
        resourceId,
        httpMethod,
        integrationHttpMethod: "POST",
        type: "AWS_PROXY",
        uri: all([
          streaming,
          fn.targetInvokeArn,
          fn.targetResponseStreamingInvokeArn,
        ]).apply(([streaming, invoke, stream]) =>
          streaming ? stream : invoke,
        ),
        responseTransferMode: streaming.apply((streaming) =>
          streaming ? "STREAM" : "BUFFERED",
        ),
      },
      { dependsOn: [permission] },
    );
    return this;
  }

  /**
   * Add a custom integration to the API Gateway REST API. [Learn more about
   * integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-integration-settings.html).
   *
   * @param route The path for the route.
   * @param integration The integration configuration.
   * @param args Configure the route.
   *
   * @example
   * Add a route to trigger a Step Function state machine execution.
   *
   * ```js title="sst.config.ts"
   * api.routeIntegration("POST /run-my-state-machine", {
   *   type: "aws",
   *   uri: "arn:aws:apigateway:us-east-1:states:startExecution",
   *   credentials: "arn:aws:iam::123456789012:role/apigateway-execution-role",
   *   integrationHttpMethod: "POST",
   *   requestTemplates: {
   *     "application/json": JSON.stringify({
   *       input: "$input.json('$')",
   *       stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:MyStateMachine"
   *     })
   *   },
   *   passthroughBehavior: "when-no-match"
   * });
   * ```
   */
  public routeIntegration(
    route: string,
    integration: ApiGatewayRestIntegrationArgs,
    args: ApiGatewayRestRouteArgs = {},
  ) {
    const { id, method, resourceId } = this.addRoute(
      route,
      args,
      "integration",
    );
    const { api } = this.nodes;
    const httpMethod = this.createMethod(id, method, resourceId, args);
    this.part("integration", id, {
      restApi: api.id,
      resourceId,
      httpMethod,
      ...integration,
      type: output(integration.type).apply(
        (type) => type.toUpperCase().replaceAll("-", "_") as string,
      ),
      passthroughBehavior:
        integration.passthroughBehavior &&
        output(integration.passthroughBehavior).apply((behavior) =>
          behavior.toUpperCase().replaceAll("-", "_"),
        ),
    });
    return this;
  }

  // What every route starts with: the route checked and recorded, and the
  // resources of its path
  private addRoute(
    route: string,
    args: ApiGatewayRestRouteArgs,
    kind: Route["kind"],
  ) {
    const name = this.componentName;
    const { method, path } = parseRoute(route, `the "${name}" API`);
    const id = args.name ?? `${method} ${path}`;
    this.assertNew(
      "route",
      "method",
      id,
      args,
      kind === "lambda"
        ? ["handler", "permission", "method", "integration"]
        : ["method", "integration"],
    );
    notAnOption(
      args,
      "streaming",
      kind === "lambda"
        ? `Set "streaming: true" on the route's function: api.route("${route}", { handler: "src/stream.handler", streaming: true }).`
        : `Only a route to a function streams: set "streaming: true" on its function.`,
      `the "${route}" route of the "${name}" API`,
    );
    if (this.deployed)
      throw new VisibleError(
        `The "${route}" route is added to the "${name}" API after "deploy()", so it wouldn't be deployed. Add every route before calling "deploy()".`,
      );
    this.routes.set(id, { kind, named: args.name !== undefined, method, path });
    return { id, method, path, resourceId: this.resourceOf(path) };
  }

  // The method of a route, with its auth
  private createMethod(
    id: string,
    method: string,
    resourceId: Output<string>,
    args: ApiGatewayRestRouteArgs,
  ) {
    const auth = output(args.auth).apply(
      (
        auth,
      ): {
        authorization: string;
        authorizerId?: string;
        authorizationScopes?: string[];
      } => {
        if (!auth) return { authorization: "NONE" };
        if (auth.iam) return { authorization: "AWS_IAM" };
        if (auth.custom)
          return { authorization: "CUSTOM", authorizerId: auth.custom };
        if (auth.cognito)
          return {
            authorization: "COGNITO_USER_POOLS",
            authorizerId: auth.cognito.authorizer,
            authorizationScopes: auth.cognito.scopes,
          };
        return { authorization: "NONE" };
      },
    );
    return this.part("method", id, {
      restApi: this.nodes.api.id,
      resourceId,
      httpMethod: method,
      authorization: auth.authorization,
      authorizerId: auth.apply((auth) => auth.authorizerId!),
      authorizationScopes: auth.apply((auth) => auth.authorizationScopes!),
      apiKeyRequired: args.apiKey,
    }).httpMethod;
  }

  // The resource of each segment of a path, made once each. SST 4 named
  // each after a hash of its path, and so does this.
  private resourceOf(path: string) {
    const segments = path.replace(/^\//, "").split("/");
    for (let i = 0; i < segments.length; i++) {
      const parentPath = "/" + segments.slice(0, i).join("/");
      const subPath = "/" + segments.slice(0, i + 1).join("/");
      if (this.resources.has(subPath)) continue;
      const resource = this.part("resource", resourceKey(subPath), {
        restApi: this.nodes.api.id,
        parentId: this.resources.get(parentPath)!,
        pathPart: segments[i],
      });
      this.resources.set(subPath, resource.id);
    }
    return this.resources.get(path)!;
  }

  /**
   * Add an authorizer to the API Gateway REST API.
   *
   * @param args Configure the authorizer.
   * @example
   * For example, add a Lambda token authorizer.
   *
   * ```js title="sst.config.ts"
   * api.addAuthorizer({
   *   name: "myAuthorizer",
   *   tokenFunction: "src/authorizer.index"
   * });
   * ```
   *
   * Add a Lambda REQUEST authorizer.
   *
   * ```js title="sst.config.ts"
   * api.addAuthorizer({
   *   name: "myAuthorizer",
   *   requestFunction: "src/authorizer.index"
   * });
   * ```
   *
   * Add a Cognito User Pool authorizer.
   *
   * ```js title="sst.config.ts"
   * const userPool = new aws.cognito.UserPool();
   *
   * api.addAuthorizer({
   *   name: "myAuthorizer",
   *   userPools: [userPool.arn]
   * });
   * ```
   *
   * You can also customize the authorizer.
   *
   * ```js title="sst.config.ts"
   * api.addAuthorizer({
   *   name: "myAuthorizer",
   *   tokenFunction: "src/authorizer.index",
   *   ttl: 30
   * });
   * ```
   */
  public addAuthorizer(args: ApiGatewayRestAuthorizerArgs) {
    const name = this.componentName;
    const id = args.name;
    const what = `the "${id}" authorizer of the "${name}" API`;
    this.assertNew("authorizer", "authorizer", id, args, [
      "authorizer",
      "authorizerFunction",
      "authorizerPermission",
    ]);
    const given = [
      args.requestFunction,
      args.tokenFunction,
      args.userPools,
    ].filter((v) => v);
    if (given.length !== 1)
      throw new VisibleError(
        `${what[0].toUpperCase()}${what.slice(1)} is given ${
          given.length ? "more than one" : "none"
        } of "requestFunction", "tokenFunction" and "userPools". Give it one of them.`,
      );

    const { api } = this.nodes;
    const fnKey = args.tokenFunction ? "tokenFunction" : "requestFunction";
    const definition = args.tokenFunction ?? args.requestFunction;
    const fn = definition
      ? functionPart(
          this,
          "authorizerFunction",
          id,
          plainFunction(definition, `The "${fnKey}" of ${what}`),
          { description: `${name} authorizer` },
        )
      : undefined;
    const authorizer = this.part("authorizer", id, {
      restApi: api.id,
      type: args.tokenFunction
        ? "TOKEN"
        : args.requestFunction
          ? "REQUEST"
          : "COGNITO_USER_POOLS",
      name: args.name,
      providerArns: args.userPools,
      authorizerUri: fn?.targetInvokeArn,
      authorizerResultTtlInSeconds: args.ttl,
      identitySource: args.identitySource,
    });
    if (fn)
      this.part(
        "authorizerPermission",
        id,
        authorizerPermissionArgs(fn, api.executionArn, authorizer.id),
      );
    return authorizer;
  }

  /**
   * Add a usage plan to the API Gateway REST API.
   *
   * @param name The name of the usage plan.
   * @param args Configure the usage plan.
   * @example
   *
   * To add a usage plan to an API, you need to enable the API key for a route, and
   * then deploy the API.
   *
   * ```ts title="sst.config.ts" {4}
   * const api = new sst.aws.ApiGatewayRest("MyApi");
   *
   * api.route("GET /", "src/get.handler", {
   *   apiKey: true
   * });
   *
   * api.deploy();
   * ```
   *
   * Then define your usage plan.
   *
   * ```js title="sst.config.ts"
   * const plan = api.addUsagePlan("MyPlan", {
   *   throttle: {
   *     rate: 100,
   *     burst: 200
   *   },
   *   quota: {
   *     limit: 1000,
   *     period: "month",
   *     offset: 0
   *   }
   * });
   * ```
   *
   * And create the API key for the plan.
   *
   * ```js title="sst.config.ts"
   * const key = plan.addApiKey("MyKey");
   * ```
   *
   * You can now link the API and API key to other resources, like a function.
   *
   * ```ts title="sst.config.ts"
   * new sst.aws.Function("MyFunction", {
   *   handler: "src/lambda.handler",
   *   link: [api, key]
   * });
   * ```
   *
   * Once linked, include the key in the `x-api-key` header with your requests.
   *
   * ```ts title="src/lambda.ts"
   * import { Resource } from "sst";
   *
   * await fetch(Resource.MyApi.url, {
   *   headers: {
   *     "x-api-key": Resource.MyKey.value
   *   }
   * });
   * ```
   */
  public addUsagePlan(name: string, args: ApiGatewayRestUsagePlanArgs) {
    const { api, stage } = this.nodes;
    if (!stage)
      throw new VisibleError(
        `The "${name}" usage plan is added to the "${this.componentName}" API before "deploy()", which makes the stage it's for. Call "deploy()" first.`,
      );
    // Next to the API, as SST 4 made it
    return new ApiGatewayRestUsagePlan(
      name,
      { ...args, apiId: api.id, apiStage: stage.stageName },
      { provider: this.componentOpts.provider },
    );
  }

  /**
   * Creates a deployment for the API Gateway REST API.
   *
   * :::caution
   * Your routes won't be added if `deploy` isn't called.
   * :::
   *
   * Your routes won't be added if this isn't called after you've added them. This
   * is due to a quirk in the way API Gateway creates REST APIs.
   */
  public deploy() {
    const name = this.componentName;
    if (this.deployed)
      throw new VisibleError(
        `The "${name}" API is already deployed. Call "deploy()" once, after adding every route.`,
      );
    this.deployed = true;
    const { api } = this.nodes;

    // CORS: an OPTIONS method on each path with a route, and the headers on
    // API Gateway's errors
    if (this.cors) {
      const paths = new Set([...this.routes.values()].map((r) => r.path));
      for (const path of paths) {
        const resourceId = this.resources.get(path)!;
        const corsMethod = this.part("corsMethod", path, {
          restApi: api.id,
          resourceId,
          httpMethod: "OPTIONS",
          authorization: "NONE",
        });
        const corsMethodResponse = this.part("corsMethodResponse", path, {
          restApi: api.id,
          resourceId,
          httpMethod: corsMethod.httpMethod,
          statusCode: "204",
          responseParameters: {
            "method.response.header.Access-Control-Allow-Headers": true,
            "method.response.header.Access-Control-Allow-Methods": true,
            "method.response.header.Access-Control-Allow-Origin": true,
          },
        });
        const corsIntegration = this.part("corsIntegration", path, {
          restApi: api.id,
          resourceId,
          httpMethod: corsMethod.httpMethod,
          type: "MOCK",
          requestTemplates: {
            "application/json": "{ statusCode: 200 }",
          },
        });
        this.part(
          "corsIntegrationResponse",
          path,
          {
            restApi: api.id,
            resourceId,
            httpMethod: corsMethod.httpMethod,
            statusCode: corsMethodResponse.statusCode,
            responseParameters: {
              "method.response.header.Access-Control-Allow-Headers": "'*'",
              "method.response.header.Access-Control-Allow-Methods":
                "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'",
              "method.response.header.Access-Control-Allow-Origin": "'*'",
            },
          },
          { dependsOn: [corsIntegration] },
        );
      }
      for (const type of ["4XX", "5XX"])
        this.part("corsResponse", type, {
          restApiId: api.id,
          responseType: `DEFAULT_${type}`,
          responseParameters: {
            "gatewayresponse.header.Access-Control-Allow-Origin": "'*'",
            "gatewayresponse.header.Access-Control-Allow-Headers": "'*'",
          },
          responseTemplates: {
            "application/json": '{"message":$context.error.messageString}',
          },
        });
    }

    // A new deployment whenever a route, or what CORS added, changes
    const deployment = this.part("deployment", {
      restApi: api.id,
      triggers: triggersOf(this.deployedResources()),
    });
    const logGroup = this.part("logGroup", ...this.logGroupArgs);
    const stage = this.part("stage", {
      restApi: api.id,
      stageName: context().app.stage,
      deployment: deployment.id,
      accessLogSettings: {
        destinationArn: logGroup.arn,
        format: ACCESS_LOG_FORMAT,
      },
    });

    const domain = this.domain;
    if (domain) {
      const domainName =
        this.existingPart("domainName") ??
        this.createDomainName(domain.create!);
      this.part("domainMapping", {
        restApi: api.id,
        domainName: domainName.id,
        stageName: stage.stageName,
        basePath: domain.path,
      });
    }

    this.report({ hint: this.url });
    super.registerOutputs();
    return this;
  }

  // What the deployment is made of, as SST 4 had it: the API, what CORS
  // added, and each route's integration and method
  private deployedResources(): Resource[] {
    const n = this.nodes;
    return [
      n.api,
      ...Object.keys(n.corsMethod).flatMap((path) => [
        n.corsMethod[path],
        n.corsMethodResponse[path],
        n.corsIntegration[path],
        n.corsIntegrationResponse[path],
      ]),
      ...Object.values(n.corsResponse),
      ...[...this.routes.keys()].flatMap((id) => [
        n.integration[id],
        n.method[id],
      ]),
    ];
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it
  private createDomainName(domain: ApiDomain) {
    const name = this.componentName;
    const edge = this.endpointType === "EDGE";
    // An edge API's certificate is in us-east-1: made with the API's own
    // provider when that's in us-east-1, as SST 4 made it, and with one of
    // its own if not
    const certificate = domain.cert
      ? undefined
      : this.after(edge ? this.inUsEast1() : Promise.resolve(true), (here) =>
          this.part(
            "certificate",
            { domainName: domain.name, dns: domain.dns! },
            here ? {} : { provider: useProvider("us-east-1") },
          ),
        );
    const certificateArn =
      domain.cert ?? output(certificate!).apply((cert) => cert.arn);
    const domainName = this.part("domainName", {
      domainName: domain.name,
      endpointConfiguration: { types: this.endpointType },
      ...(this.endpointType === "REGIONAL"
        ? { regionalCertificateArn: certificateArn }
        : { certificateArn }),
    });
    domain.dns?.alias(
      name,
      {
        name: domain.name,
        aliasName: edge
          ? domainName.cloudfrontDomainName
          : domainName.regionalDomainName,
        aliasZone: edge
          ? domainName.cloudfrontZoneId
          : domainName.regionalZoneId,
      },
      this.delegateOpts(),
    );
    return domainName;
  }

  // Whether the API's provider is in us-east-1: the app's, whose region is in
  // the app's config, or one given to the API, once its region is known
  private async inUsEast1() {
    if (!this.getProvider("aws::"))
      return new Config("aws").get("region") === "us-east-1";
    return (await knownValue(this.region)) === "us-east-1";
  }

  /**
   * What SST 4 named a route's component after, and its kind.
   * @internal
   */
  public routeOf(id: string) {
    return this.routes.get(id);
  }

  /**
   * The id of the resource of a path with a route.
   * @internal
   */
  public resourceIdOf(path: string) {
    return this.resources.get(path);
  }

  link() {
    return {
      properties: {
        url: this.url,
      },
    };
  }
}

interface Route {
  kind: "lambda" | "integration";
  named: boolean;
  method: string;
  path: string;
}

// The key of a path's resource: the hash SST 4 named it with. That was a hash
// of `[api.id, path].join("")`, where the id is an output, which joins as the
// text Pulumi gives an output in place of its value: the same for every API.
// It's kept here as Pulumi gives it since 3.134, so a later change to it
// doesn't rename the resources.
function resourceKey(path: string) {
  return logicalName(hashStringToPrettyString(OUTPUT_TEXT + path, 6));
}

const OUTPUT_TEXT =
  "Calling [toString] on an [Output<T>] is not supported.\n\nTo get the value of an Output<T> as an Output<string> consider either:\n1: o.apply(v => `prefix${v}suffix`)\n2: pulumi.interpolate `prefix${v}suffix`\n\nSee https://www.pulumi.com/docs/concepts/inputs-outputs for more details.\n\nOr use ESLint with https://github.com/pulumi/eslint-plugin-pulumi to warn or\nerror lint on using Output<T> in template literals.\nThis function may throw in a future version of @pulumi/pulumi.";

// A deployment's triggers, as SST 4 made them: each resource's settings, by
// its URN, so a change to any makes a new deployment. Empty settings are left
// out: a refresh reads them back from AWS as `[]`, `{}` or `""` where the
// state had none, which made SST 4's API deploy again after every refresh.
function triggersOf(resources: Resource[]) {
  return all(
    resources.map((resource) =>
      Object.fromEntries(
        Object.entries(resource).filter(
          ([key, value]) => !key.startsWith("_") && typeof value !== "function",
        ),
      ),
    ),
  ).apply((resources) =>
    Object.fromEntries(
      resources.map((resource) => [
        resource.urn,
        JSON.stringify(withoutEmpty(resource)),
      ]),
    ),
  );
}

// A value without its empty settings: nothing, `[]`, `{}` or `""`
function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(withoutEmpty).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, v]) => [key, withoutEmpty(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === "" ? undefined : value;
}

const ACCESS_LOG_FORMAT = JSON.stringify({
  // request info
  requestTime: `"$context.requestTime"`,
  requestId: `"$context.requestId"`,
  httpMethod: `"$context.httpMethod"`,
  path: `"$context.path"`,
  resourcePath: `"$context.resourcePath"`,
  status: `$context.status`, // integer value, do not wrap in quotes
  responseLatency: `$context.responseLatency`, // integer value, do not wrap in quotes
  xrayTraceId: `"$context.xrayTraceId"`,
  // integration info
  functionResponseStatus: `"$context.integration.status"`,
  integrationRequestId: `"$context.integration.requestId"`,
  integrationLatency: `"$context.integration.latency"`,
  integrationServiceStatus: `"$context.integration.integrationStatus"`,
  // caller info
  ip: `"$context.identity.sourceIp"`,
  userAgent: `"$context.identity.userAgent"`,
  principalId: `"$context.authorizer.principalId"`,
});
