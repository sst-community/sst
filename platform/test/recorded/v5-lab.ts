/**
 * The lab app that deployed the recorded states in `testdata/states`: its
 * groups as its `sst.config.ts` creates them, with the domain scrubbed as in
 * the states. Each takes the components it's written with: SST 5's, as
 * `sst.aws` and `sst.cloudflare`, or SST 4's from the fixtures.
 */
import type * as aws from "../../src/components/aws/index";
import type * as cf from "../../src/components/cloudflare/index";

/** The components a group is written with. It's typed as SST 5's. */
export type Components = typeof aws;

/** The Cloudflare components a group is written with, typed as SST 5's. */
export type CloudflareComponents = typeof cf;

/** The VPC the containers and databases are in. */
export type Vpc = InstanceType<typeof aws.Vpc>;

/**
 * SST 4's `ApiGatewayV2`, which is `ApiGatewayHttp` in 5.0, with the same type.
 */
function httpApi(aws: Components): Components["ApiGatewayHttp"] {
  return (
    sst4<Components["ApiGatewayHttp"]>(aws, "ApiGatewayV2") ??
    aws.ApiGatewayHttp
  );
}

/**
 * SST 4's Cloudflare `StaticSiteV2`, which is `StaticSite` in 5.0, with the
 * same type. 4.x's own `StaticSite` is the one `StaticSiteV2` replaced.
 */
function staticSite(
  cf: CloudflareComponents,
): CloudflareComponents["StaticSite"] {
  return (
    sst4<CloudflareComponents["StaticSite"]>(cf, "StaticSiteV2") ??
    cf.StaticSite
  );
}

/**
 * SST 4's component of that name, when the group is SST 4's. SST 5 has the
 * name too, as a stub that says what it's called now, which isn't a component.
 */
function sst4<T>(group: object, name: string): T | undefined {
  const value = (group as Record<string, unknown>)[name];
  return typeof (value as { __pulumiType?: unknown })?.__pulumiType === "string"
    ? (value as T)
    : undefined;
}

/** The domain the lab account has a hosted zone for, as scrubbed. */
export const zone = "lab.example.com";

/**
 * The sites group's router, without the sites, which build on this machine.
 * The sites route themselves through it and add nothing to it.
 */
export function router(aws: Components) {
  return new aws.Router("Router", { domain: `sites.v5lab.${zone}` });
}

/**
 * The sites group's Next.js site, at the router's root. The lab builds it
 * with OpenNext; a test builds it with `buildCommand`, from files it makes.
 */
export function next(
  aws: Components,
  instance: InstanceType<Components["Router"]>,
  buildCommand?: string,
) {
  return new aws.Nextjs("Next", {
    path: "sites/next",
    router: { instance },
    buildCommand,
  });
}

/**
 * The sites group's Astro site, on the router's path `/astro`. The lab builds
 * it with its build script; a test builds it with `buildCommand`, from files
 * it makes.
 */
export function astro(
  aws: Components,
  instance: InstanceType<Components["Router"]>,
  buildCommand?: string,
) {
  return new aws.Astro("Astro", {
    path: "sites/astro",
    router: { instance, path: "/astro" },
    buildCommand,
  });
}

/**
 * The sites group's SvelteKit app, on the router's path `/svelte`. The lab
 * builds it with its build script; a test builds it with `buildCommand`, from
 * files it makes.
 */
export function svelte(
  aws: Components,
  instance: InstanceType<Components["Router"]>,
  buildCommand?: string,
) {
  return new aws.SvelteKit("Svelte", {
    path: "sites/svelte",
    router: { instance, path: "/svelte" },
    buildCommand,
  });
}

/**
 * The sites group's static sites: one on the router's path `/static`, and one
 * with a distribution of its own. Neither is built: each folder is uploaded
 * as it is.
 */
export function staticSites(
  aws: Components,
  instance: InstanceType<Components["Router"]>,
) {
  return {
    files: new aws.StaticSite("Static", {
      path: "sites/static",
      router: { instance, path: "/static" },
    }),
    standalone: new aws.StaticSite("Standalone", { path: "sites/standalone" }),
  };
}

export function serverless(aws: Components) {
  const uploads = new aws.Bucket("Uploads");
  uploads.notify({
    notifications: [
      {
        name: "OnUpload",
        function: "functions/log.handler",
        events: ["s3:ObjectCreated:*"],
      },
    ],
  });

  const dead = new aws.Queue("Dead");
  const jobs = new aws.Queue("Jobs", { dlq: dead.arn });
  // A subscriber that links the queue it subscribes to
  jobs.subscribe({ handler: "functions/log.handler", link: [jobs] });

  const events = new aws.SnsTopic("Events");
  events.subscribe("Logger", "functions/log.handler");
  events.subscribeQueue("ToJobs", jobs.arn);

  const items = new aws.Dynamo("Items", {
    fields: { pk: "string", sk: "string" },
    primaryIndex: { hashKey: "pk", rangeKey: "sk" },
    stream: "new-and-old-images",
  });
  items.subscribe("OnChange", "functions/log.handler");

  const users = new aws.CognitoUserPool("Users", {
    triggers: { preSignUp: "functions/log.handler" },
  });
  const web = users.addClient("WebClient");

  // A function with a URL that reads everything it's linked to
  const links = new aws.Function("Links", {
    handler: "functions/links.handler",
    url: true,
    link: [uploads, jobs, events, items, users, web],
  });

  const api = new (httpApi(aws))("Api", { domain: `api.v5lab.${zone}` });
  // A route that links the API it's on
  api.route("GET /", { handler: "functions/hello.handler", link: [api] });
  api.route("GET /items/{id}", {
    handler: "functions/links.handler",
    link: [uploads, jobs, events, items, users, web],
  });
  const authorizer = api.addAuthorizer({
    name: "Token",
    lambda: { function: "functions/auth.handler" },
  });
  api.route("GET /private", "functions/hello.handler", {
    auth: { lambda: authorizer.id },
  });

  const graph = new aws.AppSync("Graph", { schema: "schema.graphql" });
  const lambdaDS = graph.addDataSource({
    name: "lambdaDS",
    lambda: "functions/graph.handler",
  });
  graph.addResolver("Query hello", { dataSource: lambdaDS.name });

  new aws.CronV2("Tick", {
    function: "functions/log.handler",
    schedule: "rate(1 hour)",
  });

  const bus = new aws.Bus("Bus");
  bus.subscribe("Logger", "functions/log.handler");

  // A domain as the sender: SES verifies it through the DKIM records the
  // component adds to the hosted zone
  const email = new aws.Email("Mail", { sender: `v5lab.${zone}` });

  return { links, api, graph, email };
}

/**
 * The VPC the containers and databases are in: a NAT gateway in each AZ, and
 * a bastion for `sst tunnel`.
 */
export function net(aws: Components): Vpc {
  return new aws.Vpc("Net", { nat: "managed", bastion: true });
}

export function containers(aws: Components, vpc: Vpc) {
  const cluster = new aws.Cluster("Cluster", { vpc });
  const files = new aws.Efs("Files", { vpc });

  // A service with a load balancer, certificate and domain of its own. Its
  // image is built from a Dockerfile.
  const web = new aws.Service("Web", {
    cluster,
    architecture: "arm64",
    image: { context: "./web" },
    loadBalancer: {
      domain: `web.v5lab.${zone}`,
      rules: [
        { listen: "80/http", redirect: "443/https" },
        { listen: "443/https", forward: "80/http" },
      ],
    },
    scaling: { min: 1, max: 2 },
    serviceRegistry: { port: 80 },
    volumes: [{ efs: files, path: "/mnt/efs" }],
  });

  // A load balancer two services could share, and a service on it
  const shared = new aws.Alb("Shared", {
    vpc,
    domain: `alb.v5lab.${zone}`,
    listeners: [
      { port: 80, protocol: "http" },
      { port: 443, protocol: "https" },
    ],
  });
  const onShared = new aws.Service("OnShared", {
    cluster,
    image: "public.ecr.aws/nginx/nginx:alpine",
    loadBalancer: {
      instance: shared,
      rules: [
        {
          listen: "443/https",
          forward: "80/http",
          conditions: { path: "/*" },
          priority: 100,
        },
      ],
    },
  });

  const job = new aws.Task("Job", {
    cluster,
    image: "public.ecr.aws/docker/library/busybox:stable",
    command: ["echo", "ran"],
  });
  new aws.CronV2("Nightly", { task: job, schedule: "rate(1 day)" });

  // A function in the VPC that mounts the file system and can run the task
  const mounted = new aws.Function("Mounted", {
    handler: "functions/files.handler",
    url: true,
    vpc,
    volume: { efs: files, path: "/mnt/efs" },
    link: [job, shared, web],
  });

  return { web, shared, onShared, mounted };
}

export function databases(aws: Components, vpc: Vpc) {
  const postgres = new aws.Postgres("Postgres", { vpc, proxy: true });
  // RDS no longer offers 8.0.40, the default of both versions of the component
  const mysql = new aws.Mysql("Mysql", { vpc, version: "8.0.46" });
  const redis = new aws.Redis("Redis", { vpc });
  const aurora = new aws.Aurora("Aurora", { engine: "postgres", vpc });
  const dsql = new aws.Dsql("Dsql", { vpc });

  // Reads what each database's link gives it
  const connections = new aws.Function("Connections", {
    handler: "functions/connections.handler",
    url: true,
    vpc,
    link: [postgres, mysql, redis, aurora, dsql],
  });

  return { connections };
}

/**
 * Cloudflare's components: a Worker linked to one of each kind of thing it
 * can bind, a queue with a consumer, a cron, and a static site. `Bucket` and
 * `Hyperdrive` are left out: the lab account has no R2, and there's no
 * database.
 */
export function cloudflare(cf: CloudflareComponents) {
  const dir = "functions/cf";

  const kv = new cf.Kv("CfKv");
  const db = new cf.D1("CfDb");
  const ai = new cf.Ai("CfAi");
  const limit = new cf.RateLimit("CfLimit", {
    namespaceId: 1001,
    limit: 100,
    period: "1 minute",
  });
  const counter = new cf.DurableObject("CfCounter", { className: "Counter" });
  const flow = new cf.Workflow("CfFlow", {
    handler: `${dir}/flow.ts`,
    className: "Flow",
    link: [kv],
  });

  const jobs = new cf.Queue("CfJobs");
  jobs.subscribe({ handler: `${dir}/consumer.ts`, link: [kv] });

  new cf.Cron("CfTick", {
    worker: { handler: `${dir}/cron.ts`, link: [kv] },
    schedules: ["* * * * *"],
  });

  const api = new cf.Worker("CfApi", {
    handler: `${dir}/api.ts`,
    url: true,
    link: [kv, db, jobs, ai, limit, counter, flow],
    migrations: [{ tag: "v1", newSqliteClasses: ["Counter"] }],
    environment: { MODE: "lab" },
    placement: { mode: "smart" },
  });

  const site = new (staticSite(cf))("CfSite", {
    path: "sites/cf-static",
    notFound: "404",
  });

  return { api, site };
}

/**
 * Cloudflare's three sites with a server, each linked to a KV namespace. The
 * lab builds each with its build script; a test builds them with
 * `buildCommand`, from files it makes.
 */
export function cfSites(cf: CloudflareComponents, buildCommand?: string) {
  const kv = new cf.Kv("CfSitesKv");

  const astro = new cf.Astro("CfAstro", {
    path: "sites/cf-astro",
    link: [kv],
    buildCommand,
  });
  const reactRouter = new cf.ReactRouter("CfReactRouter", {
    path: "sites/cf-react-router",
    link: [kv],
    buildCommand,
  });
  const tanStack = new cf.TanStackStart("CfTanStack", {
    path: "sites/cf-tanstack-start",
    link: [kv],
    buildCommand,
  });

  return { astro, reactRouter, tanStack };
}
