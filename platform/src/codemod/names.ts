/**
 * The names of SST 4's components and their 5.0 forms, by group, for the
 * codemod. A test checks them against the platform's exports, so a component
 * added or renamed in either is listed here.
 */

export type Group = "aws" | "cloudflare" | "x";

/** A 4.x component whose 5.0 form has another name. */
export const renamed: Record<Group, Record<string, string>> = {
  aws: {
    ApiGatewayV1: "ApiGatewayRest",
    ApiGatewayV2: "ApiGatewayHttp",
  },
  cloudflare: {
    StaticSiteV2: "StaticSite",
    // SST 4's other names, under `x`, for its `Astro` and `StaticSiteV2`
    "x.Astro": "Astro",
    "x.StaticSite": "StaticSite",
  },
  x: {},
};

/**
 * A 4.x component with no 5.0 form, and what to do instead. An app does it
 * with SST 4, or removes the component, before its stage moves. Cloudflare's
 * `StaticSite` names a 5.0 component too, so an app's is read as 5.0's.
 */
export const leftOut: Record<Group, Record<string, string>> = {
  aws: {
    OpenControl:
      "`OpenControl` has no 5.0 form: remove it with SST 4, and run OpenControl outside of SST, before the stage moves.",
    Vector:
      "`Vector` has no 5.0 form: move its vectors to a vector database of their own, and remove it, with SST 4, before the stage moves.",
  },
  cloudflare: {
    Auth: "Cloudflare's `Auth` has no 5.0 form: remove it with SST 4 before the stage moves, or keep the stage on SST 4.",
    StaticSite:
      "Cloudflare's first `StaticSite` has no 5.0 form: move to `sst.cloudflare.StaticSiteV2` with SST 4 first, which is `StaticSite` in 5.0.",
    "x.SolidStart":
      "Cloudflare's experimental `SolidStart` has no 5.0 form: remove it with SST 4 before the stage moves, or keep the stage on SST 4.",
  },
  x: {},
};

/** The `.v1` forms with no 5.0 form, by component, and `Auth.v1`. */
export const v1: Record<string, string> = {
  Auth: "`Auth.v1` has no 5.0 form: move to OpenAuth's `Auth`, `sst.aws.Auth`, with SST 4 first.",
  Vpc: "`Vpc.v1` has no 5.0 form: move to `sst.aws.Vpc`, its current version, with SST 4 first.",
  Cluster:
    "`Cluster.v1` has no 5.0 form: move to `sst.aws.Cluster`, its current version, with SST 4 first.",
  Postgres:
    "`Postgres.v1` has no 5.0 form: move to `sst.aws.Postgres`, its current version, with SST 4 first.",
  Redis:
    "`Redis.v1` has no 5.0 form: move to `sst.aws.Redis`, its current version, with SST 4 first.",
};

/**
 * What each group's 5.0 components export, their classes and their types, by
 * name. Kept here so the codemod doesn't load the platform.
 */
export const exports: Record<Group, string[]> = {
  aws: [
    "Alb",
    "AlbArgs",
    "AlbDomainArgs",
    "AlbListenerArgs",
    "Analog",
    "AnalogArgs",
    "ApiGatewayHttp",
    "ApiGatewayHttpArgs",
    "ApiGatewayHttpAuthorizerArgs",
    "ApiGatewayHttpCorsArgs",
    "ApiGatewayHttpRouteArgs",
    "ApiGatewayRest",
    "ApiGatewayRestApiKey",
    "ApiGatewayRestApiKeyArgs",
    "ApiGatewayRestArgs",
    "ApiGatewayRestAuthorizerArgs",
    "ApiGatewayRestIntegrationArgs",
    "ApiGatewayRestRouteArgs",
    "ApiGatewayRestUsagePlan",
    "ApiGatewayRestUsagePlanArgs",
    "ApiGatewayWebSocket",
    "ApiGatewayWebSocketArgs",
    "ApiGatewayWebSocketAuthorizerArgs",
    "ApiGatewayWebSocketRouteArgs",
    "ApiKeyArgs",
    "AppSync",
    "AppSyncArgs",
    "AppSyncDataSourceArgs",
    "AppSyncDomainArgs",
    "AppSyncFunctionArgs",
    "AppSyncResolverArgs",
    "Astro",
    "AstroArgs",
    "Aurora",
    "AuroraArgs",
    "Auth",
    "AuthArgs",
    "Bucket",
    "BucketArgs",
    "BucketEventBridgeSubscriberArgs",
    "BucketNotificationArgs",
    "BucketNotifyArgs",
    "Bus",
    "BusArgs",
    "BusSubscriberArgs",
    "Cdn",
    "CdnArgs",
    "CdnDomainArgs",
    "Cluster",
    "ClusterArgs",
    "ClusterGetArgs",
    "CognitoIdentityPool",
    "CognitoIdentityPoolArgs",
    "CognitoUserPool",
    "CognitoUserPoolAddClientArgs",
    "CognitoUserPoolArgs",
    "CognitoUserPoolClient",
    "CognitoUserPoolClientArgs",
    "CognitoUserPoolDomainArgs",
    "CognitoUserPoolIdentityProviderArgs",
    "CognitoUserPoolPrefixDomainArgs",
    "CognitoUserPoolTriggers",
    "Cron",
    "CronArgs",
    "CronV2",
    "CronV2Args",
    "DnsArgs",
    "DnsValidatedCertificate",
    "DnsValidatedCertificateArgs",
    "Dsql",
    "DsqlArgs",
    "DsqlGetArgs",
    "Dynamo",
    "DynamoArgs",
    "DynamoSubscriberArgs",
    "EcsRunTaskArgs",
    "Efs",
    "EfsArgs",
    "Email",
    "EmailArgs",
    "EmailEventArgs",
    "EventBridgePutEventsArgs",
    "Function",
    "FunctionArgs",
    "FunctionArn",
    "FunctionConcurrencyArgs",
    "FunctionLoggingArgs",
    "FunctionPermissionArgs",
    "FunctionPythonArgs",
    "FunctionUrlArgs",
    "FunctionUrlCorsArgs",
    "HttpsRedirect",
    "HttpsRedirectArgs",
    "KinesisStream",
    "KinesisStreamArgs",
    "KinesisStreamSubscriberArgs",
    "LambdaInvokeArgs",
    "MicroVm",
    "MicroVmArgs",
    "Mysql",
    "MysqlArgs",
    "MysqlGetArgs",
    "Nextjs",
    "NextjsArgs",
    "Nuxt",
    "NuxtArgs",
    "OpenSearch",
    "OpenSearchArgs",
    "Postgres",
    "PostgresArgs",
    "PostgresGetArgs",
    "Queue",
    "QueueArgs",
    "QueueSubscriberArgs",
    "React",
    "ReactArgs",
    "Realtime",
    "RealtimeArgs",
    "RealtimeSubscriberArgs",
    "Redis",
    "RedisArgs",
    "Remix",
    "RemixArgs",
    "Router",
    "RouterArgs",
    "RouterBucketRouteArgs",
    "RouterUrlRouteArgs",
    "Service",
    "ServiceAlbArgs",
    "ServiceAlbRuleArgs",
    "ServiceArgs",
    "ServiceContainerArgs",
    "ServiceDomainArgs",
    "ServiceHealthCheckArgs",
    "ServiceLoadBalancerArgs",
    "ServiceRuleArgs",
    "SnsPublishArgs",
    "SnsTopic",
    "SnsTopicArgs",
    "SnsTopicSubscriberArgs",
    "SolidStart",
    "SolidStartArgs",
    "SqsSendMessageArgs",
    "StaticSite",
    "StaticSiteArgs",
    "StepFunctions",
    "StepFunctionsArgs",
    "SvelteKit",
    "SvelteKitArgs",
    "TanStackStart",
    "TanStackStartArgs",
    "Task",
    "TaskArgs",
    "UsagePlanArgs",
    "Vpc",
    "VpcArgs",
    "WafArgs",
    "WafLoggingArgs",
    "WebFunction",
    "WebFunctionArgs",
    "Workflow",
    "WorkflowArgs",
  ],
  cloudflare: [
    "Ai",
    "AiArgs",
    "Astro",
    "AstroArgs",
    "Bucket",
    "BucketArgs",
    "Cron",
    "CronArgs",
    "D1",
    "D1Args",
    "DEFAULT_ACCOUNT_ID",
    "DnsArgs",
    "D1GetArgs",
    "DurableObject",
    "DurableObjectArgs",
    "Hyperdrive",
    "HyperdriveArgs",
    "HyperdriveGetArgs",
    "Kv",
    "KvArgs",
    "KvGetArgs",
    "Queue",
    "QueueArgs",
    "QueueSubscriberArgs",
    "RateLimit",
    "RateLimitArgs",
    "ReactRouter",
    "ReactRouterArgs",
    "StaticSite",
    "StaticSiteArgs",
    "TanStackStart",
    "TanStackStartArgs",
    "Worker",
    "WorkerArgs",
    "WorkerDomainArgs",
    "WorkerDurableObjectMigration",
    "Workflow",
    "WorkflowArgs",
  ],
  x: ["DevCommand", "DevCommandArgs"],
};

/**
 * The 5.0 name of what an app's config names `name`, a component or one of its
 * types, like `ApiGatewayV2Args`: renamed by its component's prefix.
 */
export function fiveName(group: Group, name: string) {
  if (name in renamed[group]) return renamed[group][name];
  for (const [from, to] of Object.entries(renamed[group]))
    if (
      !from.includes(".") &&
      name.startsWith(from) &&
      /^[A-Z]/.test(name.slice(from.length))
    )
      return to + name.slice(from.length);
  return name;
}
