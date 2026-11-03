import {
  ComponentResourceOptions,
  interpolate,
  Output,
  output,
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
import { notAnOption, plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { physicalName } from "../../naming";
import { DnsValidatedCertificate } from "./dns-validated-certificate";
import { Function } from "./function";
import type { ApiGatewayV2DomainArgs } from "./apigatewayv2";
import { domainOf } from "../helpers/domain";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { setupApiGatewayAccount } from "../helpers/apigateway-account";
import { permission } from "../permission";
import { RETENTION } from "../logging";

const parts = () => ({
  /**
   * The Amazon API Gateway V2 API.
   */
  api: apigatewayv2.Api,
  /**
   * The API's `$default` stage.
   */
  stage: apigatewayv2.Stage,
  /**
   * The CloudWatch LogGroup for the access logs.
   */
  logGroup: cloudwatch.LogGroup,
  /**
   * The certificate of the custom domain, unless one is given in `domain.cert`.
   */
  certificate: optional(DnsValidatedCertificate),
  /**
   * The API Gateway domain name, with a custom domain.
   */
  domainName: optional(apigatewayv2.DomainName),
  /**
   * The mapping of the API to the domain name, with a custom domain.
   */
  domainMapping: optional(apigatewayv2.ApiMapping),
  /**
   * The function each route invokes, by the route's name, or the route itself.
   */
  handler: many(deferred(Function)),
  /**
   * The permission for API Gateway to invoke each route's function.
   */
  permission: many(lambda.Permission),
  /**
   * Each route's integration with its function.
   */
  integration: many(apigatewayv2.Integration),
  /**
   * Each route.
   */
  route: many(apigatewayv2.Route),
  /**
   * Each authorizer, by its name.
   */
  authorizer: many(apigatewayv2.Authorizer),
  /**
   * Each authorizer's function, by the authorizer's name.
   */
  authorizerFunction: many(deferred(Function)),
  /**
   * The permission for API Gateway to invoke each authorizer's function.
   */
  authorizerPermission: many(lambda.Permission),
});

export interface ApiGatewayWebSocketArgs extends ComponentArgs<typeof parts> {
  /**
   * Set a custom domain for your WebSocket API.
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
  domain?: string | Prettify<Partial<ApiGatewayV2DomainArgs>>;
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
}

export interface ApiGatewayWebSocketAuthorizerArgs {
  /**
   * Create a Lambda authorizer that can be used by the `$connect` route.
   *
   * The function returns an IAM policy that allows or denies `execute-api:Invoke`, or
   * throws `Unauthorized`. This is also how to check a JWT, such as a Cognito token:
   * WebSocket APIs don't support JWT authorizers, so the function verifies the token.
   * See [`addAuthorizer`](#addauthorizer) for an example.
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
  lambda: {
    /**
     * The Lambda authorizer function. Takes the handler path or the function args.
     *
     * A handler or the args have to be plain values, since whether a function is
     * created is decided from them.
     *
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
     * Specifies where to extract the identity from. A request without it is rejected
     * before the authorizer runs.
     *
     * A browser can't set headers on a WebSocket connection, so a browser client usually
     * sends its token in the query string.
     * @default `["route.request.header.Authorization"]`
     * @example
     * ```js
     * {
     *   identitySources: ["route.request.querystring.token"]
     * }
     * ```
     */
    identitySources?: Input<Input<string>[]>;
  };
}

export interface ApiGatewayWebSocketRouteArgs {
  /**
   * Enable auth for your WebSocket API. By default, auth is disabled.
   *
   * Auth only applies to the `$connect` route: API Gateway checks it once, when a client
   * connects. Other routes ignore it.
   *
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
   * The name of the route.
   *
   * By default, a route is named after itself, like `$connect` or `sendMessage`. Setting
   * `name` gives it another, like `SendMessage`.
   *
   * Must be unique across all routes.
   *
   * @example
   * ```js
   * {
   *   name: "SendMessage"
   * }
   * ```
   */
  name?: string;
}

/**
 * The `ApiGatewayWebSocket` component lets you add an [Amazon API Gateway WebSocket API](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)
 * to your app.
 *
 * @example
 *
 * #### Create the API
 *
 * ```ts title="sst.config.ts"
 * const api = new sst.aws.v5.ApiGatewayWebSocket("MyApi");
 * ```
 *
 * #### Add a custom domain
 *
 * ```js {2} title="sst.config.ts"
 * new sst.aws.v5.ApiGatewayWebSocket("MyApi", {
 *   domain: "api.example.com"
 * });
 * ```
 *
 * #### Add routes
 *
 * ```ts title="sst.config.ts"
 * api.route("$connect", "src/connect.handler");
 * api.route("$disconnect", "src/disconnect.handler");
 * api.route("$default", "src/default.handler");
 * api.route("sendMessage", "src/sendMessage.handler");
 * ```
 *
 * #### Switch from `sst.aws.ApiGatewayWebSocket`
 *
 * Change `sst.aws.ApiGatewayWebSocket` to `sst.aws.v5.ApiGatewayWebSocket` and keep the
 * name. The API, its stage, access log, domain, and each route's and authorizer's
 * resources are kept. A few things are written differently:
 *
 * - The routes and authorizers are inside the component, where
 *   `sst.aws.ApiGatewayWebSocket` kept each in a component of its own. A route is kept by
 *   its name, or the route itself, like `sendMessage`; `route` and `addAuthorizer` return
 *   the API and the authorizer, not those components.
 * - A route's and an authorizer's own `transform`, and `transform.route.handler`, become
 *   the API's `transform` for `handler`, `integration`, `route` and `authorizer`, which
 *   apply to every route or authorizer and are given its name in a function.
 *   `transform.route.args` is gone: give each route its `auth`. Each is refused with what
 *   to write.
 * - `transform.accessLog` is `transform.logGroup`, and the certificate is `nodes.certificate`.
 * - `domain` has to be a plain value, not an output. `domain.nameId` is
 *   `existing.domainName`.
 * - `nodes.domainName` is `undefined` without a domain, where `sst.aws.ApiGatewayWebSocket`
 *   threw.
 * - An authorizer's `jwt`, and its `lambda.payload` and `lambda.response`, are refused. API
 *   Gateway doesn't take a JWT authorizer on a WebSocket API, which
 *   `sst.aws.ApiGatewayWebSocket` refused in the deploy, and ignores the other two. A
 *   route's `auth.jwt` is refused the same way.
 * - An authorizer's `lambda` and a route's handler have to be plain values: whether a
 *   function is created is decided from them.
 * - The routes and authorizers are created with the provider the API has.
 *   `sst.aws.ApiGatewayWebSocket` gave them only a `provider` passed to the API itself, so
 *   if your API takes its provider from a parent component or from `providers`, its routes
 *   and authorizers are replaced on switch, their functions' log groups with them, which
 *   `sst migrate --check` refuses: remove them and deploy before you switch, then add
 *   them back.
 */
export class ApiGatewayWebSocket extends component(
  "sst:aws:ApiGatewayWebSocket",
  parts,
) {
  private readonly namedRoutes = new Set<string>();

  constructor(
    name: string,
    args: ApiGatewayWebSocketArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    const routeTransform = (args.transform as any)?.route;
    if (
      typeof routeTransform === "object" &&
      ("handler" in routeTransform || "args" in routeTransform)
    )
      throw new VisibleError(
        `In the "${name}" API, "transform.route" changes each route's API Gateway route, so it has no "handler" or "args". To change the routes' functions, use "transform.handler". To give a route an auth, give it in the route's args.`,
      );
    notAnOption(
      args.transform ?? {},
      "accessLog",
      `Transform the access log in "transform.logGroup".`,
    );

    // The account's role for API Gateway to write logs with, made once for
    // the account when it has none
    const account = setupApiGatewayAccount(name, opts ?? {});

    const api = this.part("api", {
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
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
    this.part(
      "stage",
      {
        apiId: api.id,
        autoDeploy: true,
        name: "$default",
        accessLogSettings: {
          destinationArn: logGroup.arn,
          format: ACCESS_LOG_FORMAT,
        },
      },
      { dependsOn: account },
    );

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
        stage: "$default",
        apiMappingKey: given.path,
      });
    }

    this.report({ hint: this.url });
  }

  // The custom domain: its certificate, the domain name, and the DNS records
  // that point at it
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
    const { api, stage, domainName, domainMapping } = this.nodes;
    // Note: If mapping key is set, the URL needs a trailing slash. Without the
    //       trailing slash, the API fails with the error {"message":"Not Found"}
    return domainName && domainMapping
      ? output([domainName.domainName, domainMapping.apiMappingKey]).apply(
          ([domain, key]) =>
            key ? `wss://${domain}/${key}/` : `wss://${domain}`,
        )
      : interpolate`${api.apiEndpoint}/${stage.name}`;
  }

  /**
   * The management endpoint for the API used by the API Gateway Management API client.
   * This is useful for sending messages to connected clients.
   *
   * @example
   * ```js
   * import { Resource } from "sst";
   * import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
   *
   * const client = new ApiGatewayManagementApiClient({
   *   endpoint: Resource.MyApi.managementEndpoint,
   * });
   * ```
   */
  public get managementEndpoint() {
    // ie. https://v1lmfez2nj.execute-api.us-east-1.amazonaws.com/$default
    const { api, stage } = this.nodes;
    return interpolate`${api.apiEndpoint.apply((endpoint) =>
      endpoint.replace("wss", "https"),
    )}/${stage.name}`;
  }

  /**
   * Add a route to the API Gateway WebSocket API.
   *
   * There are three predefined routes:
   * - `$connect`: When the client connects to the API.
   * - `$disconnect`: When the client or the server disconnects from the API.
   * - `$default`: The default or catch-all route.
   *
   * In addition, you can create custom routes. When a request comes in, the API Gateway
   * will look for the specific route defined by the user. If no route matches, the `$default`
   * route will be invoked.
   *
   * :::caution
   * [API Gateway has strict rate limits](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html) for creating and updating resources. Creating one Lambda function for every route can significantly slow down your deployments.
   *
   * Use a single Lambda and handle routing in code if you don't need specific API Gateway features.
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
   * api.route("sendMessage", "src/sendMessage.handler");
   * ```
   *
   * Add a predefined route.
   *
   * ```js title="sst.config.ts"
   * api.route("$default", "src/default.handler");
   * ```
   *
   * Enable auth on the `$connect` route, where API Gateway checks it.
   *
   * ```js title="sst.config.ts"
   * api.route("$connect", "src/connect.handler", {
   *   auth: {
   *     iam: true
   *   }
   * });
   * ```
   *
   * Customize the route handler.
   *
   * ```js title="sst.config.ts"
   * api.route("sendMessage", {
   *   handler: "src/sendMessage.handler",
   *   memory: "2048 MB"
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * api.route("sendMessage", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   */
  public route(
    route: string,
    handler: FunctionInput,
    args: ApiGatewayWebSocketRouteArgs = {},
  ) {
    const name = this.componentName;
    const id = args.name ?? route;
    this.assertNew("route", "route", id, args, [
      "handler",
      "integration",
      "route",
    ]);
    if (args.name !== undefined) this.namedRoutes.add(id);
    const auth = args.auth;
    if (route === "$connect" && plainJwtOnly(auth)) throw jwtAuthError(route);

    const { api } = this.nodes;
    const fn = functionPart(
      this,
      "handler",
      id,
      plainFunction(
        handler,
        `The handler of the "${route}" route of the "${name}" API`,
      ),
      { description: `${name} route ${route}` },
    );
    const permission = this.part(
      "permission",
      id,
      invokePermissionArgs(
        fn,
        "apigateway.amazonaws.com",
        interpolate`${api.executionArn}/*`,
      ),
    );
    const integration = this.part(
      "integration",
      id,
      {
        apiId: api.id,
        integrationType: "AWS_PROXY",
        integrationUri: fn.targetArn.apply((arn) => {
          const [, partition, , region] = arn.split(":");
          return `arn:${partition}:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`;
        }),
      },
      { dependsOn: [permission] },
    );
    // Auth is checked when a client connects
    const authorization =
      route === "$connect"
        ? output(auth).apply((auth) => {
            if (!auth) return { type: "NONE" };
            if (auth.iam) return { type: "AWS_IAM" };
            if (auth.lambda)
              return { type: "CUSTOM", authorizerId: auth.lambda };
            if ((auth as any).jwt) throw jwtAuthError(route);
            return { type: "NONE" };
          })
        : output({ type: "NONE" } as { type: string; authorizerId?: string });
    this.part("route", id, {
      apiId: api.id,
      routeKey: route,
      target: interpolate`integrations/${integration.id}`,
      authorizationType: authorization.type,
      authorizerId: authorization.apply((a) => a.authorizerId!),
    });
    return this;
  }

  /**
   * Add an authorizer to the API Gateway WebSocket API.
   *
   * @param name The name of the authorizer.
   * @param args Configure the authorizer.
   *
   * @example
   * Add a Lambda authorizer.
   *
   * ```js title="sst.config.ts"
   * const authorizer = api.addAuthorizer("MyAuthorizer", {
   *   lambda: {
   *     function: "src/authorizer.handler"
   *   }
   * });
   * ```
   *
   * Then use it on the `$connect` route, where API Gateway checks auth.
   *
   * ```js title="sst.config.ts"
   * api.route("$connect", "src/connect.handler", {
   *   auth: {
   *     lambda: authorizer.id
   *   }
   * });
   * ```
   *
   * API Gateway doesn't support JWT authorizers on WebSocket APIs. To accept a JWT, such
   * as a Cognito token, have the Lambda authorizer verify it. Here a browser sends the
   * token in the query string, since it can't set headers on a WebSocket connection.
   *
   * ```js title="sst.config.ts"
   * const pool = new sst.aws.v5.CognitoUserPool("MyUserPool");
   * const client = pool.addClient("Web");
   *
   * const authorizer = api.addAuthorizer("MyAuthorizer", {
   *   lambda: {
   *     function: {
   *       handler: "src/authorizer.handler",
   *       environment: {
   *         USER_POOL_ID: pool.id,
   *         USER_POOL_CLIENT_ID: client.id
   *       }
   *     },
   *     identitySources: ["route.request.querystring.token"]
   *   }
   * });
   *
   * api.route("$connect", "src/connect.handler", {
   *   auth: {
   *     lambda: authorizer.id
   *   }
   * });
   * ```
   *
   * The authorizer verifies the token with
   * [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify), and returns a policy
   * that allows the connection. Add the package to your app first.
   *
   * ```bash
   * npm install aws-jwt-verify
   * ```
   *
   * ```ts title="src/authorizer.ts"
   * import { CognitoJwtVerifier } from "aws-jwt-verify";
   *
   * const verifier = CognitoJwtVerifier.create({
   *   userPoolId: process.env.USER_POOL_ID!,
   *   clientId: process.env.USER_POOL_CLIENT_ID!,
   *   tokenUse: "access"
   * });
   *
   * export async function handler(event) {
   *   try {
   *     const claims = await verifier.verify(event.queryStringParameters.token);
   *     return {
   *       principalId: claims.sub,
   *       policyDocument: {
   *         Version: "2012-10-17",
   *         Statement: [
   *           { Action: "execute-api:Invoke", Effect: "Allow", Resource: event.methodArn }
   *         ]
   *       }
   *     };
   *   } catch {
   *     throw new Error("Unauthorized");
   *   }
   * }
   * ```
   *
   * The client connects with the token, as `wss://<api>/<stage>?token=<token>`. For
   * another issuer, `aws-jwt-verify`'s `JwtVerifier` or the `jose` package can check the
   * token against the issuer's keys.
   */
  public addAuthorizer(name: string, args: ApiGatewayWebSocketAuthorizerArgs) {
    const what = `the "${name}" authorizer of the "${this.componentName}" API`;
    this.assertNew("authorizer", "authorizer", name, args);
    notAnOption(
      args,
      "jwt",
      `API Gateway only supports JWT authorizers on HTTP APIs. Use "lambda" with a function that verifies the token.`,
    );
    const settings = plain(args.lambda, `The "lambda" of ${what}`);
    if (!settings)
      throw new VisibleError(
        `Please provide "lambda" for ${what}: a WebSocket API takes a Lambda authorizer.`,
      );
    for (const option of ["payload", "response"])
      notAnOption(
        settings,
        option,
        `A WebSocket API's authorizer always returns an IAM policy, so API Gateway ignores it. Remove it.`,
      );

    const { api } = this.nodes;
    const fn = functionPart(
      this,
      "authorizerFunction",
      name,
      plainFunction(settings.function, `The "lambda.function" of ${what}`),
      { description: `${this.componentName} authorizer` },
    );
    const authorizer = this.part("authorizer", name, {
      apiId: api.id,
      authorizerType: "REQUEST",
      identitySources: output(settings.identitySources).apply(
        (sources) => sources ?? ["route.request.header.Authorization"],
      ),
      authorizerUri: fn.targetInvokeArn,
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
   * Whether the route kept under `id` was given a `name`, rather than kept
   * under the route itself.
   * @internal
   */
  public routeIsNamed(id: string) {
    return this.namedRoutes.has(id);
  }

  link() {
    return {
      properties: {
        url: this.url,
        managementEndpoint: this.managementEndpoint,
      },
      include: [
        permission({
          actions: ["execute-api:ManageConnections"],
          resources: [
            interpolate`${this.nodes.api.executionArn}/*/*/@connections/*`,
          ],
        }),
      ],
    };
  }
}

// Whether a route's auth is a JWT and nothing else, when it's known now
function plainJwtOnly(auth: ApiGatewayWebSocketRouteArgs["auth"]) {
  if (!auth || Output.isInstance(auth) || auth instanceof Promise) return false;
  const given = auth as Record<string, unknown>;
  return Boolean(given.jwt && !given.iam && !given.lambda);
}

function jwtAuthError(route: string) {
  return new VisibleError(
    `The ${route} route uses "auth.jwt", but API Gateway only supports JWT auth on HTTP APIs. Use "auth.lambda" with a Lambda authorizer that verifies the token.`,
  );
}

const ACCESS_LOG_FORMAT = JSON.stringify({
  // request info
  requestTime: `"$context.requestTime"`,
  requestId: `"$context.requestId"`,
  eventType: `"$context.eventType"`,
  routeKey: `"$context.routeKey"`,
  status: `$context.status`, // integer value, do not wrap in quotes
  // integration info
  integrationRequestId: `"$context.awsEndpointRequestId"`,
  integrationStatus: `"$context.integrationStatus"`,
  integrationLatency: `"$context.integrationLatency"`,
  integrationServiceStatus: `"$context.integration.integrationStatus"`,
  // caller info
  ip: `"$context.identity.sourceIp"`,
  userAgent: `"$context.identity.userAgent"`,
  //cognitoIdentityId:`"$context.identity.cognitoIdentityId"`, // not supported in us-west-2 region
  connectedAt: `"$context.connectedAt"`,
  connectionId: `"$context.connectionId"`,
});
