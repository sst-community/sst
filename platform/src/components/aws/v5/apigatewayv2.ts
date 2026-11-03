import {
  ComponentResourceOptions,
  all,
  interpolate,
  output,
  type Unwrap,
} from "@pulumi/pulumi";
import { apigatewayv2, cloudwatch, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  optional,
} from "../../parts-component";
import type { Prettify } from "../../component";
import { ifSet, plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { type Duration, type DurationHours, toSeconds } from "../../duration";
import { physicalName } from "../../naming";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function, type FunctionArgs } from "./function";
import { type DomainArgs, domainOf } from "../helpers/domain";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { RETENTION } from "../logging";
import { type AnyVpc, assertVpcIds, isVpc, subnetsOf } from "../helpers/vpc";

const parts = () => ({
  /**
   * The Amazon API Gateway HTTP API.
   */
  api: apigatewayv2.Api,
  /**
   * The API's `$default` stage.
   */
  stage: apigatewayv2.Stage,
  /**
   * The CloudWatch log group for the access logs.
   */
  logGroup: cloudwatch.LogGroup,
  /**
   * The VPC link, created when `vpc` is set.
   */
  vpcLink: optional(apigatewayv2.VpcLink),
  /**
   * The certificate for the custom domain, created when `domain` is set
   * without a `cert`.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The API Gateway custom domain name, when `domain` is set.
   */
  domainName: optional(apigatewayv2.DomainName),
  /**
   * The mapping between the custom domain name and the API.
   */
  domainMapping: optional(apigatewayv2.ApiMapping),
  /**
   * The function behind each route added with `route`, by route.
   */
  handler: many(deferred(Function)),
  /**
   * The permission that lets the API invoke each handler, by route.
   */
  permission: many(lambda.Permission),
  /**
   * The integration behind each route, by route.
   */
  integration: many(apigatewayv2.Integration),
  /**
   * The API's routes, by route.
   */
  route: many(apigatewayv2.Route),
  /**
   * The API's authorizers, by authorizer name.
   */
  authorizer: many(apigatewayv2.Authorizer),
  /**
   * The function behind each Lambda authorizer, by authorizer name.
   */
  authorizerFunction: many(deferred(Function)),
  /**
   * The permission that lets the API invoke each authorizer function, by
   * authorizer name.
   */
  authorizerPermission: many(lambda.Permission),
});

export interface ApiGatewayV2CorsArgs {
  /**
   * Allow cookies or other credentials in requests to the HTTP API.
   * @default `false`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowCredentials: true
   *   }
   * }
   * ```
   */
  allowCredentials?: Input<boolean>;
  /**
   * The HTTP headers that origins can include in requests to the HTTP API.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowHeaders: ["date", "keep-alive", "x-custom-header"]
   *   }
   * }
   * ```
   */
  allowHeaders?: Input<Input<string>[]>;
  /**
   * The origins that can access the HTTP API.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowOrigins: ["https://www.example.com", "http://localhost:60905"]
   *   }
   * }
   * ```
   * Or the wildcard for all origins.
   * ```js
   * {
   *   cors: {
   *     allowOrigins: ["*"]
   *   }
   * }
   * ```
   */
  allowOrigins?: Input<Input<string>[]>;
  /**
   * The HTTP methods that are allowed when calling the HTTP API.
   * @default `["*"]`
   * @example
   * ```js
   * {
   *   cors: {
   *     allowMethods: ["GET", "POST", "DELETE"]
   *   }
   * }
   * ```
   * Or the wildcard for all methods.
   * ```js
   * {
   *   cors: {
   *     allowMethods: ["*"]
   *   }
   * }
   * ```
   */
  allowMethods?: Input<
    Input<
      "*" | "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"
    >[]
  >;
  /**
   * The HTTP headers you want to expose in your function to an origin that calls the HTTP API.
   * @default `[]`
   * @example
   * ```js
   * {
   *   cors: {
   *     exposeHeaders: ["date", "keep-alive", "x-custom-header"]
   *   }
   * }
   * ```
   */
  exposeHeaders?: Input<Input<string>[]>;
  /**
   * The maximum amount of time the browser can cache results of a preflight request. By
   * default the browser doesn't cache the results. The maximum value is `86400 seconds` or `1 day`.
   * @default `"0 seconds"`
   * @example
   * ```js
   * {
   *   cors: {
   *     maxAge: "1 day"
   *   }
   * }
   * ```
   */
  maxAge?: Input<Duration>;
}

export interface ApiGatewayV2DomainArgs extends DomainArgs {
  /**
   * The base mapping for the custom domain. This adds a suffix to the URL of the API.
   *
   * @example
   *
   * Given the following base path and domain name.
   *
   * ```js
   * {
   *   domain: {
   *     name: "api.example.com",
   *     path: "v1"
   *   }
   * }
   * ```
   *
   * The full URL of the API will be `https://api.example.com/v1/`.
   *
   * :::note
   * There's an extra trailing slash when a base path is set.
   * :::
   *
   * By default there is no base path, so if the `name` is `api.example.com`, the full URL will be `https://api.example.com`.
   */
  path?: Input<string>;
}

export interface ApiGatewayV2Args extends ComponentArgs<typeof parts> {
  /**
   * [Link resources](/docs/linking/) to all your API Gateway routes.
   *
   * Linked resources will be merged with the resources linked to each route.
   *
   * @example
   *
   * Takes a list of resources to link to all the routes.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: FunctionArgs["link"];
  /**
   * Set a custom domain for your HTTP API.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and Vercel. For other
   * providers, you'll need to pass in a `cert` that validates domain ownership and add the
   * DNS records.
   *
   * The domain has to be a plain value, and so do its `name` and `dns`: they decide the
   * certificate and the DNS records.
   *
   * :::tip
   * Built-in support for AWS Route 53, Cloudflare, and Vercel. And manual setup for other
   * providers.
   * :::
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
   *
   * To put this API under a path of a domain name another API created, pass that domain
   * name in `existing`, and leave out the `name`.
   *
   * ```js
   * {
   *   domain: { path: "v2" },
   *   existing: { domainName: "api.example.com" }
   * }
   * ```
   */
  domain?: string | Prettify<Partial<ApiGatewayV2DomainArgs>>;
  /**
   * Customize the CORS (Cross-origin resource sharing) settings for your HTTP API.
   * @default `true`
   * @example
   * Disable CORS. This omits CORS configuration entirely (`CorsConfiguration` is
   * unset). An empty config object is not the same — AWS treats that as CORS
   * enabled with no allowed origins or headers.
   * ```js
   * {
   *   cors: false
   * }
   * ```
   * Only enable the `GET` and `POST` methods for `https://example.com`.
   * ```js
   * {
   *   cors: {
   *     allowMethods: ["GET", "POST"],
   *     allowOrigins: ["https://example.com"]
   *   }
   * }
   * ```
   */
  cors?: Input<boolean | Prettify<ApiGatewayV2CorsArgs>>;
  /**
   * Configure the [API Gateway logs](https://docs.aws.amazon.com/apigateway/latest/developerguide/view-cloudwatch-log-events-in-cloudwatch-console.html) in CloudWatch. By default, access logs are enabled and kept for 1 month.
   * @default `{retention: "1 month"}`
   * @example
   * ```js
   * {
   *   accessLog: {
   *     retention: "forever"
   *   }
   * }
   * ```
   */
  accessLog?: Input<{
    /**
     * The duration the API Gateway logs are kept in CloudWatch.
     * @default `1 month`
     */
    retention?: Input<keyof typeof RETENTION>;
  }>;
  /**
   * Configure the API to connect to private resources in a virtual private cloud or VPC.
   * This creates a VPC link for your HTTP API.
   *
   * @example
   * Create a `Vpc` component.
   *
   * ```js title="sst.config.ts"
   * const myVpc = new sst.aws.v5.Vpc("MyVpc");
   * ```
   *
   * Or reference an existing VPC.
   *
   * ```js title="sst.config.ts"
   * const myVpc = sst.aws.v5.Vpc.get("MyVpc", "vpc-12345678901234567");
   * ```
   *
   * And pass it in. The VPC link will be placed in the public subnets.
   *
   * ```js
   * {
   *   vpc: myVpc
   * }
   * ```
   *
   * The above is equivalent to:
   *
   * ```js
   * {
   *   vpc: {
   *     securityGroups: myVpc.securityGroups,
   *     subnets: myVpc.publicSubnets
   *   }
   * }
   * ```
   */
  vpc?:
    | AnyVpc
    | Input<{
        /**
         * A list of VPC security group IDs.
         */
        securityGroups: Input<Input<string>[]>;
        /**
         * A list of VPC subnet IDs.
         */
        subnets: Input<Input<string>[]>;
      }>;
}

export interface ApiGatewayV2RouteArgs {
  /**
   * Enable auth for your HTTP API. By default, auth is disabled.
   *
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
         * Enable IAM authorization for a given API route. When IAM auth is enabled, clients
         * need to use Signature Version 4 to sign their requests with their AWS credentials.
         */
        iam?: Input<boolean>;
        /**
         * Enable JWT or JSON Web Token authorization for a given API route. When JWT auth is enabled, clients need to include a valid JWT in their requests.
         *
         * @example
         * You can configure JWT auth.
         *
         * ```js
         * {
         *   auth: {
         *     jwt: {
         *       authorizer: myAuthorizer.id,
         *       scopes: ["read:profile", "write:profile"]
         *     }
         *   }
         * }
         * ```
         *
         * Where `myAuthorizer` is created by calling the `addAuthorizer` method.
         */
        jwt?: Input<{
          /**
           * Authorizer ID of the JWT authorizer.
           */
          authorizer: Input<string>;
          /**
           * Defines the permissions or access levels that the JWT grants. If the JWT does not have the required scope, the request is rejected. By default it does not require any scopes.
           */
          scopes?: Input<Input<string>[]>;
        }>;
        /**
         * Enable custom Lambda authorization for a given API route. Pass in the authorizer ID.
         *
         * @example
         * ```js
         * {
         *   auth: {
         *     lambda: myAuthorizer.id
         *   }
         * }
         * ```
         *
         * Where `myAuthorizer` is created by calling the `addAuthorizer` method.
         */
        lambda?: Input<string>;
      }
  >;
  /**
   * A name for the route. It's used in place of the route itself in the names
   * of the route's resources, and as the route's id in the API's `nodes` and
   * `transform`.
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

export interface ApiGatewayV2AuthorizerArgs {
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
   * Create a JWT or JSON Web Token authorizer that can be used by the routes.
   *
   * @example
   * Configure JWT auth.
   *
   * ```js
   * {
   *   jwt: {
   *     issuer: "https://issuer.com/",
   *     audiences: ["https://api.example.com"],
   *     identitySource: "$request.header.AccessToken"
   *   }
   * }
   * ```
   *
   * You can also use Cognito as the identity provider.
   *
   * ```js
   * {
   *   jwt: {
   *     audiences: [userPoolClient.id],
   *     issuer: $interpolate`https://cognito-idp.${aws.getArnOutput(userPool).region}.amazonaws.com/${userPool.id}`,
   *   }
   * }
   * ```
   *
   * Where `userPool` and `userPoolClient` are:
   *
   * ```js
   * const userPool = new aws.cognito.UserPool();
   * const userPoolClient = new aws.cognito.UserPoolClient();
   * ```
   */
  jwt?: Input<{
    /**
     * Base domain of the identity provider that issues JSON Web Tokens.
     * @example
     * ```js
     * {
     *   issuer: "https://issuer.com/"
     * }
     * ```
     */
    issuer: Input<string>;
    /**
     * List of the intended recipients of the JWT. A valid JWT must provide an `aud` that matches at least one entry in this list.
     */
    audiences: Input<Input<string>[]>;
    /**
     * Specifies where to extract the JWT from the request.
     * @default `"$request.header.Authorization"`
     */
    identitySource?: Input<string>;
  }>;
  /**
   * Create a Lambda authorizer that can be used by the routes. A plain value: it decides
   * whether a function is created.
   *
   * @example
   * Configure Lambda auth.
   *
   * ```js
   * {
   *   lambda: {
   *     function: "src/authorizer.index"
   *   }
   * }
   * ```
   */
  lambda?: {
    /**
     * The Lambda authorizer function. Takes the handler path or the function args, which
     * are plain values, or a function you already have, or its ARN.
     * @example
     * Add a simple authorizer.
     *
     * ```js
     * {
     *   function: "src/authorizer.index"
     * }
     * ```
     *
     * Customize the authorizer handler.
     *
     * ```js
     * {
     *   function: {
     *     handler: "src/authorizer.index",
     *     memory: "2048 MB"
     *   }
     * }
     * ```
     */
    function: FunctionInput;
    /**
     * The JWT payload version.
     * @default `"2.0"`
     * @example
     * ```js
     * {
     *   payload: "2.0"
     * }
     * ```
     */
    payload?: Input<"1.0" | "2.0">;
    /**
     * The response type.
     * @default `"simple"`
     * @example
     * ```js
     * {
     *   response: "iam"
     * }
     * ```
     */
    response?: Input<"simple" | "iam">;
    /**
     * The time to live (TTL) for the authorizer.
     * @default Not cached
     * @example
     * ```js
     * {
     *   ttl: "300 seconds"
     * }
     * ```
     */
    ttl?: Input<DurationHours>;
    /**
     * Specifies where to extract the identity from.
     * @default `["$request.header.Authorization"]`
     * @example
     * ```js
     * {
     *   identitySources: ["$request.header.RequestToken"]
     * }
     * ```
     */
    identitySources?: Input<Input<string>[]>;
  };
}

/**
 * The `ApiGatewayV2` component lets you add an [Amazon API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes the resources of each
 * route.
 *
 * @example
 *
 * #### Create the API
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.v5.ApiGatewayV2("MyApi");
 * ```
 *
 * #### Add a custom domain
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.ApiGatewayV2("MyApi", {
 *   domain: "api.example.com"
 * });
 * ```
 *
 * #### Add routes
 *
 * ```ts title="sst.config.ts"
 * api.route("GET /", "src/get.handler");
 * api.route("POST /", "src/post.handler");
 * ```
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
 * ```ts title="sst.config.ts"
 * api.route("POST /", {
 *   handler: "src/post.handler",
 *   memory: "2048 MB"
 * });
 * ```
 *
 * #### Default props for all routes
 *
 * Use the `transform` to change every route's handler, integration or route. An object
 * is merged into each one.
 *
 * ```ts title="sst.config.ts" {3}
 * const api = new sst.aws.v5.ApiGatewayV2("MyApi", {
 *   transform: {
 *     handler: { memory: "2048 MB" }
 *   }
 * });
 * ```
 *
 * A function is also given the route, so it can change one of them.
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.v5.ApiGatewayV2("MyApi", {
 *   transform: {
 *     handler: (args, opts, name, route) => {
 *       if (route === "POST /upload") args.timeout = "60 seconds";
 *     }
 *   }
 * });
 * ```
 *
 * #### Switch from `sst.aws.ApiGatewayV2`
 *
 * Change `sst.aws.ApiGatewayV2` to `sst.aws.v5.ApiGatewayV2` and keep the name. The API,
 * its domain, its routes, their functions and its authorizers are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const api = new sst.aws.ApiGatewayV2("MyApi");
 * const api = new sst.aws.v5.ApiGatewayV2("MyApi");
 * ```
 *
 * A few things work differently:
 *
 * - `route`, `routeUrl` and `routePrivate` return the API, so calls chain. What a route
 *   creates is in the API's `nodes`, by route: `api.nodes.handler["GET /"]`.
 *   `addAuthorizer` returns the authorizer resource, so `authorizer.id` reads the same.
 * - A route's own `transform`, an authorizer's own `transform`, and the API's
 *   `transform.route.handler` become the API's `transform` for `handler`, `integration`,
 *   `route` and `authorizer`. `transform.route.args` is gone: give each route its `auth`,
 *   or set `authorizationType` in `transform.route`.
 * - `domain.nameId` becomes `existing: { domainName }`.
 * - `domain`, with its `name` and `dns`, has to be a plain value, not an output. So do a
 *   route's handler and an authorizer's `lambda` with its `function`: they decide what's
 *   created. A function you already have, or its ARN, can still be an output.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - `domain.dns` is an adapter SST 5's components use, like `sst.aws.dns()`,
 *   `sst.cloudflare.dns()` or `sst.vercel.dns()`. An object written by hand for SST 4's
 *   doesn't work.
 * - The DNS records that validate the certificate are named after the domain they
 *   validate, and a domain's hosted zone is found without a resource: SST 4's
 *   `HostedZoneLookup`, and Cloudflare's `ZoneLookup`, leave the state.
 * - `nodes` has every resource, the certificate and each route's included. Reading
 *   `nodes.domainName` without a domain gives `undefined`, where it failed.
 */
export class ApiGatewayV2 extends component("sst:aws:ApiGatewayV2", parts) {
  private handlerLink: FunctionArgs["link"];

  constructor(
    name: string,
    args: ApiGatewayV2Args = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    this.handlerLink = args.link;

    const routeTransform = args.transform?.route;
    if (
      typeof routeTransform === "object" &&
      ("handler" in routeTransform || "args" in routeTransform)
    )
      throw new VisibleError(
        `In the "${name}" API, "transform.route" changes each route's API Gateway route, so it has no "handler" or "args". To change the routes' functions, use "transform.handler". To give the routes an auth, give it in each route's args, or set "authorizationType" in "transform.route".`,
      );

    const vpc = vpcLinkNetwork(args.vpc, `the "${name}" API`);
    if (vpc)
      this.part("vpcLink", {
        securityGroupIds: vpc.securityGroups,
        subnetIds: vpc.subnets,
      });

    const api = this.part("api", {
      protocolType: "HTTP",
      corsConfiguration: output(args.cors).apply(corsConfiguration),
    });

    const logGroup = this.part(
      "logGroup",
      {
        name: `/aws/vendedlogs/apis/${physicalName(64, name)}`,
        retentionInDays: output(args.accessLog).apply(
          (accessLog) => RETENTION[accessLog?.retention ?? "1 month"],
        ),
      },
      { ignoreChanges: ["name"] },
    );

    const stage = this.part("stage", {
      apiId: api.id,
      autoDeploy: true,
      name: "$default",
      accessLogSettings: {
        destinationArn: logGroup.arn,
        format: ACCESS_LOG_FORMAT,
      },
    });

    const existingDomainName = this.existingPart("domainName");
    const domain = plain(args.domain, `The "domain" of the "${name}" API`);
    if (domain || existingDomainName) {
      const given =
        typeof domain === "string" ? { name: domain } : domain ?? {};
      if ("nameId" in given)
        throw new VisibleError(
          `The "domain.nameId" of the "${name}" API is given in "existing" now: { domain: { path }, existing: { domainName: "..." } }.`,
        );
      if (existingDomainName && given.name)
        throw new VisibleError(
          `The "${name}" API is given an existing "domainName", so it doesn't create one. Remove "name" from its domain.`,
        );

      const domainName = existingDomainName ?? this.createDomainName(given);
      this.part("domainMapping", {
        apiId: api.id,
        domainName: domainName.id,
        stage: stage.name,
        apiMappingKey: given.path,
      });
    }

    this.report({ hint: this.url });
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it.
  private createDomainName(args: Partial<ApiGatewayV2DomainArgs>) {
    const name = this.componentName;
    if (!args.name)
      throw new VisibleError(
        `Domain "name" is required for the "${name}" API. To use a domain name you already have, pass it in "existing".`,
      );
    const domain = domainOf(args, `the "${name}" API`);

    const certificateArn =
      domain.cert ??
      this.part("certificate", { domainName: domain.name, dns: domain.dns! })
        .arn;
    const domainName = this.part("domainName", {
      domainName: domain.name,
      domainNameConfiguration: {
        certificateArn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2",
      },
    });
    domain.dns?.alias(
      name,
      {
        name: domain.name,
        aliasName: domainName.domainNameConfiguration.targetDomainName,
        aliasZone: domainName.domainNameConfiguration.hostedZoneId,
      },
      this.delegateOpts(),
    );
    return domainName;
  }

  /**
   * The URL of the API.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the auto-generated API Gateway URL.
   */
  public get url() {
    const { api, domainName, domainMapping } = this.nodes;
    // Note: If mapping key is set, the URL needs a trailing slash. Without the
    //       trailing slash, the API fails with the error {"message":"Not Found"}
    return domainName && domainMapping
      ? all([domainName.domainName, domainMapping.apiMappingKey]).apply(
          ([domain, key]) =>
            key ? `https://${domain}/${key}/` : `https://${domain}`,
        )
      : api.apiEndpoint;
  }

  /**
   * Add a route to the API Gateway HTTP API. The route is a combination of
   * - An HTTP method and a path, `{METHOD} /{path}`.
   * - Or a `$default` route.
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
   * The `$default` route is a catch-all. It's invoked when no other route matches.
   *
   * :::note
   * You cannot have duplicate routes.
   * :::
   *
   * @param rawRoute The path for the route.
   * @param handler The function that'll be invoked: its handler or its args, which are
   * plain values, or a function you already have, or its ARN.
   * @param args Configure the route.
   *
   * @example
   * Add a simple route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", "src/get.handler");
   * ```
   *
   * Add a default or fallback route.
   *
   * ```js title="sst.config.ts"
   * api.route("$default", "src/default.handler");
   * ```
   *
   * Add a parameterized route.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /notes/{id}", "src/get.handler");
   * ```
   *
   * Enable auth for a route.
   *
   * ```js title="sst.config.ts"
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
   *
   * The route's resources are in the API's `nodes`, by route.
   *
   * ```js title="sst.config.ts"
   * api.nodes.handler["GET /"];
   * ```
   */
  public route(
    rawRoute: string,
    handler: FunctionInput,
    args: ApiGatewayV2RouteArgs = {},
  ) {
    const { id, route } = this.newRoute(rawRoute, args);

    const fn = functionPart(
      this,
      "handler",
      id,
      plainFunction(
        handler,
        `The handler of the "${route}" route of the "${this.componentName}" API`,
      ),
      {
        description: `${this.componentName} route ${route}`,
        link: this.handlerLink,
      },
    );
    const permission = this.part(
      "permission",
      id,
      invokePermissionArgs(
        fn,
        "apigateway.amazonaws.com",
        interpolate`${this.nodes.api.executionArn}/*`,
      ),
    );

    return this.integrate(
      id,
      route,
      args,
      {
        integrationType: "AWS_PROXY",
        integrationUri: fn.targetArn,
        payloadFormatVersion: "2.0",
      },
      { dependsOn: [permission] },
    );
  }

  /**
   * Add a URL route to the API Gateway HTTP API.
   *
   * @param rawRoute The path for the route.
   * @param url The URL to forward to.
   * @param args Configure the route.
   *
   * @example
   * Add a simple route.
   *
   * ```js title="sst.config.ts"
   * api.routeUrl("GET /", "https://google.com");
   * ```
   *
   * Enable auth for a route.
   *
   * ```js title="sst.config.ts"
   * api.routeUrl("POST /", "https://google.com", {
   *   auth: {
   *     iam: true
   *   }
   * });
   * ```
   */
  public routeUrl(
    rawRoute: string,
    url: Input<string>,
    args: ApiGatewayV2RouteArgs = {},
  ) {
    const { id, route } = this.newRoute(rawRoute, args);
    return this.integrate(id, route, args, {
      integrationType: "HTTP_PROXY",
      integrationUri: url,
      integrationMethod: "ANY",
    });
  }

  /**
   * Adds a private route to the API Gateway HTTP API.
   *
   * To add private routes, you need to have a VPC link. Make sure to pass in a `vpc`.
   * Learn more about [adding private routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html).
   *
   * A couple of things to note:
   *
   * 1. Your API Gateway HTTP API also needs to be in the **same VPC** as the service.
   *
   * 2. You also need to verify that your VPC's [**availability zones support VPC link**](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vpc-links.html#http-api-vpc-link-availability).
   *
   * @param rawRoute The path for the route.
   * @param arn The ARN of the AWS Load Balancer or Cloud Map service.
   * @param args Configure the route.
   *
   * @example
   * Add a route to Application Load Balancer.
   *
   * ```js title="sst.config.ts"
   * const loadBalancerArn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-load-balancer/50dc6c495c0c9188";
   * api.routePrivate("GET /", loadBalancerArn);
   * ```
   *
   * Add a route to AWS Cloud Map service.
   *
   * ```js title="sst.config.ts"
   * const serviceArn = "arn:aws:servicediscovery:us-east-2:123456789012:service/srv-id?stage=prod&deployment=green_deployment";
   * api.routePrivate("GET /", serviceArn);
   * ```
   */
  public routePrivate(
    rawRoute: string,
    arn: Input<string>,
    args: ApiGatewayV2RouteArgs = {},
  ) {
    const vpcLink = this.nodes.vpcLink;
    if (!vpcLink)
      throw new VisibleError(
        `To add private routes, you need to have a VPC link. Configure "vpc" for the "${this.componentName}" API to create a VPC link.`,
      );

    const { id, route } = this.newRoute(rawRoute, args);
    return this.integrate(id, route, args, {
      connectionId: vpcLink.id,
      connectionType: "VPC_LINK",
      integrationType: "HTTP_PROXY",
      integrationUri: arn,
      integrationMethod: "ANY",
    });
  }

  // The route in the form API Gateway takes, and the id its resources are
  // kept under: its name, or the route itself.
  private newRoute(rawRoute: string, args: ApiGatewayV2RouteArgs) {
    const route = parseRoute(rawRoute);
    const id = args.name ?? route;
    this.assertNew("route", "route", id, args, [
      "handler",
      "integration",
      "route",
    ]);
    return { id, route };
  }

  // A route and the integration it sends requests to
  private integrate(
    id: string,
    route: string,
    args: ApiGatewayV2RouteArgs,
    integrationArgs: Omit<apigatewayv2.IntegrationArgs, "apiId">,
    opts?: ComponentResourceOptions,
  ) {
    const api = this.nodes.api;
    const auth = output(args.auth).apply(authorization);

    const integration = this.part(
      "integration",
      id,
      { apiId: api.id, ...integrationArgs },
      opts,
    );
    this.part("route", id, {
      apiId: api.id,
      routeKey: route,
      target: interpolate`integrations/${integration.id}`,
      authorizationType: auth.type,
      authorizerId: ifSet(auth.authorizer),
      authorizationScopes: ifSet(auth.scopes),
    });

    return this;
  }

  /**
   * Add an authorizer to the API Gateway HTTP API.
   *
   * @param args Configure the authorizer.
   * @example
   * Add a Lambda authorizer.
   *
   * ```js title="sst.config.ts"
   * api.addAuthorizer({
   *   name: "myAuthorizer",
   *   lambda: {
   *     function: "src/authorizer.index"
   *   }
   * });
   * ```
   *
   * Add a JWT authorizer.
   *
   * ```js title="sst.config.ts"
   * const authorizer = api.addAuthorizer({
   *   name: "myAuthorizer",
   *   jwt: {
   *     issuer: "https://issuer.com/",
   *     audiences: ["https://api.example.com"],
   *     identitySource: "$request.header.AccessToken"
   *   }
   * });
   * ```
   *
   * Now you can use the authorizer in your routes.
   *
   * ```js title="sst.config.ts"
   * api.route("GET /", "src/get.handler", {
   *   auth: {
   *     jwt: {
   *       authorizer: authorizer.id
   *     }
   *   }
   * });
   * ```
   */
  public addAuthorizer(args: ApiGatewayV2AuthorizerArgs) {
    const { name } = args;
    this.assertNew("authorizer", "authorizer", name, args);
    if (!args.lambda === !args.jwt)
      throw new VisibleError(
        `Please provide one of "lambda" or "jwt" for the ${name} authorizer, and only one.`,
      );

    const api = this.nodes.api;

    if (args.jwt) {
      const jwt = output(args.jwt);
      return this.part("authorizer", name, {
        apiId: api.id,
        authorizerType: "JWT",
        identitySources: [
          jwt.apply((jwt) => jwt.identitySource ?? IDENTITY_SOURCE),
        ],
        jwtConfiguration: jwt.apply((jwt) => ({
          audiences: jwt.audiences,
          issuer: jwt.issuer,
        })),
      });
    }

    const what = `the "${name}" authorizer of the "${this.componentName}" API`;
    const settings = plain(args.lambda!, `The "lambda" of ${what}`);
    const fn = functionPart(
      this,
      "authorizerFunction",
      name,
      plainFunction(settings.function, `The "lambda.function" of ${what}`),
      {
        description: `${this.componentName} authorizer`,
      },
    );
    const authorizer = this.part("authorizer", name, {
      apiId: api.id,
      authorizerType: "REQUEST",
      identitySources: output(settings.identitySources).apply(
        (sources) => sources ?? [IDENTITY_SOURCE],
      ),
      authorizerUri: fn.targetInvokeArn,
      authorizerResultTtlInSeconds: output(settings.ttl).apply((ttl) =>
        toSeconds(ttl ?? "0 seconds"),
      ),
      authorizerPayloadFormatVersion: output(settings.payload).apply(
        (payload) => payload ?? "2.0",
      ),
      enableSimpleResponses: output(settings.response).apply(
        (response) => (response ?? "simple") === "simple",
      ),
    });
    this.part(
      "authorizerPermission",
      name,
      invokePermissionArgs(
        fn,
        "apigateway.amazonaws.com",
        interpolate`${api.executionArn}/authorizers/${authorizer.id}`,
      ),
    );

    return authorizer;
  }

  /**
   * Linking an API gives the linked resource its URL.
   */
  public link() {
    return {
      properties: { url: this.url },
    };
  }
}

const IDENTITY_SOURCE = "$request.header.Authorization";

const METHODS = [
  "ANY",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
];

const ACCESS_LOG_FORMAT = JSON.stringify({
  // request info
  requestTime: `"$context.requestTime"`,
  requestId: `"$context.requestId"`,
  httpMethod: `"$context.httpMethod"`,
  path: `"$context.path"`,
  routeKey: `"$context.routeKey"`,
  status: `$context.status`, // integer value, do not wrap in quotes
  responseLatency: `$context.responseLatency`, // integer value, do not wrap in quotes
  // integration info
  integrationRequestId: `"$context.integration.requestId"`,
  integrationStatus: `"$context.integration.status"`,
  integrationLatency: `"$context.integration.latency"`,
  integrationServiceStatus: `"$context.integration.integrationStatus"`,
  // caller info
  ip: `"$context.identity.sourceIp"`,
  userAgent: `"$context.identity.userAgent"`,
  //cognitoIdentityId:`"$context.identity.cognitoIdentityId"`, // not supported in us-west-2 region
});

type Cors = Exclude<Unwrap<ApiGatewayV2Args["cors"]>, undefined>;

function corsConfiguration(cors: Cors | undefined) {
  // Left out, not `{}`. AWS keeps `{}` as a CORS config that allows nothing,
  // and while an API has one it answers preflight requests itself.
  if (cors === false) return undefined;

  const defaults = {
    allowHeaders: ["*"],
    allowMethods: ["*"],
    allowOrigins: ["*"],
  };
  return cors === true || cors === undefined
    ? defaults
    : {
        ...defaults,
        ...cors,
        maxAge: cors.maxAge && toSeconds(cors.maxAge),
      };
}

type Auth = Exclude<Unwrap<ApiGatewayV2RouteArgs["auth"]>, undefined>;

// How a route is authorized, in the terms API Gateway takes
function authorization(auth: Auth | undefined): {
  type: string;
  authorizer: string | undefined;
  scopes: string[] | undefined;
} {
  const none = { type: "NONE", authorizer: undefined, scopes: undefined };
  if (!auth) return none;
  if (auth.iam) return { ...none, type: "AWS_IAM" };
  if (auth.lambda) return { ...none, type: "CUSTOM", authorizer: auth.lambda };
  if (auth.jwt)
    return {
      type: "JWT",
      authorizer: auth.jwt.authorizer,
      scopes: auth.jwt.scopes,
    };
  return none;
}

function parseRoute(rawRoute: string) {
  if (rawRoute.toLowerCase() === "$default") return "$default";

  const [methodRaw, path, ...rest] = rawRoute.split(" ");
  if (path === undefined || rest.length > 0)
    throw new VisibleError(
      `Invalid route ${rawRoute}. A route must be in the format "METHOD /path".`,
    );
  const method = methodRaw.toUpperCase();
  if (!METHODS.includes(method))
    throw new VisibleError(`Invalid method ${methodRaw} in route ${rawRoute}`);
  if (!path.startsWith("/"))
    throw new VisibleError(
      `Invalid path ${path} in route ${rawRoute}. Path must start with "/".`,
    );

  return `${method} ${path}`;
}

// Where the VPC link is: a `Vpc`'s public subnets and its security groups, or
// the ids it was given
function vpcLinkNetwork(vpc: ApiGatewayV2Args["vpc"], what: string) {
  if (!vpc) return;
  if (isVpc(vpc)) {
    // The two `Vpc`s type these differently
    const securityGroups: Input<Input<string>[]> = vpc.securityGroups;
    return {
      subnets: subnetsOf(vpc, "public"),
      securityGroups: output(securityGroups),
    };
  }
  assertVpcIds(vpc, what);
  const ids = output(vpc);
  return { subnets: ids.subnets, securityGroups: ids.securityGroups };
}
