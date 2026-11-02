/**
 * The lab app that deployed the recorded states in `testdata/states`: its
 * groups as its `sst.config.ts` creates them, with the domain scrubbed as in
 * the states. Each takes the components it's written with, the 4.x ones or
 * the V5 ones, as `sst.aws` or `sst.aws.v5`.
 */
import type * as aws from "../../src/components/aws/index";

/** The components a group is written with. It's typed as the V5 ones. */
export type Components = typeof aws.v5;

/** The VPC the containers and databases are in: either kind of `Vpc`. */
export type Vpc =
  | InstanceType<typeof aws.Vpc>
  | InstanceType<typeof aws.v5.Vpc>;

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

  const api = new aws.ApiGatewayV2("Api", { domain: `api.v5lab.${zone}` });
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
export function net(
  aws: Components | typeof import("../../src/components/aws/index"),
): Vpc {
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
