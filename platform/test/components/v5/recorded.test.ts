import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";
import { SECRET, SIG } from "../../../src/testing/state";

// The V5 components against what v4.23.1 really deployed for the lab app
// (`testdata/states`), with the app's own config (`test/recorded`). The mock
// is given the state, so what's registered gets the ids and outputs AWS gave.
// First the 4.x components run, and have to give what the state has. Then the
// V5 ones, which have to take over what the 4.x ones gave.

const states = path.join(__dirname, "../../../../testdata/states/v4.23.1");
const app = path.join(__dirname, "../../recorded");

// What a function's build wrote: the CLI's build made one source map each
const sourcemap = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "sst-recorded-")),
  "bundle.mjs.map",
);
fs.writeFileSync(sourcemap, "{}");

// What the lab account answered the lookups a deploy made, as scrubbed
const lookups: Record<string, (inputs: any) => Record<string, any>> = {
  "aws:route53/getZone:getZone": (inputs) => ({
    ...inputs,
    zoneId: "Z00000000000000EXAMPLE",
    id: "Z00000000000000EXAMPLE",
  }),
  "aws:index/getAvailabilityZones:getAvailabilityZones": (inputs) => ({
    ...inputs,
    names: ["us-west-2a", "us-west-2b", "us-west-2c", "us-west-2d"],
  }),
  // The bastion's image
  "aws:ec2/getAmi:getAmi": (inputs) => ({
    ...inputs,
    id: "ami-0d2beaff07e79c24e",
  }),
  // The V5 `Vpc` asks Amazon's public parameter for it. Here it names the
  // image 4.x found; when it doesn't, a move replaces the bastion, as the
  // `Vpc`'s state map says.
  "aws:ssm/getParameter:getParameter": (inputs) => ({
    ...inputs,
    ...(inputs.name.startsWith("/aws/service/ami-amazon-linux-latest/")
      ? {
          value: "ami-0d2beaff07e79c24e",
          insecureValue: "ami-0d2beaff07e79c24e",
        }
      : {}),
  }),
  // What an image is pushed with. The provider returns the password as a
  // secret.
  "aws:ecr/getAuthorizationToken:getAuthorizationToken": (inputs) => ({
    ...inputs,
    proxyEndpoint: "https://123456789012.dkr.ecr.us-west-2.amazonaws.com",
    userName: "AWS",
    password: { [SIG]: SECRET, value: "token" },
  }),
};

/** The mock, given a recorded state and what the CLI answered for it. */
function replay(file: string, stage: string) {
  return mockPulumi({
    app: "v5-lab",
    stage,
    root: app,
    // The app was deployed from another folder
    recorded: JSON.parse(
      fs
        .readFileSync(path.join(states, file), "utf8")
        .replaceAll("/home/user/v5-lab", app),
    ),
    sourcemaps: () => [sourcemap],
    call: (args) => lookups[args.token]?.(args.inputs),
    // The lab account's bootstrap, where functions' code went
    cli: (method) =>
      method === "Provider.Aws.Bootstrap"
        ? {
            asset: "sst-asset-xoecubtcmnma",
            assetEcrRegistryId: "123456789012",
            assetEcrUrl:
              "123456789012.dkr.ecr.us-west-2.amazonaws.com/sst-asset",
            state: "sst-state-bucket",
            appsyncHttp: "appsync.example.com",
            appsyncRealtime: "appsync-realtime.example.com",
          }
        : undefined,
  });
}

type Run = Awaited<ReturnType<ReturnType<typeof replay>["takesOverState"]>>;

// A program runs in its app's folder, which a 4.x component reads files from
process.chdir(app);

describe("the lab's serverless group, as v4.23.1 deployed it", () => {
  let run: Run;
  beforeAll(async () => {
    // The engine's mock is one for the process, so it's made here
    const pulumi = replay("serverless-sites.json", "rec");
    const aws = await import("../../../src/components/aws/index");
    const { serverless } = await import("../../recorded/v5-lab");
    run = await pulumi.takesOverState(
      () => serverless(aws as any),
      () => serverless(aws.v5 as any),
      // What the 4.x components don't make: the sites deployed beside them,
      // and the link references the program's runner makes for each
      // component, which the mock doesn't run
      (r) =>
        r.type === "sst:sst:LinkRef" ||
        /^(Router|Static|Svelte|Next|Astro|Standalone)/.test(
          r.parent ? r.parent.split("::").at(-1)! : r.name,
        ),
    );
  });

  it("is what the 4.x components deploy", () => {
    const { deployed } = run;
    expect(deployed.unclaimed).toEqual([]);
    expect(deployed.created).toEqual([]);
    expect(deployed.unordered).toEqual([]);
    expect(deployed.revealed).toEqual([]);
    expect(deployed.hidden).toEqual([]);
    // Since v4.23.1, a subscriber's function is named without "Function"
    // twice (#214), so its code is uploaded under a new key
    expect(deployed.changed.map((c) => [c.name, c.fields])).toEqual(
      [
        "BusSubscriberLoggerFunctionCode",
        "EventsSubscriberLoggerFunctionCode",
        "ItemsSubscriberOnChangeFunctionCode",
        "JobsSubscriberKksukeFunctionCode",
      ].map((name) => [name, ["key"]]),
    );
  });

  it("is taken over by the V5 components", () => {
    const { result } = run;
    // Only the components 4.x wrapped things in go, with nothing in AWS
    // behind them
    expect(result.unclaimed).toEqual([
      "sst:aws:ApiGatewayV2Authorizer::ApiAuthorizerToken",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteDnvusb",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteKthwzz",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteMkfhwn",
      "sst:aws:AppSyncDataSource::GraphDataSourceLambdaDS",
      "sst:aws:AppSyncResolver::GraphResolverQueryHello",
      "sst:aws:BucketNotification::UploadsNotifications",
      "sst:aws:BusLambdaSubscriber::BusSubscriberLogger",
      "sst:aws:DynamoLambdaSubscriber::ItemsSubscriberOnChange",
      "sst:aws:QueueLambdaSubscriber::JobsSubscriberKksuke",
      "sst:aws:SnsTopicLambdaSubscriber::EventsSubscriberLogger",
      "sst:aws:SnsTopicQueueSubscriber::EventsSubscriberToJobs",
    ]);
    // Everything V5 makes takes the place of something 4.x made
    expect(result.created).toEqual([]);
    expect(result.changed.map((c) => [c.name, c.fields])).toEqual([
      // A subscriber's function says what it's subscribed to by the
      // component's name
      ["EventsSubscriberLoggerFunction", ["description"]],
      ["ItemsSubscriberOnChangeFunction", ["description"]],
      ["JobsSubscriberKksukeFunction", ["description"]],
      ["UploadsNotificationsNotificationOnUploadFunction", ["description"]],
      // A function's code is uploaded under its part's name, and the V5
      // Function's state map lists its code as replaced
      ...[
        "ApiAuthorizerTokenHandlerCode",
        "ApiRouteDnvusbHandlerCode",
        "ApiRouteKthwzzHandlerCode",
        "ApiRouteMkfhwnHandlerCode",
        "GraphDataSourceLambdaDSFunctionCode",
        "JobsSubscriberKksukeCode",
        "TickHandlerCode",
        "UploadsNotificationsNotificationOnUploadCode",
        "UsersTriggerpreSignUpCode",
      ].map((name) => [name, ["key"]]),
    ]);
    expect(result.unordered.filter((order) => !needless(order))).toEqual([]);
  });

  it("keeps secret what was secret, but for what's made from a function's ARN", () =>
    keepsSecrets(run.result, true));
});

// 4.x creates a function inside an apply that reads the key its links are
// encrypted with, a secret, so everything made from the function's ARN is a
// secret too. V5 doesn't. V5 builds a function's code with the key, so its
// code object's key, and its source maps', are secrets: in `sst dev` there
// are none. A deploy updates nothing for either.
function keepsSecrets(result: Run["result"], built: boolean) {
  const now = new Map(
    result.pairs.map(([before, now]) => [before.name, now] as const),
  );
  expect(result.revealed.length).toBeGreaterThan(0);
  for (const place of result.revealed) {
    const [name, ...path] = place.split(".");
    expect(String(valueAt(now.get(name)!.inputs, path)), place).toMatch(
      /arn:aws:lambda:[\w-]+:\d+:function:|^[\w-]+Function-[a-z]{8}$/,
    );
  }
  if (!built) expect(result.hidden).toEqual([]);
  else expect(result.hidden.length).toBeGreaterThan(0);
  for (const place of result.hidden)
    expect(place).toMatch(/(Code|Sourcemap0)\.(key|source)$/);
}

// Orders the 4.x components remove resources in that nothing in AWS needs
function needless(order: string) {
  return (
    // A 4.x route or authorizer function depends on the API, as in the
    // ApiGatewayV2 suite
    /Function before ApiApi$/.test(order) ||
    // A 4.x route depends on all of its API, so it's removed before the
    // API's domain, stage and log group. Its integration and permission
    // need only the API and the function.
    /^Api(Integration|Permission)GET\w+ before Api(DomainMapping|DomainName|Stage|LogGroup|A+(Record|ZoneLookup)\w+|Certificate\w+)(\.sst\.aws\.HostedZoneLookup)?$/.test(
      order,
    ) ||
    // A 4.x function depends on all of each component it links, so it's
    // removed before their other resources, like a bucket's CORS rules or
    // a user pool's client. The V5 one depends on its role, whose policy
    // names what it links, and on nothing it only reads, like a client's
    // secret: removing a function needs none of them.
    /^(LinksUrl\w*|Api(Integration|Permission)GETitemsid\w+) before (UploadsCors|UsersPermissionPreSignUp|UsersTriggerPreSignUpSourcemap0|WebClientClient)$/.test(
      order,
    ) ||
    // The same for a function's URL and the permissions to call it, which
    // 4.x creates with what the function links and the VPC it's in. The V5
    // function itself is still removed before its subnets.
    /^(Connections|Mounted)Url\w* before (?!Connections|Mounted)/.test(order) ||
    // The 4.x Service's load balancer depends on what the service runs in,
    // its cluster, file system and private subnets, as in the Service suite.
    // It's in the public subnets, and has nothing to do with them.
    /^WebLoadBalancer before (ClusterCluster|Files\w+|NetPrivateSubnet\d)$/.test(
      order,
    )
  );
}

describe("the lab's router, as v4.23.1 deployed it", () => {
  let run: Run;
  beforeAll(async () => {
    const pulumi = replay("serverless-sites.json", "rec");
    const aws = await import("../../../src/components/aws/index");
    const { router } = await import("../../recorded/v5-lab");
    run = await pulumi.takesOverState(
      () => router(aws as any),
      () => router(aws.v5 as any),
      // Everything but the router: the serverless group, the sites, and the
      // link references
      (r) =>
        r.type === "sst:sst:LinkRef" ||
        !/^Router/.test(r.parent ? r.parent.split("::").at(-1)! : r.name),
    );
  });

  it("is what the 4.x Router deploys", () => {
    const { deployed } = run;
    expect(deployed.unclaimed).toEqual([]);
    expect(deployed.created).toEqual([]);
    expect(deployed.changed).toEqual([]);
    expect(deployed.unordered).toEqual([]);
    expect(deployed.revealed).toEqual([]);
  });

  it("is taken over by the V5 Router, with nothing changed", () => {
    const { result } = run;
    expect(result.unclaimed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unordered.filter((order) => !needless(order))).toEqual([]);
    expect(result.revealed).toEqual([]);
  });
});

describe("the lab's serverless group, as v4.23.1 deployed it in sst dev", () => {
  let run: Run;
  beforeAll(async () => {
    // The engine's mock is one for the process, so it's made here
    const pulumi = replay("serverless-dev.json", "recdev");
    // @ts-ignore
    global.$dev = true;
    const aws = await import("../../../src/components/aws/index");
    const { serverless } = await import("../../recorded/v5-lab");
    run = await pulumi.takesOverState(
      () => serverless(aws as any),
      () => serverless(aws.v5 as any),
      (r) => r.type === "sst:sst:LinkRef",
    );
    // @ts-ignore
    global.$dev = false;
  });

  it("is what the 4.x components deploy", () => {
    const { deployed } = run;
    expect(deployed.unclaimed).toEqual([]);
    expect(deployed.created).toEqual([]);
    expect(deployed.unordered).toEqual([]);
    expect(deployed.revealed).toEqual([]);
    expect(deployed.hidden).toEqual([]);
    // Since v4.23.1, a subscriber's function is named without "Function"
    // twice (#214), and its id in `sst dev` is its name
    expect(deployed.changed.map((c) => [c.name, c.fields])).toEqual(
      [
        "EventsSubscriberLoggerFunction",
        "BusSubscriberLoggerFunction",
        "ItemsSubscriberOnChangeFunction",
        "JobsSubscriberDwcccmFunction",
      ].map((name) => [name, ["outputs"]]),
    );
  });

  it("is taken over by the V5 components", () => {
    const { result } = run;
    expect(result.unclaimed).toEqual([
      "sst:aws:ApiGatewayV2Authorizer::ApiAuthorizerToken",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteDnvusb",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteKthwzz",
      "sst:aws:ApiGatewayV2LambdaRoute::ApiRouteMkfhwn",
      "sst:aws:AppSyncDataSource::GraphDataSourceLambdaDS",
      "sst:aws:AppSyncResolver::GraphResolverQueryHello",
      "sst:aws:BucketNotification::UploadsNotifications",
      "sst:aws:BusLambdaSubscriber::BusSubscriberLogger",
      "sst:aws:DynamoLambdaSubscriber::ItemsSubscriberOnChange",
      "sst:aws:QueueLambdaSubscriber::JobsSubscriberDwcccm",
      "sst:aws:SnsTopicLambdaSubscriber::EventsSubscriberLogger",
      "sst:aws:SnsTopicQueueSubscriber::EventsSubscriberToJobs",
    ]);
    expect(result.created).toEqual([]);
    // In `sst dev`, a function's id is its part's name: its stub's
    // environment, and what the component says the CLI runs locally. And a
    // subscriber's says what it's subscribed to by the component's name.
    const functions = [
      "ApiAuthorizerTokenHandler",
      "ApiRouteDnvusbHandler",
      "ApiRouteKthwzzHandler",
      "ApiRouteMkfhwnHandler",
      "GraphDataSourceLambdaDSFunction",
      "JobsSubscriberDwcccm",
      "TickHandler",
      "UploadsNotificationsNotificationOnUpload",
      "UsersTriggerpreSignUp",
    ];
    expect(
      Object.fromEntries(result.changed.map((c) => [c.name, c.fields])),
    ).toEqual({
      ...Object.fromEntries(functions.map((name) => [name, ["outputs"]])),
      ...Object.fromEntries(
        functions
          .filter((name) => name !== "JobsSubscriberDwcccm")
          .filter((name) => name !== "UploadsNotificationsNotificationOnUpload")
          .map((name) => [`${name}Function`, ["environment"]]),
      ),
      EventsSubscriberLoggerFunction: ["description"],
      ItemsSubscriberOnChangeFunction: ["description"],
      JobsSubscriberDwcccmFunction: ["description", "environment"],
      UploadsNotificationsNotificationOnUploadFunction: [
        "description",
        "environment",
      ],
    });
    for (const c of result.changed.filter((c) =>
      c.fields.includes("environment"),
    )) {
      const { SST_FUNCTION_ID: was, ...before } =
        c.original.environment.variables;
      const { SST_FUNCTION_ID: is, ...now } = c.now.environment.variables;
      expect(now, c.name).toEqual(before);
      expect(is, c.name).not.toEqual(was);
    }
    expect(result.unordered.filter((order) => !needless(order))).toEqual([]);
  });

  // What a function in `sst dev` says the CLI runs locally names its links,
  // and doesn't hold what they hold, like a client's secret
  it("keeps secret what was secret, but for what's made from a function's ARN", () =>
    keepsSecrets(run.result, false));
});

// The value at a place in an object, as `revealed` names it after the
// resource: `environment.variables.KEY`, `statements[0]`
function valueAt(value: any, path: string[]) {
  return path
    .flatMap((key) => key.split(/(?=\[)/))
    .reduce(
      (v, key) => v?.[key.startsWith("[") ? Number(key.slice(1, -1)) : key],
      value,
    );
}

describe("the lab's VPC groups, as v4.23.1 deployed them", () => {
  let run: Run;
  let pulumi: ReturnType<typeof replay>;
  beforeAll(async () => {
    // The engine's mock is one for the process, so it's made here
    pulumi = replay("vpc-containers-databases.json", "recvpc");
    const aws = await import("../../../src/components/aws/index");
    const lab = await import("../../recorded/v5-lab");
    const groups = (components: any) => () => {
      const vpc = lab.net(components);
      lab.containers(components, vpc);
      lab.databases(components, vpc);
    };
    run = await pulumi.takesOverState(
      groups(aws),
      groups(aws.v5),
      (r) => r.type === "sst:sst:LinkRef",
    );
  });

  it("is what the 4.x components deploy", () => {
    const { deployed } = run;
    expect(deployed.unclaimed).toEqual([]);
    expect(deployed.created).toEqual([]);
    expect(deployed.changed).toEqual([]);
    expect(deployed.unordered).toEqual([]);
    expect(deployed.revealed).toEqual([]);
    expect(deployed.hidden).toEqual([]);
  });

  it("is taken over by the V5 components", () => {
    const { result } = run;
    expect(result.unclaimed).toEqual([
      // What `sst dev` runs for a service was kept at the top of the app,
      // with nothing in AWS behind it. The V5 one keeps it inside the
      // service.
      "sst:sst:DevCommand::OnSharedDev",
      "sst:sst:DevCommand::WebDev",
      // 4.x's version markers, with nothing in AWS behind them
      "sst:sst:Version::ClusterVersion",
      "sst:sst:Version::NetVersion",
      "sst:sst:Version::PostgresVersion",
      "sst:sst:Version::RedisVersion",
    ]);
    expect(result.created).toEqual([
      "sst:sst:DevCommand::OnSharedDevCommandOnShared",
      "sst:sst:DevCommand::WebDevCommandWeb",
    ]);
    expect(result.changed).toEqual([]);
    expect(result.unordered.filter((order) => !needless(order))).toEqual([]);
    // A function in the VPC is removed before the subnets its network
    // interfaces are in
    for (const name of ["ConnectionsFunction", "MountedFunction"])
      for (const subnet of ["NetPrivateSubnet1", "NetPrivateSubnet2"])
        expect(pulumi.dependsOn(name, subnet), `${name} on ${subnet}`).toBe(
          true,
        );
  });

  it("keeps secret what was secret, but for what's made from a function's ARN", () =>
    keepsSecrets(run.result, true));
});
