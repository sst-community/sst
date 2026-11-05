import { apigatewayv2, cloudwatch } from "@pulumi/aws";
import {
  type ComponentResourceOptions,
  type CustomResourceOptions,
  interpolate,
  output,
} from "@pulumi/pulumi";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { notAnExistingPart, plain, usedAsItIs } from "../../args";
import { physicalName } from "../../naming";
import type { OptionalPart } from "../../parts";
import type { PartsBuilder } from "../../parts-component";
import { RETENTION } from "../logging";
import type { DnsValidatedCertificate } from "../dns-validated-certificate";
import { type DomainArgs, domainOf } from "./domain";
import type { FunctionPart } from "./function-part";
import { invokePermissionArgs } from "./function-permission";

/**
 * A custom domain of an API Gateway API: the domain, and the path the API is under.
 */
export interface ApiGatewayDomainArgs extends DomainArgs {
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

/**
 * The access log of an API Gateway API.
 */
export interface ApiGatewayAccessLogArgs {
  /**
   * Configure the [API Gateway logs](https://docs.aws.amazon.com/apigateway/latest/developerguide/view-cloudwatch-log-events-in-cloudwatch-console.html) in CloudWatch. By default, access logs are enabled and kept for 1 month.
   *
   * With a log group in `existing.logGroup`, which is used the way it is, leave this out.
   *
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

/**
 * The args and options of the log group an API Gateway API writes its access log to:
 * named after the API, and kept for `accessLog.retention`. A log group in
 * `existing.logGroup` is used the way it is, so `accessLog` is refused next to one.
 *
 * ```ts
 * const [logArgs, logOpts] = accessLogGroup(name, args, `the "${name}" API`);
 * this.part("logGroup", logArgs, logOpts);
 * ```
 */
export function accessLogGroup(
  name: string,
  args: ApiGatewayAccessLogArgs & { existing?: { logGroup?: unknown } },
  owner: string,
): [cloudwatch.LogGroupArgs, CustomResourceOptions] {
  if (args.existing?.logGroup !== undefined)
    usedAsItIs(args, ["accessLog"], "logGroup", owner);
  return [
    {
      name: `/aws/vendedlogs/apis/${physicalName(64, name)}`,
      retentionInDays: output(args.accessLog).apply(
        (accessLog) => RETENTION[accessLog?.retention ?? "1 month"],
      ),
    },
    { ignoreChanges: ["name"] },
  ];
}

/**
 * Refuse a transform SST 4 took that an API Gateway API built the 5.0 way takes
 * elsewhere, saying where. Call it before `super()` for a key that isn't one of the
 * component's parts, which `super()` would refuse without saying what to write.
 *
 * ```ts
 * notAnOldTransform(args.transform, "accessLog", `the "${name}" API`);
 * ```
 *
 * @param transform The component's `transform`.
 * @param key The key SST 4 took: `accessLog`, or a REST API's `route`.
 * @param owner The API, as `the "MyApi" API`.
 */
export function notAnOldTransform(
  transform: object | undefined,
  key: "accessLog" | "route",
  owner: string,
) {
  if ((transform as Record<string, unknown> | undefined)?.[key] === undefined)
    return;
  throw new VisibleError(
    `"transform.${key}" isn't an option for ${owner}. ${
      key === "accessLog"
        ? `Transform the access log in "transform.logGroup".`
        : `To change the routes' functions, use "transform.handler", and their methods and integrations, "transform.method" and "transform.integration", which are given each route's name. To give every route an auth or an API key, give it in each route's args.`
    }`,
  );
}

/**
 * Refuse what SST 4 took in `transform.route` of an HTTP or WebSocket API that
 * `transform.route` doesn't take now: the routes' functions and their args.
 *
 * @param transform The component's `transform`.
 * @param owner The API, as `the "MyApi" API`.
 * @param auth What to write for the routes' auth.
 */
export function notAnOldRouteTransform(
  transform: { route?: unknown } | undefined,
  owner: string,
  auth: string,
) {
  const route = transform?.route;
  if (typeof route !== "object" || route === null) return;
  for (const key of ["handler", "args"])
    if (key in route)
      throw new VisibleError(
        `"transform.route.${key}" isn't an option for ${owner}. "transform.route" changes each route's API Gateway route. To change the routes' functions, use "transform.handler". ${auth}`,
      );
}

/**
 * An API Gateway API's custom domain, checked: what the API creates for it, and the path
 * the API is under. The API creates the domain name, with its certificate unless there's
 * a `cert`, or it's given one in `existing.domainName` and maps itself to that. Undefined
 * when there's no domain. An `existing` entry it wouldn't use is refused.
 *
 * ```ts
 * const domain = apiDomainOf(args.domain, args.existing, `the "${name}" API`);
 * if (domain) {
 *   const domainName =
 *     this.existingPart("domainName") ?? this.createDomainName(domain.create!);
 *   this.part("domainMapping", { ..., apiMappingKey: domain.path });
 * }
 * ```
 *
 * @param domain The `domain` arg, checked to be a plain value.
 * @param existing The component's `existing`.
 * @param owner The API, as `the "MyApi" API`.
 */
export function apiDomainOf(
  domain: string | Partial<ApiGatewayDomainArgs> | undefined,
  existing:
    | { domainName?: unknown; certificate?: unknown; domainMapping?: unknown }
    | undefined,
  owner: string,
) {
  plain(domain, `The "domain" of ${owner}`);
  const Owner = `${owner[0].toUpperCase()}${owner.slice(1)}`;
  const hasDomainName = existing?.domainName !== undefined;
  if (domain === undefined && !hasDomainName) {
    notAnExistingPart(
      existing,
      "certificate",
      owner,
      `It's the certificate of a custom domain: give the API a "domain" with a "name".`,
    );
    notAnExistingPart(
      existing,
      "domainMapping",
      owner,
      `It maps the API to a custom domain: give the API a "domain", or a domain name in "existing.domainName".`,
    );
    return undefined;
  }
  const given: Partial<ApiGatewayDomainArgs> =
    typeof domain === "string" ? { name: domain } : domain ?? {};
  if ("nameId" in given)
    throw new VisibleError(
      `The "domain.nameId" of ${owner} is given in "existing" now: { domain: { path }, existing: { domainName: "..." } }.`,
    );

  if (existing?.domainMapping !== undefined && given.path !== undefined)
    throw new VisibleError(
      `${Owner} is given an existing "domainMapping", which it uses the way it is. Remove "path" from its domain.`,
    );

  if (hasDomainName) {
    // The domain name is there already, with its certificate and records
    const unused = (["name", "dns", "cert"] as const).filter(
      (key) => given[key] !== undefined,
    );
    if (unused.length)
      throw new VisibleError(
        `${Owner} is given an existing "domainName", so it doesn't create one. Remove ${unused
          .map((key) => `"${key}"`)
          .join(", ")} from its domain.`,
      );
    notAnExistingPart(
      existing,
      "certificate",
      owner,
      `It's given an existing "domainName", which has its certificate.`,
    );
    return { path: given.path, create: undefined };
  }

  if (!given.name)
    throw new VisibleError(
      `Domain "name" is required for ${owner}. To use a domain name you already have, pass it in "existing.domainName".`,
    );
  if (given.cert !== undefined)
    notAnExistingPart(
      existing,
      "certificate",
      owner,
      `Give the certificate one way: its ARN in "domain.cert", or the certificate in "existing.certificate".`,
    );
  return {
    path: given.path,
    create: domainOf({ ...given, name: given.name }, owner),
  };
}

/** A domain an API creates, from `apiDomainOf()`. */
export type ApiDomain = NonNullable<
  NonNullable<ReturnType<typeof apiDomainOf>>["create"]
>;

/** The parts of an HTTP or WebSocket API's custom domain. */
type RegionalDomainParts = {
  certificate: OptionalPart<typeof DnsValidatedCertificate>;
  domainName: OptionalPart<typeof apigatewayv2.DomainName>;
  domainMapping: OptionalPart<typeof apigatewayv2.ApiMapping>;
};

/**
 * The custom domain of an HTTP or WebSocket API: its certificate, unless there's a `cert`,
 * the regional domain name, the DNS records that point at it, and the mapping of the
 * API's stage to it. A domain name in `existing.domainName` is mapped to as it is.
 * Undefined when there's no domain.
 *
 * ```ts
 * createRegionalDomain(this.builder(), this.delegateOpts(), {
 *   name, domain: args.domain, existing: args.existing, apiId: api.id, stage: stage.name,
 * });
 * ```
 */
export function createRegionalDomain(
  builder: Pick<PartsBuilder<RegionalDomainParts>, "part" | "existingPart">,
  delegateOpts: ComponentResourceOptions,
  args: {
    name: string;
    domain: string | Partial<ApiGatewayDomainArgs> | undefined;
    existing: Parameters<typeof apiDomainOf>[1];
    apiId: Input<string>;
    stage: Input<string>;
  },
) {
  const domain = apiDomainOf(
    args.domain,
    args.existing,
    `the "${args.name}" API`,
  );
  if (!domain) return undefined;
  const domainName =
    builder.existingPart("domainName") ?? create(domain.create!);
  return builder.part("domainMapping", {
    apiId: args.apiId,
    domainName: domainName.id,
    stage: args.stage,
    apiMappingKey: domain.path,
  });

  function create(domain: ApiDomain) {
    const certificateArn =
      domain.cert ??
      builder.part("certificate", { domainName: domain.name, dns: domain.dns! })
        .arn;
    const domainName = builder.part("domainName", {
      domainName: domain.name,
      domainNameConfiguration: {
        certificateArn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2",
      },
    });
    domain.dns?.alias(
      args.name,
      {
        name: domain.name,
        aliasName: domainName.domainNameConfiguration.targetDomainName,
        aliasZone: domainName.domainNameConfiguration.hostedZoneId,
      },
      delegateOpts,
    );
    return domainName;
  }
}

/** The methods a route of an API Gateway API can have. */
export const ROUTE_METHODS = [
  "ANY",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
];

/**
 * A route of an API Gateway API, `METHOD /path`, checked: its method in upper case, and
 * its path.
 *
 * @param route The route as it's written.
 * @param owner The API, as `the "MyApi" API`.
 */
export function parseRoute(route: string, owner: string) {
  const [methodRaw, path, ...rest] = route.split(" ");
  if (path === undefined || rest.length > 0)
    throw new VisibleError(
      `The "${route}" route of ${owner} isn't a route. Write it as "METHOD /path", like "GET /notes".`,
    );
  const method = methodRaw.toUpperCase();
  if (!ROUTE_METHODS.includes(method))
    throw new VisibleError(
      `The "${route}" route of ${owner} has the method "${methodRaw}". Use one of ${ROUTE_METHODS.join(
        ", ",
      )}.`,
    );
  if (!path.startsWith("/"))
    throw new VisibleError(
      `The path of the "${route}" route of ${owner} doesn't start with "/".`,
    );
  return { method, path };
}

/**
 * The args of the permission for an API Gateway API to invoke a route's function.
 *
 * @param fn The function, from `functionPart()`.
 * @param executionArn The API's execution ARN.
 */
export function routePermissionArgs(
  fn: FunctionPart,
  executionArn: Input<string>,
) {
  return invokePermissionArgs(
    fn,
    "apigateway.amazonaws.com",
    interpolate`${executionArn}/*`,
  );
}

/**
 * The args of the permission for an API Gateway API to invoke an authorizer's function.
 *
 * @param fn The function, from `functionPart()`.
 * @param executionArn The API's execution ARN.
 * @param authorizerId The authorizer's id.
 */
export function authorizerPermissionArgs(
  fn: FunctionPart,
  executionArn: Input<string>,
  authorizerId: Input<string>,
) {
  return invokePermissionArgs(
    fn,
    "apigateway.amazonaws.com",
    interpolate`${executionArn}/authorizers/${authorizerId}`,
  );
}
