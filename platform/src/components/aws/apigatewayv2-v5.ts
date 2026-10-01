import {
  ComponentResourceOptions,
  all,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { apigatewayv2, cloudwatch, lambda } from "@pulumi/aws";
import {
  V5Args,
  component,
  deferred,
  many,
  optional,
} from "../parts-component";
import { ifSet, plain } from "../args";
import type { Input } from "../input";
import { VisibleError } from "../error";
import { toSeconds } from "../duration";
import { physicalName } from "../naming";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import type { FunctionArgs, FunctionArn } from "./function";
import { FunctionV5 } from "./function-v5";
import { CustomDomainArgs, customDomain } from "./helpers/custom-domain";
import { functionPart } from "./helpers/function-part";
import { invokePermissionArgs } from "./helpers/function-permission";
import type { ApiGatewayV2DomainArgs } from "./helpers/apigatewayv2-domain";
import { RETENTION } from "./logging";
import { Vpc } from "./vpc";
import type {
  ApiGatewayV2Args,
  ApiGatewayV2AuthorizerArgs,
  ApiGatewayV2RouteArgs,
} from "./apigatewayv2";

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
  handler: many(deferred(FunctionV5)),
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
  authorizerFunction: many(deferred(FunctionV5)),
  /**
   * The permission that lets the API invoke each authorizer function, by
   * authorizer name.
   */
  authorizerPermission: many(lambda.Permission),
});

export interface ApiGatewayV2V5DomainArgs
  extends Omit<ApiGatewayV2DomainArgs, "nameId" | "dns">,
    Pick<CustomDomainArgs, "dns"> {}

export interface ApiGatewayV2V5Args
  extends V5Args<Omit<ApiGatewayV2Args, "domain">, typeof parts> {
  /**
   * Set a custom domain for your HTTP API.
   *
   * Automatically manages domains hosted on AWS Route 53, Cloudflare, and
   * Vercel. For other providers, pass in a `cert` that validates domain
   * ownership and add the DNS records yourself.
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
   * To put this API under a path of a domain name another API created, pass
   * that domain name in `existing`.
   *
   * ```js
   * {
   *   domain: { path: "v2" },
   *   existing: { domainName: "api.example.com" }
   * }
   * ```
   */
  domain?: string | ApiGatewayV2V5DomainArgs;
}

export interface ApiGatewayV2V5RouteArgs
  extends Omit<ApiGatewayV2RouteArgs, "name" | "transform"> {
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

export interface ApiGatewayV2V5AuthorizerArgs
  extends Omit<ApiGatewayV2AuthorizerArgs, "transform"> {}

/**
 * The `ApiGatewayV2V5` component lets you add an [Amazon API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html) to your app.
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
 * const api = new sst.aws.ApiGatewayV2V5("MyApi");
 * ```
 *
 * #### Add a custom domain
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.ApiGatewayV2V5("MyApi", {
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
 * const api = new sst.aws.ApiGatewayV2V5("MyApi", {
 *   transform: {
 *     handler: { memory: "2048 MB" }
 *   }
 * });
 * ```
 *
 * A function is also given the route, so it can change one of them.
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.ApiGatewayV2V5("MyApi", {
 *   transform: {
 *     handler: (args, opts, name, route) => {
 *       if (route === "POST /upload") args.timeout = "60 seconds";
 *     }
 *   }
 * });
 * ```
 *
 * #### Switch from `ApiGatewayV2`
 *
 * Change `ApiGatewayV2` to `ApiGatewayV2V5` and keep the name. The API, its routes, their
 * functions and its authorizers are kept. Three things are written differently:
 *
 * - A route's own `transform`, and the API's `transform.route.handler`, become the API's
 *   `transform` for `handler`, `integration` and `route`.
 * - `domain.nameId` becomes `existing: { domainName }`.
 * - `domain` and `domain.dns` have to be plain values, not outputs.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const api = new sst.aws.ApiGatewayV2("MyApi");
 * const api = new sst.aws.ApiGatewayV2V5("MyApi");
 * ```
 */
export class ApiGatewayV2V5 extends component("sst:aws:ApiGatewayV2V5", parts) {
  private handlerLink: FunctionArgs["link"];

  constructor(
    name: string,
    args: ApiGatewayV2V5Args = {},
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
        `In the "${name}" API, "transform.route" changes each route's API Gateway route, so it has no "handler" or "args". To change the routes' functions, use "transform.handler".`,
      );

    const vpc =
      args.vpc instanceof Vpc
        ? {
            subnets: args.vpc.publicSubnets,
            securityGroups: args.vpc.securityGroups,
          }
        : args.vpc && output(args.vpc);
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
    if (args.domain || existingDomainName) {
      plain(args.domain, `The "domain" of the "${name}" API`);
      const domain =
        typeof args.domain === "string"
          ? { name: args.domain }
          : args.domain ?? {};
      if (existingDomainName && domain.name)
        throw new VisibleError(
          `The "${name}" API is given an existing "domainName", so it doesn't create one. Remove "name" from its domain.`,
        );

      const domainName = existingDomainName ?? this.createDomainName(domain);
      this.part("domainMapping", {
        apiId: api.id,
        domainName: domainName.id,
        stage: stage.name,
        apiMappingKey: domain.path,
      });
    }

    this.registerOutputs({ _hint: this.url });
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it.
  private createDomainName(args: ApiGatewayV2V5DomainArgs) {
    const name = this.componentName;
    if (!args.name)
      throw new VisibleError(
        `Domain "name" is required for the "${name}" API. To use a domain name you already have, pass it in "existing".`,
      );
    const domain = customDomain(args, `the "${name}" API`);

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
    domain.dns?.createAlias(
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
    handler: Input<string | FunctionArgs | FunctionArn>,
    args: ApiGatewayV2V5RouteArgs = {},
  ) {
    const { id, route } = this.newRoute(rawRoute, args);

    const fn = functionPart(this, "handler", id, handler, {
      description: `${this.componentName} route ${route}`,
      link: this.handlerLink,
    });
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
    args: ApiGatewayV2V5RouteArgs = {},
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
    args: ApiGatewayV2V5RouteArgs = {},
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
  private newRoute(rawRoute: string, args: ApiGatewayV2V5RouteArgs) {
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
    args: ApiGatewayV2V5RouteArgs,
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
  public addAuthorizer(args: ApiGatewayV2V5AuthorizerArgs) {
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

    const settings = output(args.lambda!);
    const fn = functionPart(this, "authorizerFunction", name, settings.function, {
      description: `${this.componentName} authorizer`,
    });
    const authorizer = this.part("authorizer", name, {
      apiId: api.id,
      authorizerType: "REQUEST",
      identitySources: settings.apply(
        (lambda) => lambda.identitySources ?? [IDENTITY_SOURCE],
      ),
      authorizerUri: fn.targetInvokeArn,
      authorizerResultTtlInSeconds: settings.apply((lambda) =>
        toSeconds(lambda.ttl ?? "0 seconds"),
      ),
      authorizerPayloadFormatVersion: settings.apply(
        (lambda) => lambda.payload ?? "2.0",
      ),
      enableSimpleResponses: settings.apply(
        (lambda) => (lambda.response ?? "simple") === "simple",
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

type Cors = Exclude<$util.Unwrap<ApiGatewayV2Args["cors"]>, undefined>;

function corsConfiguration(cors: Cors | undefined) {
  if (cors === false) return {};

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

type Auth = Exclude<$util.Unwrap<ApiGatewayV2RouteArgs["auth"]>, undefined>;

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
