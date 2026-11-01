/**
 * The lab app that deployed the recorded states in `testdata/states`: its
 * groups as its `sst.config.ts` creates them, with the domain scrubbed as in
 * the states. Each takes the components it's written with, the 4.x ones or
 * the V5 ones, as `sst.aws` or `sst.aws.v5`.
 */
import type * as aws from "../../src/components/aws/index";

/** The components a group is written with. It's typed as the V5 ones. */
export type Components = typeof aws.v5;

/** The domain the lab account has a hosted zone for, as scrubbed. */
export const zone = "lab.example.com";

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
