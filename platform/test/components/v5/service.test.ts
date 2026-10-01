import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const SERVICE = "aws:ecs/service:Service";
const IMAGE = "docker-build:index:Image";
const ROLE = "aws:iam/role:Role";
const LOAD_BALANCER = "aws:lb/loadBalancer:LoadBalancer";
const DEV_COMMAND = "sst:sst:DevCommand";
const ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shared/1";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
const mockArn = (name: string) => `arn:aws:mock:us-east-1:123456789012:${name}`;

const pulumi = mockPulumi({
  state: (args) => {
    if (args.type === IMAGE) return { digest: `sha256:${args.name}` };
    // A role that's looked up has the ARN it has
    if (args.type === ROLE && args.id)
      return { arn: `arn:aws:iam::123456789012:role/${args.id}` };
    // A load balancer that's looked up
    if (args.type === LOAD_BALANCER && args.id)
      return {
        arn: args.id,
        dnsName: "shared.us-east-1.elb.amazonaws.com",
        vpcId: "vpc-1",
        securityGroups: ["sg-alb"],
      };
    if (args.type === LOAD_BALANCER)
      return {
        arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${args.name}/50dc6c495c0c9188`,
        dnsName: `${args.name}.us-east-1.elb.amazonaws.com`,
        zoneId: "Z35SXDOTRQ7X7K",
      };
    if (args.type === "aws:lb/targetGroup:TargetGroup")
      return {
        arn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${args.name}/73e2d6bc24d8a067`,
      };
    if (args.type === "aws:acm/certificate:Certificate")
      return {
        domainValidationOptions: [
          {
            resourceRecordType: "CNAME",
            resourceRecordName: "_abc.example.com.",
            resourceRecordValue: "_def.acm-validations.aws.",
          },
        ],
      };
    return {};
  },
  call: (args) => {
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
    if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken")
      return {
        proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
        userName: "AWS",
        password: "token",
      };
    if (args.token === "aws:lb/getListener:getListener")
      return { arn: `${ALB_ARN}/listener/${args.inputs.port}` };
    return undefined;
  },
});

type ServiceClass =
  | typeof import("../../../src/components/aws/service").Service
  | typeof import("../../../src/components/aws/v5/service").Service;

describe("Service", () => {
  let OriginalService: typeof import("../../../src/components/aws/service").Service;
  let Service: typeof import("../../../src/components/aws/v5/service").Service;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let ClusterClass: typeof import("../../../src/components/aws/cluster").Cluster;
  let Alb: typeof import("../../../src/components/aws/alb").Alb;
  let Efs: typeof import("../../../src/components/aws/efs").Efs;
  let Bucket: typeof import("../../../src/components/aws/v5/bucket").Bucket;
  // Where the Dockerfiles are. Building an image adds `.sst` to the ignore
  // file next to its Dockerfile.
  let app: string;
  let admin: string;

  beforeAll(async () => {
    OriginalService = (await import("../../../src/components/aws/service"))
      .Service;
    Service = (await import("../../../src/components/aws/v5/service")).Service;
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    ClusterClass = (await import("../../../src/components/aws/cluster"))
      .Cluster;
    Alb = (await import("../../../src/components/aws/alb")).Alb;
    Efs = (await import("../../../src/components/aws/efs")).Efs;
    Bucket = (await import("../../../src/components/aws/v5/bucket")).Bucket;
    await import("../../../src/components/aws/takeover/service");
    await import("../../../src/components/aws/takeover/bucket");

    app = fs.mkdtempSync(path.join(os.tmpdir(), "sst-service-"));
    admin = path.join(app, "admin");
    fs.mkdirSync(admin);
  });

  afterAll(() => fs.rmSync(app, { recursive: true, force: true }));

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const named = (prefix: string) =>
    pulumi.resources
      .filter((r) => r.name.startsWith(prefix))
      .map((r) => r.name)
      .sort();
  const cluster = () =>
    new ClusterClass("MyCluster", { vpc: new Vpc("MyVpc") });
  const customVpc = {
    id: "vpc-1",
    securityGroups: ["sg-1"],
    containerSubnets: ["subnet-private-1", "subnet-private-2"],
    loadBalancerSubnets: ["subnet-public-1", "subnet-public-2"],
  };
  const customCluster = (vpc: object = {}) =>
    new ClusterClass("MyCluster", { vpc: { ...customVpc, ...vpc } });
  const alb = () =>
    new Alb("MyAlb", {
      vpc: {
        id: "vpc-1",
        publicSubnets: ["subnet-public-1", "subnet-public-2"],
        privateSubnets: ["subnet-private-1", "subnet-private-2"],
      },
      listeners: [
        { port: 80, protocol: "http" },
        { port: 8080, protocol: "http" },
      ],
    });
  // The definitions are a secret when an image is built: it's pushed with
  // the registry's password
  const definitions = (name = "MyServiceTaskDefinition") => {
    const json = resource(name).inputs.containerDefinitions;
    return JSON.parse(typeof json === "string" ? json : json.value);
  };
  // What `sst dev` is told to run, by the title of its tab
  const devCommands = () =>
    Object.fromEntries(
      pulumi.resources
        .filter((r) => r.type === DEV_COMMAND)
        .map((r) => pulumi.outputsOf(r.name)!._dev)
        .map((dev) => [dev.title, dev]),
    );

  // Each case deploys the 4.x Service, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs. What `sst dev` runs for a container was kept at the top of the
  // app, with nothing in AWS behind it. The V5 one keeps it inside the service.
  describe("takes over a deployed Service", () => {
    pulumi.takeoverCases({
      original: () => OriginalService,
      v5: () => Service,
      unclaimed: [`${DEV_COMMAND}::MyServiceDev`],
      // What the CLI shows as the service's URL, `_hint`, is compared with
      // the rest. The cases with a load balancer check that there is one.
      check: () => expect(resource("MyServiceService").type).toBe(SERVICE),
      cases: {
        "an image that's pulled": (Service, opts) => {
          new Service(
            "MyService",
            { cluster: cluster(), image: "nginx:latest" },
            opts,
          );
        },
        "an image built with every setting": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              architecture: "arm64",
              cpu: "1 vCPU",
              memory: "4 GB",
              storage: "50 GB",
              image: {
                context: app,
                dockerfile: "Dockerfile.service",
                args: { NODE_ENV: "production" },
                secrets: { NPM_TOKEN: "token" },
                tags: ["latest", "v1"],
                target: "runner",
                cache: false,
              },
            },
            opts,
          );
        },
        "what the container runs with": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              command: ["node", "index.js"],
              entrypoint: ["/usr/bin/tini", "--"],
              environment: { STAGE: "test", LEVEL: "debug" },
              environmentFiles: ["arn:aws:s3:::my-bucket/my-env-file.env"],
              ssm: {
                API_KEY: "arn:aws:ssm:us-east-1:123456789012:parameter/key",
              },
              logging: { retention: "1 week", name: "/custom/service" },
              health: {
                command: [
                  "CMD-SHELL",
                  "curl -f http://localhost:3000/ || exit 1",
                ],
                startPeriod: "60 seconds",
                timeout: "5 seconds",
                interval: "30 seconds",
                retries: 3,
              },
              permissions: [
                {
                  actions: ["s3:GetObject"],
                  resources: ["arn:aws:s3:::my-bucket/*"],
                },
              ],
              dev: { command: "node dev.js", directory: "packages/app" },
            },
            opts,
          );
        },
        "linked resources": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: { context: app },
              link: [new Bucket("MyBucket")],
            },
            opts,
          );
        },
        "settings given as outputs": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              architecture: output("arm64" as const),
              image: output({ context: output(app), target: "runner" }),
              command: output(["node", output("index.js")]),
              environment: output({ STAGE: output("test") }),
              logging: output({ retention: "1 week" as const }),
              health: output({ command: output(["CMD", "true"]) }),
              wait: output(true),
              capacity: output("spot" as const),
              serviceRegistry: output({ port: 8080 }),
            },
            opts,
          );
        },
        "several containers": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                containers: [
                  {
                    name: "app",
                    image: "nginxdemos/hello:plain-text",
                    cpu: "0.125 vCPU",
                    memory: "0.25 GB",
                    environment: { ROLE: "app" },
                    health: { command: ["CMD", "true"], retries: 5 },
                    dev: { command: "node app.js" },
                  },
                  {
                    name: "admin-panel",
                    image: { context: admin },
                    command: ["node", "admin.js"],
                    logging: { retention: "3 days" },
                    dev: {
                      command: "node admin.js",
                      autostart: false,
                      directory: "packages/admin",
                    },
                  },
                ],
              },
              opts,
            );
          },
          unclaimed: [
            `${DEV_COMMAND}::MyServiceadmin-panelDev`,
            `${DEV_COMMAND}::MyServiceappDev`,
          ],
        },
        "a volume several containers mount": {
          create: (Service, opts) => {
            const efs = new Efs("MyEfs", {
              vpc: { id: "vpc-1", subnets: ["subnet-1"] },
            });
            new Service(
              "MyService",
              {
                cluster: cluster(),
                containers: [
                  {
                    name: "app",
                    image: "nginx:latest",
                    volumes: [{ efs, path: "/mnt/efs" }],
                  },
                  {
                    name: "worker",
                    image: "nginx:latest",
                    volumes: [
                      { efs, path: "/data" },
                      {
                        efs: { fileSystem: "fs-2", accessPoint: "fsap-2" },
                        path: "/more",
                      },
                    ],
                  },
                ],
              },
              opts,
            );
          },
          unclaimed: [
            `${DEV_COMMAND}::MyServiceappDev`,
            `${DEV_COMMAND}::MyServiceworkerDev`,
          ],
        },
        "a service that waits, with a port in the registry": (
          Service,
          opts,
        ) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              wait: true,
              serviceRegistry: { port: 80 },
            },
            opts,
          );
        },
        "all spot capacity": (Service, opts) => {
          new Service(
            "MyService",
            { cluster: cluster(), image: "nginx:latest", capacity: "spot" },
            opts,
          );
        },
        "a share of spot capacity": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              capacity: {
                fargate: { weight: 1, base: 2 },
                spot: { weight: 3 },
              },
            },
            opts,
          );
        },
        "spot capacity alone": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              capacity: { spot: { weight: 1 } },
            },
            opts,
          );
        },
        "scaling on cpu and memory": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              scaling: {
                min: 4,
                max: 16,
                cpuUtilization: 50,
                memoryUtilization: 60,
                scaleInCooldown: "60 seconds",
                scaleOutCooldown: "2 minutes",
              },
            },
            opts,
          );
        },
        "scaling on neither cpu nor memory": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                scaling: {
                  max: output(3),
                  cpuUtilization: false,
                  memoryUtilization: false,
                },
              },
              opts,
            );
          },
          check: () =>
            expect(named("MyServiceAutoScaling")).toEqual([
              "MyServiceAutoScalingTarget",
            ]),
        },
        "scaling on the requests a load balancer gets": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              loadBalancer: { rules: [{ listen: "80/http" }] },
              scaling: { max: 4, requestCount: 1500, memoryUtilization: false },
            },
            opts,
          );
        },
        "a load balancer": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  rules: [{ listen: "80/http", forward: "8080/http" }],
                },
              },
              opts,
            );
          },
          check: () =>
            expect(pulumi.outputsOf("MyService")?._hint).toBe(
              "http://MyServiceLoadBalancer.us-east-1.elb.amazonaws.com",
            ),
        },
        "a private load balancer with a health check": (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: "nginx:latest",
              loadBalancer: {
                public: false,
                rules: [
                  { listen: "80/http", forward: "8080/http" },
                  { listen: "8000/http", forward: "9000/http" },
                ],
                health: {
                  "8080/http": {
                    path: "/health",
                    interval: "10 seconds",
                    timeout: "3 seconds",
                    healthyThreshold: 2,
                    unhealthyThreshold: 3,
                    successCodes: "200-299",
                  },
                  "9000/http": {},
                },
              },
            },
            opts,
          );
        },
        "a domain on Route 53, with http sent to https": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  domain: "example.com",
                  rules: [
                    { listen: "80/http", redirect: "443/https" },
                    { listen: "443/https", forward: "80/http" },
                  ],
                },
              },
              opts,
            );
          },
          check: () => {
            // The certificate, its record and the alias records are all there
            const types = pulumi.resources.map((r) => r.type);
            expect(types).toContain("sst:aws:Certificate");
            expect(
              types.filter((type) => type === "aws:route53/record:Record")
                .length,
            ).toBe(3);
            expect(pulumi.outputsOf("MyService")?._hint).toBe(
              "https://example.com/",
            );
          },
        },
        "a domain with aliases": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  domain: {
                    name: "app.example.com",
                    aliases: ["www.example.com", "*.app.example.com"],
                  },
                  rules: [{ listen: "443/https", forward: "80/http" }],
                },
              },
              opts,
            );
          },
          check: () =>
            expect(
              pulumi.resources.filter(
                (r) => r.type === "aws:route53/record:Record",
              ).length,
            ).toBe(7),
        },
        "a domain with a certificate of its own": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  domain: { name: "example.com", dns: false, cert: CERT_ARN },
                  rules: [{ listen: "443/https", forward: "80/http" }],
                },
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MyServiceListenerHTTPS443").inputs).toMatchObject({
              certificateArn: CERT_ARN,
            }),
        },
        "rules with conditions": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                containers: [
                  { name: "app", image: "nginx:latest" },
                  { name: "admin-panel", image: "nginx:latest" },
                ],
                loadBalancer: {
                  rules: [
                    {
                      listen: "80/http",
                      container: "app",
                      conditions: { path: "/api/*" },
                    },
                    {
                      listen: "80/http",
                      forward: "8080/http",
                      container: "admin-panel",
                      conditions: {
                        path: "/admin/*",
                        query: [
                          { key: "version", value: "v1" },
                          { value: "x" },
                        ],
                        header: { name: "X-Team", values: ["a", "b*"] },
                      },
                    },
                    { listen: "8000/http", container: "admin-panel" },
                    {
                      listen: "8000/http",
                      redirect: "80/http",
                      container: "app",
                      conditions: { header: { name: "X-Old", values: ["1"] } },
                    },
                  ],
                },
              },
              opts,
            );
          },
          unclaimed: [
            `${DEV_COMMAND}::MyServiceadmin-panelDev`,
            `${DEV_COMMAND}::MyServiceappDev`,
          ],
          check: () =>
            expect(
              pulumi.resources.filter(
                (r) => r.type === "aws:lb/listenerRule:ListenerRule",
              ).length,
            ).toBe(3),
        },
        "a network load balancer": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  domain: "example.com",
                  rules: [
                    { listen: "80/tcp" },
                    { listen: "53/tcp_udp", forward: "5353/tcp_udp" },
                    { listen: "514/udp" },
                    { listen: "443/tls", forward: "8443/tcp" },
                  ],
                  health: { "5353/tcp_udp": { interval: "10 seconds" } },
                },
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MyServiceLoadBalancer").inputs).toMatchObject({
              loadBalancerType: "network",
            }),
        },
        "a load balancer it shares": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: customCluster(),
                image: "nginx:latest",
                loadBalancer: {
                  instance: alb(),
                  rules: [
                    {
                      listen: "80/http",
                      forward: "8080/http",
                      conditions: { path: "/api/*" },
                      priority: 100,
                    },
                    {
                      listen: "8080/http",
                      forward: "8080/http",
                      conditions: {
                        query: [{ key: "version", value: "v1" }],
                        header: { name: "X-Team", values: ["a"] },
                      },
                      priority: 200,
                    },
                    {
                      listen: "80/http",
                      forward: "9000/http",
                      conditions: { path: "/admin/*" },
                      priority: 101,
                    },
                  ],
                  health: {
                    "9000/http": { path: "/health", interval: "10 seconds" },
                  },
                },
                scaling: { requestCount: 500 },
              },
              opts,
            );
          },
          check: () =>
            expect(pulumi.outputsOf("MyService")?._hint).toBe(
              "http://MyAlbLoadBalancer.us-east-1.elb.amazonaws.com",
            ),
        },
        "several containers behind a load balancer it shares": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: customCluster(),
                containers: [
                  { name: "app", image: "nginx:latest" },
                  { name: "admin-panel", image: "nginx:latest" },
                ],
                loadBalancer: {
                  instance: alb(),
                  rules: [
                    {
                      listen: "80/http",
                      forward: "8080/http",
                      container: "app",
                      conditions: { path: output("/api/*") },
                      priority: 100,
                    },
                    {
                      listen: "80/http",
                      forward: "8080/http",
                      container: "admin-panel",
                      conditions: {
                        header: output({ name: "X-Team", values: ["a"] }),
                      },
                      priority: 200,
                    },
                  ],
                },
              },
              opts,
            );
          },
          unclaimed: [
            `${DEV_COMMAND}::MyServiceadmin-panelDev`,
            `${DEV_COMMAND}::MyServiceappDev`,
          ],
        },
        "a load balancer it shares, referenced by its ARN": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: customCluster(),
                image: "nginx:latest",
                loadBalancer: {
                  instance: Alb.get("MyAlb", ALB_ARN),
                  rules: [
                    {
                      listen: "443/https",
                      forward: "8080/http",
                      conditions: { path: "/api/*" },
                      priority: 100,
                    },
                  ],
                },
              },
              opts,
            );
          },
          check: () => {
            // The listener is looked up on the load balancer
            expect(resource("MyAlbListenerHTTPS443")).toMatchObject({
              kind: "read",
              options: { id: `${ALB_ARN}/listener/443` },
            });
            expect(
              resource("MyServiceListenerRuleHTTPS443P100").inputs.listenerArn,
            ).toBe(mockArn("MyAlbListenerHTTPS443"));
            expect(pulumi.outputsOf("MyService")?._hint).toBe(
              "http://shared.us-east-1.elb.amazonaws.com",
            );
          },
        },
        "a VPC of your own": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: customCluster(),
                image: "nginx:latest",
                loadBalancer: { rules: [{ listen: "80/http" }] },
              },
              opts,
            );
          },
          check: () => {
            expect(named("MyServiceCloudmap")).toEqual([]);
            expect(resource("MyServiceService").inputs).toMatchObject({
              networkConfiguration: {
                assignPublicIp: false,
                subnets: ["subnet-private-1", "subnet-private-2"],
                securityGroups: ["sg-1"],
              },
            });
            expect(resource("MyServiceLoadBalancer").inputs.subnets).toEqual([
              "subnet-public-1",
              "subnet-public-2",
            ]);
          },
        },
        "a VPC of your own with a Cloud Map namespace": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: customCluster({
                  cloudmapNamespaceId: output("ns-1"),
                  cloudmapNamespaceName: "internal",
                }),
                image: "nginx:latest",
                serviceRegistry: { port: 80 },
              },
              opts,
            );
          },
          check: () =>
            expect(resource("MyServiceCloudmapService").inputs).toMatchObject({
              namespaceId: "ns-1",
            }),
        },
        transforms: (Service, opts) => {
          new Service(
            "MyService",
            {
              cluster: cluster(),
              image: { context: app },
              loadBalancer: { rules: [{ listen: "80/http" }] },
              transform: {
                taskRole: { description: "Runs the service" },
                executionRole: (args, opts) => {
                  args.description = "Starts the service";
                  opts.protect = true;
                },
                taskDefinition: (args) => {
                  args.family = "custom-family";
                },
                logGroup: { kmsKeyId: "key-1" },
                image: (args: any) => {
                  args.noCache = true;
                  return undefined;
                },
                service: (args) => {
                  args.enableExecuteCommand = false;
                },
                loadBalancer: { idleTimeout: 120 },
                loadBalancerSecurityGroup: { description: "Mine" },
                listener: (args: any) => {
                  args.sslPolicy = "ELBSecurityPolicy-TLS13-1-2-2021-06";
                  return undefined;
                },
                target: { deregistrationDelay: 10 },
                autoScalingTarget: (args, opts) => {
                  opts.ignoreChanges = ["minCapacity"];
                },
              },
            },
            opts,
          );
        },
        "a transform of the rules on a load balancer it shares": (
          Service,
          opts,
        ) => {
          new Service(
            "MyService",
            {
              cluster: customCluster(),
              image: "nginx:latest",
              loadBalancer: {
                instance: alb(),
                rules: [
                  {
                    listen: "80/http",
                    forward: "8080/http",
                    conditions: { path: "/api/*" },
                    priority: 100,
                  },
                ],
              },
              transform: { listenerRule: { tags: { team: "api" } } },
            },
            opts,
          );
        },
        "roles you already have": {
          original: (opts) =>
            new OriginalService(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                taskRole: "my-task-role",
                executionRole: "my-execution-role",
              },
              opts,
            ),
          v5: (opts) =>
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                existing: {
                  taskRole: "my-task-role",
                  executionRole: "my-execution-role",
                },
              },
              opts,
            ),
          check: () => {
            expect(resource("MyServiceTaskRole")).toMatchObject({
              kind: "read",
              options: { id: "my-task-role" },
            });
            expect(resource("MyServiceTaskDefinition").inputs).toMatchObject({
              taskRoleArn: "arn:aws:iam::123456789012:role/my-task-role",
              executionRoleArn:
                "arn:aws:iam::123456789012:role/my-execution-role",
            });
          },
        },
        // What the 4.x Service deprecated, written the way it's written now
        "a public endpoint, its ports and a rule's path": {
          original: (opts) =>
            new OriginalService(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                public: {
                  ports: [
                    { listen: "80/http", forward: "8080/http" },
                    { listen: "80/http", path: "/api/*" },
                  ],
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  rules: [
                    { listen: "80/http", forward: "8080/http" },
                    { listen: "80/http", conditions: { path: "/api/*" } },
                  ],
                },
              },
              opts,
            ),
        },
        // What the 4.x Service takes as an output and the V5 one doesn't
        "a load balancer and scaling given as outputs": {
          original: (opts) =>
            new OriginalService(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: output({
                  domain: output({
                    name: output("example.com"),
                    aliases: output(["www.example.com"]),
                  }),
                  public: output(false),
                  rules: output([
                    {
                      listen: output("443/https" as const),
                      forward: output("8080/http" as const),
                      conditions: output({ path: output("/api/*") }),
                    },
                    { listen: "443/https" as const },
                  ]),
                  health: output({ "8080/http": output({ path: "/up" }) }),
                }),
                scaling: output({
                  min: output(2),
                  max: 4,
                  cpuUtilization: output(false as const),
                  requestCount: output(100),
                }),
              },
              opts,
            ),
          v5: (opts) =>
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: {
                  domain: {
                    name: output("example.com"),
                    aliases: ["www.example.com"],
                  },
                  public: output(false),
                  rules: [
                    {
                      listen: "443/https",
                      forward: "8080/http",
                      conditions: { path: "/api/*" },
                    },
                    { listen: "443/https" },
                  ],
                  health: { "8080/http": output({ path: "/up" }) },
                },
                scaling: {
                  min: output(2),
                  max: 4,
                  cpuUtilization: false,
                  requestCount: 100,
                },
              },
              opts,
            ),
        },
        // V5 merges an object transform into the defaults. 4.x replaced a
        // nested object whole, which dropped half of the circuit breaker here.
        "an object transform that sets part of the circuit breaker": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                transform: {
                  // Half of it isn't something the 4.x type allows
                  service: {
                    deploymentCircuitBreaker: { rollback: false },
                  } as any,
                },
              },
              opts,
            );
          },
          changed: [["MyServiceService", ["deploymentCircuitBreaker"]]],
          check: () =>
            expect(
              resource("MyServiceService").inputs.deploymentCircuitBreaker,
            ).toEqual({ enable: true, rollback: false }),
        },
      },
    });

    // What something that uses the service reads has to come out the same,
    // wherever the service is and however it's reached
    const placements: Record<string, (Service: ServiceClass) => any> = {
      "in an SST VPC": (Service) =>
        new Service("MyService", { cluster: cluster(), image: "nginx:latest" }),
      "behind a load balancer": (Service) =>
        new Service("MyService", {
          cluster: cluster(),
          image: "nginx:latest",
          loadBalancer: { rules: [{ listen: "80/http" }] },
        }),
      "behind a load balancer with a domain": (Service) =>
        new Service("MyService", {
          cluster: cluster(),
          image: "nginx:latest",
          loadBalancer: {
            domain: { name: "example.com", dns: false, cert: CERT_ARN },
            rules: [{ listen: "443/https", forward: "80/http" }],
          },
        }),
      "behind a load balancer it shares": (Service) =>
        new Service("MyService", {
          cluster: customCluster({
            cloudmapNamespaceId: "ns-1",
            cloudmapNamespaceName: "internal",
          }),
          image: "nginx:latest",
          loadBalancer: {
            instance: alb(),
            rules: [
              {
                listen: "80/http",
                forward: "8080/http",
                conditions: { path: "/api/*" },
                priority: 100,
              },
            ],
          },
        }),
      "in a VPC of your own with a Cloud Map namespace": (Service) =>
        new Service("MyService", {
          cluster: customCluster({
            cloudmapNamespaceId: "ns-1",
            cloudmapNamespaceName: "internal",
          }),
          image: "nginx:latest",
        }),
    };

    for (const dev of [false, true])
      for (const [name, create] of Object.entries(placements)) {
        it(`is reached the same way ${name}${
          dev ? ", in sst dev" : ""
        }`, async () => {
          const read = async (Service: ServiceClass) => {
            pulumi.reset();
            // @ts-ignore
            global.$dev = dev;
            const service = create(Service);
            await pulumi.settle();
            // Reading the URL fails for a service with no load balancer
            const url = () => {
              try {
                return service.url;
              } catch (error: any) {
                return error.message as string;
              }
            };
            return pulumi.resolve({
              url: url(),
              service: service.service,
              link: service.getSSTLink().properties,
              role: service.nodes.taskRole.arn,
              dev: devCommands(),
            });
          };

          const original = await read(OriginalService);
          expect(await read(Service)).toEqual(original);
          expect(original.service).toMatch(dev ? /^dev\./ : /^MyService\./);
          expect(original.dev.MyService.aws.role).toBe(original.role);
        });
      }

    // With no image settings the Dockerfile at the root of the app is built
    it("a service with no image settings", async () => {
      // @ts-ignore
      const paths = global.$cli.paths;
      const root = paths.root;
      paths.root = app;
      try {
        const create = (Service: ServiceClass) => () =>
          new Service("MyService", { cluster: cluster() });

        const result = await pulumi.takesOver(
          create(OriginalService),
          create(Service),
        );
        expect(result.changed).toEqual([]);
        expect(result.unclaimed).toEqual([`${DEV_COMMAND}::MyServiceDev`]);
        expect(resource("MyServiceImageMyService").inputs).toMatchObject({
          context: { location: app },
          dockerfile: { location: path.join(app, "Dockerfile") },
        });
        expect(devCommands().MyService.directory).toBe(".");
      } finally {
        paths.root = root;
      }
    });

    // The task definition and the certificate are named after their parts,
    // and what's named after a container or a protocol is named the way a
    // name is written
    it("keeps what it renames", async () => {
      const create = (Service: ServiceClass) =>
        new Service("MyService", {
          cluster: cluster(),
          containers: [
            { name: "app", image: { context: app } },
            { name: "admin-panel", image: { context: admin } },
          ],
          loadBalancer: {
            domain: "example.com",
            rules: [
              { listen: "53/tcp_udp", container: "admin-panel" },
              { listen: "443/tls", forward: "8443/tcp", container: "app" },
            ],
          },
        });
      const own = () =>
        pulumi.resources
          .filter((r) => r.parent.endsWith("::MyService"))
          .map((r) => r.name)
          // Not what the DNS adapter creates, or the dev commands
          .filter((name) => !/Record|ZoneLookup|Dev/.test(name))
          .sort();

      create(OriginalService);
      await pulumi.settle();
      const original = pulumi.graph();
      expect(own()).toEqual([
        "MyServiceAutoScalingCpuPolicy",
        "MyServiceAutoScalingMemoryPolicy",
        "MyServiceAutoScalingTarget",
        "MyServiceCloudmapService",
        "MyServiceExecutionRole",
        "MyServiceImageadmin-panel",
        "MyServiceImageapp",
        "MyServiceListenerTCP_UDP53",
        "MyServiceListenerTLS443",
        "MyServiceLoadBalancer",
        "MyServiceLoadBalancerSecurityGroup",
        "MyServiceLogGroupadmin-panel",
        "MyServiceLogGroupapp",
        "MyServiceService",
        "MyServiceSsl",
        "MyServiceTargetadmin-panelTCP_UDP53",
        "MyServiceTargetappTCP8443",
        "MyServiceTask",
        "MyServiceTaskRole",
      ]);

      pulumi.reset();
      create(Service);
      await pulumi.settle();
      expect(own()).toEqual([
        "MyServiceAutoScalingCpuPolicy",
        "MyServiceAutoScalingMemoryPolicy",
        "MyServiceAutoScalingTarget",
        "MyServiceCertificate",
        "MyServiceCloudmapService",
        "MyServiceExecutionRole",
        "MyServiceImageAdminpanel",
        "MyServiceImageApp",
        "MyServiceListenerTCPUDP53",
        "MyServiceListenerTLS443",
        "MyServiceLoadBalancer",
        "MyServiceLoadBalancerSecurityGroup",
        "MyServiceLogGroupAdminpanel",
        "MyServiceLogGroupApp",
        "MyServiceService",
        "MyServiceTargetAdminpanelTCPUDP53",
        "MyServiceTargetAppTCP8443",
        "MyServiceTaskDefinition",
        "MyServiceTaskRole",
      ]);
      const result = pulumi.takeover(original);
      expect(result.changed).toEqual([]);
      expect(result.unclaimed.sort()).toEqual([
        `${DEV_COMMAND}::MyServiceadmin-panelDev`,
        `${DEV_COMMAND}::MyServiceappDev`,
      ]);
    });
  });

  describe("in sst dev", () => {
    beforeEach(() => {
      // @ts-ignore
      global.$dev = true;
    });

    pulumi.takeoverCases({
      original: () => OriginalService,
      v5: () => Service,
      unclaimed: [`${DEV_COMMAND}::MyServiceDev`],
      cases: {
        "a service with a command to run": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: { context: app },
                loadBalancer: { rules: [{ listen: "80/http" }] },
                link: [new Bucket("MyBucket")],
                dev: { command: "node dev.js", url: "http://localhost:3000" },
              },
              opts,
            );
          },
          // The role alone: the service runs on the user's machine
          check: () =>
            expect(named("MyService")).toEqual([
              "MyService",
              "MyServiceDevCommandMyService",
              "MyServiceTaskRole",
            ]),
        },
        "a service that's deployed all the same": {
          create: (Service, opts) => {
            new Service(
              "MyService",
              {
                cluster: cluster(),
                image: "nginx:latest",
                loadBalancer: { rules: [{ listen: "80/http" }] },
                dev: false,
              },
              opts,
            );
          },
          check: () => expect(resource("MyServiceService").type).toBe(SERVICE),
        },
      },
    });

    it("runs each container's command in place of the service", async () => {
      const create = (Service: ServiceClass) =>
        new Service("MyService", {
          cluster: cluster(),
          containers: [
            {
              name: "app",
              image: { context: app },
              environment: { ROLE: "app" },
              dev: { command: "node app.js" },
            },
            {
              name: "admin-panel",
              image: "nginx:latest",
              environment: output({ ROLE: output("admin") }),
              dev: {
                command: output("node admin.js"),
                autostart: output(false),
                directory: "packages/admin",
              },
            },
          ],
          link: [new Bucket("MyBucket")],
        });

      create(OriginalService);
      await pulumi.settle();
      const original = devCommands();

      pulumi.reset();
      const service = create(Service) as InstanceType<typeof Service>;
      await pulumi.settle();
      expect(devCommands()).toEqual(original);
      expect(devCommands()).toEqual({
        MyServiceapp: {
          title: "MyServiceapp",
          command: "node app.js",
          autostart: true,
          directory: app,
          links: ["MyBucket"],
          environment: { ROLE: "app", AWS_REGION: "us-east-1" },
          aws: { role: mockArn("MyServiceTaskRole") },
        },
        "MyServiceadmin-panel": {
          title: "MyServiceadmin-panel",
          command: "node admin.js",
          autostart: false,
          directory: "packages/admin",
          links: ["MyBucket"],
          environment: { ROLE: "admin", AWS_REGION: "us-east-1" },
          aws: { role: mockArn("MyServiceTaskRole") },
        },
      });

      // Nothing is built or deployed but the role the commands run as, which
      // the account can assume
      expect(named("MyService")).toEqual([
        "MyService",
        "MyServiceDevCommandAdminpanel",
        "MyServiceDevCommandApp",
        "MyServiceTaskRole",
      ]);
      expect(
        resource("MyServiceTaskRole").inputs.assumeRolePolicy,
      ).toMatchObject({
        Statement: [
          {
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
              AWS: "123456789012",
            },
          },
        ],
      });
      expect(service.nodes.taskRole.urn).toBeDefined();
      expect(Object.keys(service.nodes.devCommand).sort()).toEqual([
        "admin-panel",
        "app",
      ]);
      expect(() => service.nodes.service).toThrow(
        /Cannot access `nodes.service` of "MyService" in `sst dev`. It runs locally there/,
      );
      expect(() => service.nodes.cloudmapService).toThrow(/in `sst dev`/);
      expect(() => service.nodes.listener).toThrow(/in `sst dev`/);
      expect(pulumi.outputsOf("MyService")).toEqual({});
    });

    it("has a placeholder for the URL of a load balancer", async () => {
      const service = new Service("MyService", {
        cluster: cluster(),
        image: "nginx:latest",
        loadBalancer: { rules: [{ listen: "80/http" }] },
      });
      await pulumi.settle();

      expect(await pulumi.resolve(service.url)).toBe(
        "http://url-unavailable-in-dev.mode",
      );
      expect(
        await pulumi.resolve((service as any).getSSTLink().properties),
      ).toEqual({
        url: "http://url-unavailable-in-dev.mode",
        service: "dev.sst",
      });
    });

    it("has no URL without a load balancer", async () => {
      const service = new Service("MyService", {
        cluster: cluster(),
        image: "nginx:latest",
        dev: { url: "http://localhost:3000" },
      });
      await pulumi.settle();

      expect(() => service.url).toThrow(/no public ports are exposed/);
    });

    it("checks the load balancer it isn't deploying", () => {
      expect(
        () =>
          new Service("MyService", {
            cluster: cluster(),
            image: "nginx:latest",
            loadBalancer: { rules: [{ listen: "443/https" }] },
          }),
      ).toThrow(/You must provide a custom domain for HTTPS protocol/);
    });
  });

  it("runs one container named after the service by default", async () => {
    const service = new Service("MyService", {
      cluster: cluster(),
      image: "nginx:latest",
    });
    await pulumi.settle();

    expect(named("MyService")).toEqual([
      "MyService",
      "MyServiceAutoScalingCpuPolicy",
      "MyServiceAutoScalingMemoryPolicy",
      "MyServiceAutoScalingTarget",
      "MyServiceCloudmapService",
      "MyServiceDevCommandMyService",
      "MyServiceExecutionRole",
      "MyServiceLogGroupMyService",
      "MyServiceService",
      "MyServiceTaskDefinition",
      "MyServiceTaskRole",
    ]);
    expect(definitions()).toMatchObject([
      { name: "MyService", image: "nginx:latest" },
    ]);
    expect(resource("MyServiceService").inputs).toEqual({
      name: "MyService",
      cluster: mockArn("MyClusterCluster"),
      taskDefinition: mockArn("MyServiceTaskDefinition"),
      desiredCount: 1,
      launchType: "FARGATE",
      networkConfiguration: {
        assignPublicIp: true,
        subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
        securityGroups: ["MyVpcSecurityGroup_id"],
      },
      deploymentCircuitBreaker: { enable: true, rollback: true },
      loadBalancers: [],
      enableExecuteCommand: true,
      serviceRegistries: { registryArn: mockArn("MyServiceCloudmapService") },
      waitForSteadyState: false,
    });
    expect(resource("MyServiceCloudmapService").inputs).toEqual({
      name: "MyService.test.app",
      namespaceId: "MyVpcCloudmapNamespace_id",
      forceDestroy: true,
      dnsConfig: {
        namespaceId: "MyVpcCloudmapNamespace_id",
        dnsRecords: [{ ttl: 60, type: "A" }],
      },
    });
    expect(resource("MyServiceAutoScalingTarget").inputs).toMatchObject({
      resourceId: expect.stringMatching(/^service\/.+\/MyService$/),
      minCapacity: 1,
      maxCapacity: 1,
    });
    expect(
      resource("MyServiceAutoScalingCpuPolicy").inputs
        .targetTrackingScalingPolicyConfiguration,
    ).toEqual({
      predefinedMetricSpecification: {
        predefinedMetricType: "ECSServiceAverageCPUUtilization",
      },
      targetValue: 70,
    });

    // The resources, and the Cloud Map service as an output of it
    expect(service.nodes.service.urn).toBeDefined();
    expect(service.nodes.taskDefinition.urn).toBeDefined();
    expect(service.nodes.loadBalancer).toBe(undefined);
    expect(service.nodes.autoScalingRequestCountPolicy).toBe(undefined);
    expect(await pulumi.resolve(service.nodes.cloudmapService.arn)).toBe(
      mockArn("MyServiceCloudmapService"),
    );
    expect(() => service.url).toThrow(/no public ports are exposed/);
    expect(await pulumi.resolve(service.service)).toBe(
      "MyService.test.app.sst",
    );
    expect(
      await pulumi.resolve((service as any).getSSTLink().properties),
    ).toEqual({ service: "MyService.test.app.sst" });
    expect(pulumi.outputsOf("MyService")).toEqual({});
  });

  it("listens, forwards and redirects with a load balancer of its own", async () => {
    const service = new Service("MyService", {
      cluster: cluster(),
      containers: [
        { name: "app", image: "nginx:latest" },
        { name: "admin", image: "nginx:latest" },
      ],
      loadBalancer: {
        domain: { name: "example.com", dns: false, cert: CERT_ARN },
        rules: [
          { listen: "80/http", redirect: "443/https" },
          { listen: "443/https", forward: "8080/http", container: "app" },
          {
            listen: "443/https",
            forward: "8080/http",
            container: "app",
            conditions: { path: "/api/*" },
          },
          {
            listen: "443/https",
            forward: "9000/http",
            container: "admin",
            conditions: { path: "/admin/*" },
          },
        ],
        health: { "9000/http": { path: "/up" } },
      },
      transform: {
        target: (args, _opts, _name, id) => {
          args.tags = { target: id };
        },
        listener: (args, _opts, _name, id) => {
          args.tags = { listener: id };
        },
        listenerRule: (args, _opts, _name, id) => {
          args.tags = { rule: id };
        },
      },
    });
    await pulumi.settle();

    // A target group for each container port, a listener for each port, and
    // a listener rule for each rule with conditions
    expect(Object.keys(service.nodes.target)).toEqual([
      "appHTTP8080",
      "adminHTTP9000",
    ]);
    expect(Object.keys(service.nodes.listener)).toEqual(["HTTP80", "HTTPS443"]);
    const rules = Object.keys(service.nodes.listenerRule);
    expect(rules).toEqual([
      expect.stringMatching(/^HTTPS443Rule[a-z]{4}$/),
      expect.stringMatching(/^HTTPS443Rule[a-z]{4}$/),
    ]);

    expect(resource("MyServiceLoadBalancer").inputs).toMatchObject({
      internal: false,
      loadBalancerType: "application",
      subnets: ["MyVpcPublicSubnet1_id", "MyVpcPublicSubnet2_id"],
      securityGroups: ["MyServiceLoadBalancerSecurityGroup_id"],
      enableCrossZoneLoadBalancing: true,
    });
    expect(resource("MyServiceTargetAppHTTP8080").inputs).toEqual({
      namePrefix: "HTTP",
      port: 8080,
      protocol: "HTTP",
      targetType: "ip",
      vpcId: "MyVpcVpc_id",
      tags: { target: "appHTTP8080" },
    });
    expect(resource("MyServiceTargetAdminHTTP9000").inputs.healthCheck).toEqual(
      {
        path: "/up",
        interval: 30,
        timeout: 5,
        healthyThreshold: 5,
        unhealthyThreshold: 2,
        matcher: "200",
      },
    );
    expect(resource("MyServiceListenerHTTP80").inputs).toMatchObject({
      port: 80,
      protocol: "HTTP",
      defaultActions: [
        {
          type: "redirect",
          redirect: { port: "443", protocol: "HTTPS", statusCode: "HTTP_301" },
        },
      ],
      tags: { listener: "HTTP80" },
    });
    expect(resource("MyServiceListenerHTTPS443").inputs).toMatchObject({
      certificateArn: CERT_ARN,
      defaultActions: [
        {
          type: "forward",
          targetGroupArn: expect.stringContaining(
            "/MyServiceTargetAppHTTP8080/",
          ),
        },
      ],
    });
    const rule = pulumi.resources.find(
      (r) => r.inputs.tags?.rule === rules[1],
    )!;
    expect(rule.name).toBe(`MyServiceListenerRule${rules[1]}`);
    expect(rule.inputs).toMatchObject({
      listenerArn: mockArn("MyServiceListenerHTTPS443"),
      actions: [
        {
          type: "forward",
          targetGroupArn: expect.stringContaining(
            "/MyServiceTargetAdminHTTP9000/",
          ),
        },
      ],
      conditions: [{ pathPattern: { values: ["/admin/*"] } }],
    });
    // The service registers each target once
    expect(resource("MyServiceService").inputs.loadBalancers).toEqual([
      {
        targetGroupArn: expect.stringContaining("/MyServiceTargetAppHTTP8080/"),
        containerName: "app",
        containerPort: 8080,
      },
      {
        targetGroupArn: expect.stringContaining(
          "/MyServiceTargetAdminHTTP9000/",
        ),
        containerName: "admin",
        containerPort: 9000,
      },
    ]);

    expect(await pulumi.resolve(service.url)).toBe("https://example.com/");
    expect(pulumi.outputsOf("MyService")).toEqual({
      _hint: "https://example.com/",
    });
    expect(
      await pulumi.resolve((service as any).getSSTLink().properties),
    ).toEqual({
      url: "https://example.com/",
      service: "MyService.test.app.sst",
    });
  });

  // A target group has to be on a load balancer before a service can use it
  it("waits for what sends traffic to its targets", async () => {
    new Service("MyService", {
      cluster: cluster(),
      image: "nginx:latest",
      loadBalancer: {
        rules: [
          { listen: "80/http" },
          {
            listen: "80/http",
            forward: "8080/http",
            conditions: { path: "/api/*" },
          },
        ],
      },
    });
    await pulumi.settle();

    const waitsFor = resource("MyServiceService").options.dependencies.map(
      (urn: string) => urn.split("::").pop(),
    );
    expect(waitsFor).toContain("MyServiceListenerHTTP80");
    expect(waitsFor).toContainEqual(
      expect.stringMatching(/^MyServiceListenerRuleHTTP80Rule/),
    );
  });

  it("answers what matches no rule with a 403", async () => {
    new Service("MyService", {
      cluster: cluster(),
      image: "nginx:latest",
      loadBalancer: {
        rules: [{ listen: "80/http", conditions: { path: "/api/*" } }],
      },
    });
    await pulumi.settle();

    expect(resource("MyServiceListenerHTTP80").inputs.defaultActions).toEqual([
      {
        type: "fixed-response",
        fixedResponse: {
          statusCode: "403",
          contentType: "text/plain",
          messageBody: "Forbidden",
        },
      },
    ]);
  });

  it("puts a private load balancer in the private subnets", async () => {
    new Service("MyService", {
      cluster: cluster(),
      image: "nginx:latest",
      loadBalancer: { public: false, rules: [{ listen: "80/http" }] },
    });
    await pulumi.settle();

    expect(resource("MyServiceLoadBalancer").inputs).toMatchObject({
      internal: true,
      subnets: ["MyVpcPrivateSubnet1_id", "MyVpcPrivateSubnet2_id"],
    });
  });

  it("adds its targets and rules to a load balancer it shares", async () => {
    const service = new Service("MyService", {
      cluster: customCluster(),
      image: "nginx:latest",
      loadBalancer: {
        instance: alb(),
        rules: [
          {
            listen: "80/http",
            forward: "8080/http",
            conditions: { path: "/api/*" },
            priority: 100,
          },
          {
            listen: "8080/http",
            forward: "8080/http",
            conditions: { path: "/v2/*" },
            priority: 5,
          },
        ],
      },
      scaling: { requestCount: 500 },
    });
    await pulumi.settle();

    expect(Object.keys(service.nodes.target)).toEqual(["MyServiceHTTP8080"]);
    expect(Object.keys(service.nodes.listenerRule)).toEqual([
      "HTTP80P100",
      "HTTP8080P5",
    ]);
    expect(service.nodes.loadBalancer).toBe(undefined);
    expect(named("MyServiceLoadBalancer")).toEqual([]);
    expect(resource("MyServiceTargetMyServiceHTTP8080").inputs).toMatchObject({
      vpcId: "vpc-1",
      healthCheck: {
        path: "/",
        interval: 30,
        timeout: 5,
        healthyThreshold: 5,
        unhealthyThreshold: 2,
        matcher: "200",
      },
    });
    expect(resource("MyServiceListenerRuleHTTP80P100").inputs).toMatchObject({
      listenerArn: mockArn("MyAlbListenerHTTP80"),
      priority: 100,
      conditions: [{ pathPattern: { values: ["/api/*"] } }],
    });
    expect(resource("MyServiceService").inputs.loadBalancers).toEqual([
      {
        targetGroupArn: expect.stringContaining(
          "/MyServiceTargetMyServiceHTTP8080/",
        ),
        containerName: "MyService",
        containerPort: 8080,
      },
    ]);
    expect(
      resource("MyServiceAutoScalingRequestCountPolicy").inputs
        .targetTrackingScalingPolicyConfiguration,
    ).toEqual({
      predefinedMetricSpecification: {
        predefinedMetricType: "ALBRequestCountPerTarget",
        resourceLabel:
          "app/MyAlbLoadBalancer/50dc6c495c0c9188/targetgroup/MyServiceTargetMyServiceHTTP8080/73e2d6bc24d8a067",
      },
      targetValue: 500,
    });
    expect(await pulumi.resolve(service.url)).toBe(
      "http://MyAlbLoadBalancer.us-east-1.elb.amazonaws.com",
    );
  });

  it("has no Cloud Map service in a VPC without a namespace", async () => {
    const service = new Service("MyService", {
      cluster: customCluster(),
      image: "nginx:latest",
    });
    await pulumi.settle();

    expect(named("MyServiceCloudmap")).toEqual([]);
    expect(resource("MyServiceService").inputs.serviceRegistries).toBe(
      undefined,
    );
    expect(
      await pulumi.resolve((service as any).getSSTLink().properties),
    ).toEqual({});
  });

  it("registers in the Cloud Map namespace of a VPC of your own", async () => {
    const service = new Service("MyService", {
      cluster: customCluster({
        cloudmapNamespaceId: "ns-1",
        cloudmapNamespaceName: "internal",
      }),
      image: "nginx:latest",
      serviceRegistry: { port: 8080 },
      transform: { cloudmapService: { description: "Mine" } },
    });
    await pulumi.settle();

    expect(resource("MyServiceCloudmapService").inputs).toMatchObject({
      namespaceId: "ns-1",
      description: "Mine",
      dnsConfig: {
        dnsRecords: [
          { ttl: 60, type: "SRV" },
          { ttl: 60, type: "A" },
        ],
      },
    });
    expect(resource("MyServiceService").inputs.serviceRegistries).toEqual({
      registryArn: mockArn("MyServiceCloudmapService"),
      port: 8080,
    });
    expect(await pulumi.resolve(service.nodes.cloudmapService.arn)).toBe(
      mockArn("MyServiceCloudmapService"),
    );
    expect(await pulumi.resolve(service.service)).toBe(
      "MyService.test.app.internal",
    );
  });

  it("uses a Cloud Map service you already have", async () => {
    const service = new Service("MyService", {
      cluster: cluster(),
      image: "nginx:latest",
      existing: { cloudmapService: "srv-1" },
    });
    await pulumi.settle();

    expect(resource("MyServiceCloudmapService")).toMatchObject({
      kind: "read",
      options: { id: "srv-1" },
    });
    expect(await pulumi.resolve(service.nodes.cloudmapService.id)).toBe(
      "srv-1",
    );
  });

  describe("what it's given", () => {
    const create = (args: object) => () =>
      new Service("MyService", {
        cluster: cluster(),
        image: "nginx:latest",
        ...args,
      } as any);
    const balanced = (loadBalancer: object, args: object = {}) =>
      create({ loadBalancer, ...args });
    const shared = (rule: object, args: object = {}) =>
      create({
        cluster: customCluster(),
        loadBalancer: {
          instance: alb(),
          rules: [
            {
              listen: "80/http",
              forward: "8080/http",
              conditions: { path: "/api/*" },
              priority: 100,
              ...rule,
            },
          ],
        },
        ...args,
      });

    it("points taskRole and executionRole at existing", () => {
      expect(create({ taskRole: "my-task-role" })).toThrow(
        /"taskRole" isn't an option here. Pass the role, or its name, as "existing: { taskRole }" in the "MyService" service/,
      );
      expect(create({ executionRole: "my-execution-role" })).toThrow(
        /as "existing: { executionRole }" in the "MyService" service/,
      );
    });

    it("points what the 4.x Service deprecated at what replaced it", () => {
      expect(create({ public: { rules: [{ listen: "80/http" }] } })).toThrow(
        /"public" isn't an option here. It's "loadBalancer" now/,
      );
      expect(balanced({ ports: [{ listen: "80/http" }] })).toThrow(
        /"ports" isn't an option here. It's "rules" now/,
      );
      expect(
        balanced({ rules: [{ listen: "80/http", path: "/api/*" }] }),
      ).toThrow(/"path" isn't an option here. It's "conditions: { path }" now/);
    });

    it("takes an image you already have as the container's image", () => {
      expect(
        create({ existing: { image: { MyService: "my-image" } } }),
      ).toThrow(
        /Set the "image" of the container to the image's reference in the "MyService" service/,
      );
    });

    it("can't have both containers and a top-level health check", () => {
      expect(
        create({
          image: undefined,
          health: { command: ["CMD", "true"] },
          containers: [{ name: "app", image: "nginx:latest" }],
        }),
      ).toThrow(/You cannot provide both "containers" and "image".*"health"/);
    });

    it("rejects what decides the resources given as an output", () => {
      expect(create({ containers: output([{ name: "app" }]) })).toThrow(
        /The "containers" of the "MyService" service has to be a plain value/,
      );
      expect(create({ loadBalancer: output({ rules: [] }) })).toThrow(
        /The "loadBalancer" of the "MyService" service has to be a plain value/,
      );
      expect(balanced({ rules: output([{ listen: "80/http" }]) })).toThrow(
        /The "rules" of the load balancer of the "MyService" service has to be a plain value/,
      );
      expect(balanced({ rules: [{ listen: output("80/http") }] })).toThrow(
        /Rule 1 of the load balancer of the "MyService" service has to be a plain value/,
      );
      expect(
        balanced({
          rules: [
            { listen: "80/http" },
            { listen: "80/http", conditions: { path: output("/api/*") } },
          ],
        }),
      ).toThrow(/Rule 2 of the load balancer of the "MyService" service/);
      expect(
        balanced({
          domain: output("example.com"),
          rules: [{ listen: "80/http" }],
        }),
      ).toThrow(/The "domain" of the load balancer of the "MyService" service/);
      expect(
        balanced({
          domain: { name: "example.com", aliases: output(["a.example.com"]) },
          rules: [{ listen: "80/http" }],
        }),
      ).toThrow(
        /The domain's "aliases" in the load balancer of the "MyService"/,
      );
      expect(create({ scaling: output({ max: 2 }) })).toThrow(
        /The "scaling" of the "MyService" service has to be a plain value/,
      );
      expect(create({ scaling: { cpuUtilization: output(50) } })).toThrow(
        /The "scaling.cpuUtilization" of the "MyService" service/,
      );
      expect(create({ dev: output(false) })).toThrow(
        /The "dev" of the "MyService" service has to be a plain value/,
      );
    });

    it("needs rules for a load balancer", () => {
      expect(balanced({})).toThrow(/You must provide the ports to expose/);
      expect(balanced({ rules: [] })).toThrow(
        /You must provide the ports to expose via "loadBalancer.rules"/,
      );
    });

    it("needs a rule to name its container when there are several", () => {
      const containers = [
        { name: "app", image: "nginx:latest" },
        { name: "admin", image: "nginx:latest" },
      ];
      expect(
        balanced(
          { rules: [{ listen: "80/http" }] },
          { image: undefined, containers },
        ),
      ).toThrow(
        /Rule 1 of the load balancer of the "MyService" service has to name the "container" it forwards to. There's more than one: app, admin/,
      );
      // A redirect goes to no container
      expect(
        balanced(
          {
            domain: { name: "example.com", dns: false, cert: CERT_ARN },
            rules: [
              { listen: "80/http", redirect: "443/https" },
              { listen: "443/https", container: "app" },
            ],
          },
          { image: undefined, containers },
        ),
      ).not.toThrow();
    });

    it("rejects a rule for a container the service doesn't have", () => {
      expect(
        balanced({ rules: [{ listen: "80/http", container: "web" }] }),
      ).toThrow(
        /Rule 1 of the load balancer of the "MyService" service forwards to the container "web", which isn't one of the service's: MyService/,
      );
    });

    it("keeps to one kind of protocol", () => {
      expect(
        balanced({ rules: [{ listen: "80/http" }, { listen: "53/udp" }] }),
      ).toThrow(/Protocols must be either all http\/https, or all tcp/);
      expect(
        balanced({ rules: [{ listen: "80/http", forward: "80/tcp" }] }),
      ).toThrow(
        /The listen protocol "80\/http" must match the forward protocol/,
      );
      expect(
        balanced({ rules: [{ listen: "80/http", redirect: "443/tls" }] }),
      ).toThrow(
        /The listen protocol "80\/http" must match the redirect protocol/,
      );
      expect(
        balanced({
          rules: [{ listen: "80/tcp", conditions: { path: "/api/*" } }],
        }),
      ).toThrow(/Only "http" protocols support conditions/);
    });

    it("needs a domain to listen on https or tls", () => {
      expect(balanced({ rules: [{ listen: "443/https" }] })).toThrow(
        /You must provide a custom domain for HTTPS protocol/,
      );
      expect(balanced({ rules: [{ listen: "443/tls" }] })).toThrow(
        /You must provide a custom domain for TLS protocol/,
      );
      expect(
        balanced({
          domain: { name: "example.com", dns: false },
          rules: [{ listen: "443/https" }],
        }),
      ).toThrow(/"cert" is required when "dns" is disabled/);
    });

    it("checks a health check is for a port traffic is forwarded to", () => {
      expect(
        balanced({
          rules: [{ listen: "80/http", forward: "8080/http" }],
          health: { "80/http": { path: "/up" } },
        }),
      ).toThrow(/Cannot configure health check for "80\/http"/);
    });

    it("scales on requests only behind an application load balancer", () => {
      expect(create({ scaling: { requestCount: 100 } })).toThrow(
        /Request count scaling is only supported for http\/https protocols/,
      );
      expect(
        balanced(
          { rules: [{ listen: "80/tcp" }] },
          { scaling: { requestCount: 100 } },
        ),
      ).toThrow(/Request count scaling is only supported/);
      // There's no target to count the requests of
      expect(
        balanced(
          { rules: [{ listen: "80/http", redirect: "8080/http" }] },
          { scaling: { requestCount: 100 } },
        ),
      ).toThrow(
        /"scaling.requestCount" needs a rule that forwards to a container/,
      );
    });

    it("checks the rules on a load balancer it shares", () => {
      expect(
        create({
          cluster: customCluster(),
          loadBalancer: { instance: alb(), rules: [] },
        }),
      ).toThrow(/You must provide at least one rule in "loadBalancer.rules"/);
      expect(shared({ priority: 0 })).toThrow(
        /Priority 0 must be between 1 and 50000 in Service "MyService"/,
      );
      expect(shared({ conditions: {} })).toThrow(
        /At least one condition \(path, query, or header\) must be set/,
      );
      expect(shared({ container: "web" })).toThrow(
        /forwards to the container "web", which isn't one of the service's/,
      );
      expect(
        create({
          cluster: customCluster(),
          loadBalancer: {
            instance: alb(),
            rules: [1, 2].map(() => ({
              listen: "80/http",
              forward: "8080/http",
              conditions: { path: "/api/*" },
              priority: 100,
            })),
          },
        }),
      ).toThrow(/Duplicate priority 100 on listener "80\/http"/);
      expect(
        create({
          loadBalancer: { instance: {}, rules: [{ listen: "80/http" }] },
        }),
      ).toThrow(
        /The "loadBalancer.instance" of the "MyService" service has to be an "Alb"/,
      );
    });
  });
});
