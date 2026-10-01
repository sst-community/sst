import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const LOAD_BALANCER = "aws:lb/loadBalancer:LoadBalancer";
const LISTENER = "aws:lb/listener:Listener";
const SECURITY_GROUP = "aws:ec2/securityGroup:SecurityGroup";
const ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shared/1";
const CERT_ARN = "arn:aws:acm:us-east-1:123456789012:certificate/abc";
const mockArn = (name: string) => `arn:aws:mock:us-east-1:123456789012:${name}`;

const pulumi = mockPulumi({
  state: (args) => {
    // A load balancer that's looked up
    if (args.type === LOAD_BALANCER && args.id)
      return {
        arn: args.id,
        dnsName: "shared.us-east-1.elb.amazonaws.com",
        zoneId: "Z35SXDOTRQ7X7K",
        vpcId: "vpc-1",
        securityGroups: ["sg-alb", "sg-other"],
      };
    if (args.type === LOAD_BALANCER)
      return {
        dnsName: `${args.name}.us-east-1.elb.amazonaws.com`,
        zoneId: "Z35SXDOTRQ7X7K",
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
    if (args.token === "aws:lb/getListener:getListener")
      return {
        arn: `${args.inputs.loadBalancerArn}/listener/${args.inputs.port}`,
      };
    return undefined;
  },
});

describe("Alb", () => {
  let OriginalAlb: typeof import("../../../src/components/aws/alb").Alb;
  let Alb: typeof import("../../../src/components/aws/v5/alb").Alb;
  let Vpc: typeof import("../../../src/components/aws/vpc").Vpc;
  let Cluster: typeof import("../../../src/components/aws/v5/cluster").Cluster;
  let Service: typeof import("../../../src/components/aws/v5/service").Service;
  let aws: typeof import("@pulumi/aws");

  beforeAll(async () => {
    OriginalAlb = (await import("../../../src/components/aws/alb")).Alb;
    Alb = (await import("../../../src/components/aws/v5/alb")).Alb;
    Vpc = (await import("../../../src/components/aws/vpc")).Vpc;
    Cluster = (await import("../../../src/components/aws/v5/cluster")).Cluster;
    Service = (await import("../../../src/components/aws/v5/service")).Service;
    aws = await import("@pulumi/aws");
    await import("../../../src/components/aws/takeover/alb");
    await import("../../../src/components/aws/takeover/service");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const customVpc = {
    id: "vpc-1",
    publicSubnets: ["subnet-public-1", "subnet-public-2"],
    privateSubnets: ["subnet-private-1", "subnet-private-2"],
  };
  const http = [
    { port: 80, protocol: "http" as const },
    { port: 8080, protocol: "http" as const },
  ];
  const https = [
    { port: 80, protocol: "http" as const },
    { port: 443, protocol: "https" as const },
  ];
  const cluster = () =>
    new Cluster("MyCluster", {
      vpc: {
        id: "vpc-1",
        securityGroups: ["sg-1"],
        containerSubnets: ["subnet-private-1"],
        loadBalancerSubnets: ["subnet-public-1"],
      },
    });
  // Each case deploys the 4.x Alb, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the same
  // inputs, and it has to tell the CLI the same URL.
  describe("takes over a deployed Alb", () => {
    pulumi.takeoverCases({
      original: () => OriginalAlb,
      v5: () => Alb,
      check: () => {
        expect(resource("MyAlbLoadBalancer").type).toBe(LOAD_BALANCER);
        expect(pulumi.outputsOf("MyAlb")).toHaveProperty("_hint");
      },
      cases: {
        "http listeners, in a Vpc": {
          create: (Alb, opts) => {
            new Alb("MyAlb", { vpc: new Vpc("MyVpc"), listeners: http }, opts);
          },
          check: () =>
            expect(pulumi.outputsOf("MyAlb")?._hint).toBe(
              "http://MyAlbLoadBalancer.us-east-1.elb.amazonaws.com",
            ),
        },
        "internal, in a VPC given by its ids": (Alb, opts) => {
          new Alb(
            "MyAlb",
            { vpc: customVpc, public: false, listeners: http },
            opts,
          );
        },
        "the ids and the switch as outputs": (Alb, opts) => {
          new Alb(
            "MyAlb",
            {
              vpc: output({
                ...customVpc,
                publicSubnets: [output("subnet-public-1")],
              }),
              public: output(true),
              listeners: http,
            },
            opts,
          );
        },
        "a domain on Route 53, with https": {
          create: (Alb, opts) => {
            new Alb(
              "MyAlb",
              { vpc: customVpc, domain: "example.com", listeners: https },
              opts,
            );
          },
          check: () => {
            expect(names()).toContain("MyAlbCertificate");
            expect(pulumi.outputsOf("MyAlb")?._hint).toBe(
              "https://example.com/",
            );
          },
        },
        "a domain with aliases": (Alb, opts) => {
          new Alb(
            "MyAlb",
            {
              vpc: customVpc,
              domain: {
                name: "example.com",
                aliases: ["www.example.com", "app.example.com"],
              },
              listeners: https,
            },
            opts,
          );
        },
        "a domain with a certificate of its own": {
          create: (Alb, opts) => {
            new Alb(
              "MyAlb",
              {
                vpc: customVpc,
                domain: { name: "example.com", dns: false, cert: CERT_ARN },
                listeners: https,
              },
              opts,
            );
          },
          check: () => {
            expect(names()).not.toContain("MyAlbCertificate");
            expect(
              resource("MyAlbListenerHTTPS443").inputs.certificateArn,
            ).toBe(CERT_ARN);
          },
        },
        "transform functions": (Alb, opts) => {
          new Alb(
            "MyAlb",
            {
              vpc: customVpc,
              listeners: http,
              transform: {
                loadBalancer: (args: any) => {
                  args.idleTimeout = 120;
                  return undefined;
                },
                securityGroup: (args: any) => {
                  args.description = "Shared";
                  return undefined;
                },
                listener: (args: any) => {
                  args.tags = { team: "platform" };
                  return undefined;
                },
              },
            },
            opts,
          );
        },
        "no listeners": (Alb, opts) => {
          new Alb("MyAlb", { vpc: customVpc, listeners: [] }, opts);
        },
        "one that's referenced by its ARN": {
          create: (Alb, opts) => {
            Alb.get("MyAlb", ALB_ARN, opts);
          },
          check: () => {
            expect(resource("MyAlbLoadBalancer")).toMatchObject({
              kind: "read",
              options: { id: ALB_ARN },
            });
            expect(resource("MyAlbSecurityGroup")).toMatchObject({
              kind: "read",
              options: { id: "sg-alb" },
            });
            expect(pulumi.outputsOf("MyAlb")?._hint).toBe(
              "http://shared.us-east-1.elb.amazonaws.com",
            );
          },
        },
        "with a service on it": {
          create: (Alb, opts) => {
            const alb = new Alb(
              "MyAlb",
              { vpc: customVpc, listeners: http },
              opts,
            );
            new Service("MyService", {
              cluster: cluster(),
              image: "nginx:latest",
              loadBalancer: {
                instance: alb,
                rules: [
                  {
                    listen: "80/http",
                    forward: "8080/http",
                    conditions: { path: "/api/*" },
                    priority: 100,
                  },
                ],
              },
            });
          },
          check: () =>
            expect(
              resource("MyServiceListenerRuleHTTP80P100").inputs.listenerArn,
            ).toBe(mockArn("MyAlbListenerHTTP80")),
        },
        "referenced by its ARN, with a service on it": {
          create: (Alb, opts) => {
            const alb = Alb.get("MyAlb", ALB_ARN, opts);
            new Service("MyService", {
              cluster: cluster(),
              image: "nginx:latest",
              loadBalancer: {
                instance: alb,
                rules: [
                  {
                    listen: "443/https",
                    forward: "8080/http",
                    conditions: { path: "/api/*" },
                    priority: 100,
                  },
                ],
              },
            });
          },
          check: () =>
            // The listener is looked up on the load balancer
            expect(resource("MyAlbListenerHTTPS443")).toMatchObject({
              kind: "read",
              options: { id: `${ALB_ARN}/listener/443` },
            }),
        },
      },
    });
  });

  describe("what it creates", () => {
    it("creates the security group, the load balancer and a listener for each port", async () => {
      const alb = new Alb("MyAlb", { vpc: customVpc, listeners: http });
      await pulumi.settle();

      expect(
        pulumi.resources
          .filter((r) => r.type.startsWith("aws:"))
          .map((r) => r.name),
      ).toEqual([
        "MyAlbSecurityGroup",
        "MyAlbLoadBalancer",
        "MyAlbListenerHTTP80",
        "MyAlbListenerHTTP8080",
      ]);
      expect(resource("MyAlbSecurityGroup").inputs.vpcId).toBe("vpc-1");
      expect(resource("MyAlbLoadBalancer").inputs).toMatchObject({
        internal: false,
        loadBalancerType: "application",
        subnets: customVpc.publicSubnets,
        securityGroups: ["MyAlbSecurityGroup_id"],
        enableCrossZoneLoadBalancing: true,
      });
      expect(resource("MyAlbListenerHTTP8080").inputs).toMatchObject({
        loadBalancerArn: mockArn("MyAlbLoadBalancer"),
        port: 8080,
        protocol: "HTTP",
        defaultActions: [
          {
            type: "fixed-response",
            fixedResponse: { statusCode: "403", messageBody: "Forbidden" },
          },
        ],
      });
      expect(
        resource("MyAlbListenerHTTP8080").inputs.certificateArn,
      ).toBeUndefined();

      expect(await pulumi.resolve(alb.url)).toBe(
        "http://MyAlbLoadBalancer.us-east-1.elb.amazonaws.com",
      );
      expect(await pulumi.resolve(alb.arn)).toBe(mockArn("MyAlbLoadBalancer"));
      expect(await pulumi.resolve(alb.dnsName)).toBe(
        "MyAlbLoadBalancer.us-east-1.elb.amazonaws.com",
      );
      expect(await pulumi.resolve(alb.zoneId)).toBe("Z35SXDOTRQ7X7K");
      expect(await pulumi.resolve(alb.securityGroupId)).toBe(
        "MyAlbSecurityGroup_id",
      );
      expect(await pulumi.resolve(alb._vpc)).toBe("vpc-1");
    });

    it("goes in the private subnets when it's internal", async () => {
      new Alb("MyAlb", { vpc: customVpc, public: false, listeners: http });
      await pulumi.settle();

      expect(resource("MyAlbLoadBalancer").inputs).toMatchObject({
        internal: true,
        subnets: customVpc.privateSubnets,
      });
    });

    it("gives its https listeners the certificate of its domain", async () => {
      const alb = new Alb("MyAlb", {
        vpc: customVpc,
        domain: "example.com",
        listeners: https,
      });
      await pulumi.settle();

      const certificate = await pulumi.resolve(alb.nodes.certificate!.arn);
      expect(resource("MyAlbListenerHTTPS443").inputs.certificateArn).toBe(
        certificate,
      );
      expect(
        resource("MyAlbListenerHTTP80").inputs.certificateArn,
      ).toBeUndefined();
      expect(await pulumi.resolve(alb.url)).toBe("https://example.com/");
    });

    it("has every part in nodes, the listeners by protocol and port", async () => {
      const alb = new Alb("MyAlb", { vpc: customVpc, listeners: http });
      await pulumi.settle();

      expect(alb.nodes.loadBalancer).toBeInstanceOf(aws.lb.LoadBalancer);
      expect(alb.nodes.securityGroup).toBeInstanceOf(aws.ec2.SecurityGroup);
      expect(alb.nodes.certificate).toBeUndefined();
      expect(Object.keys(alb.nodes.listener)).toEqual(["HTTP80", "HTTP8080"]);
    });

    it("transforms each listener, with its protocol and port", async () => {
      new Alb("MyAlb", {
        vpc: customVpc,
        domain: { name: "example.com", dns: false, cert: CERT_ARN },
        listeners: https,
        transform: {
          listener: (args, _opts, _name, id) => {
            if (id === "HTTPS443")
              args.sslPolicy = "ELBSecurityPolicy-TLS13-1-2-2021-06";
          },
        },
      });
      await pulumi.settle();

      expect(resource("MyAlbListenerHTTPS443").inputs.sslPolicy).toBe(
        "ELBSecurityPolicy-TLS13-1-2-2021-06",
      );
      expect(resource("MyAlbListenerHTTP80").inputs.sslPolicy).toBeUndefined();
    });

    it("links its URL", async () => {
      const alb = new Alb("MyAlb", {
        vpc: customVpc,
        domain: { name: "example.com", dns: false, cert: CERT_ARN },
        listeners: https,
      });
      const original = new OriginalAlb("Theirs", {
        vpc: customVpc,
        domain: { name: "example.com", dns: false, cert: CERT_ARN },
        listeners: https,
      });
      await pulumi.settle();

      const linked = await pulumi.resolve((alb as any).getSSTLink().properties);
      expect(linked).toEqual({ url: "https://example.com/" });
      expect(linked).toEqual(
        await pulumi.resolve(original.getSSTLink().properties),
      );
    });
  });

  describe("getListener", () => {
    it("returns a listener it created", async () => {
      const alb = new Alb("MyAlb", { vpc: customVpc, listeners: http });
      await pulumi.settle();

      expect(alb.getListener("http", 80)).toBe(alb.nodes.listener.HTTP80);
      expect(alb.getListener("HTTP", 8080)).toBe(alb.nodes.listener.HTTP8080);
    });

    it("looks one it didn't create up on the load balancer, once", async () => {
      const alb = Alb.get("MyAlb", ALB_ARN);
      const first = alb.getListener("https", 443);
      const second = alb.getListener("https", 443);
      await pulumi.settle();

      expect(second).toBe(first);
      expect(alb.nodes.listener.HTTPS443).toBe(first);
      expect(
        pulumi.resources.filter((r) => r.type === LISTENER).map((r) => r.name),
      ).toEqual(["MyAlbListenerHTTPS443"]);
      expect(resource("MyAlbListenerHTTPS443")).toMatchObject({
        kind: "read",
        options: { id: `${ALB_ARN}/listener/443` },
      });
    });
  });

  describe("a load balancer that's already deployed", () => {
    it("is looked up with the first security group it has", async () => {
      const alb = new Alb("MyAlb", {
        existing: { loadBalancer: ALB_ARN },
      } as any);
      await pulumi.settle();

      expect(
        pulumi.resources
          .filter((r) => r.type.startsWith("aws:"))
          .map((r) => r.name),
      ).toEqual(["MyAlbLoadBalancer", "MyAlbSecurityGroup"]);
      expect(resource("MyAlbSecurityGroup")).toMatchObject({
        kind: "read",
        type: SECURITY_GROUP,
        options: { id: "sg-alb" },
      });
      expect(await pulumi.resolve(alb.arn)).toBe(ALB_ARN);
      expect(await pulumi.resolve(alb.url)).toBe(
        "http://shared.us-east-1.elb.amazonaws.com",
      );
      expect(await pulumi.resolve(alb._vpc)).toBe("vpc-1");
      expect(await pulumi.resolve(alb.securityGroupId)).toBe("sg-alb");
      expect(pulumi.outputsOf("MyAlb")?._hint).toBe(
        "http://shared.us-east-1.elb.amazonaws.com",
      );
    });

    it("uses the security group it's given", async () => {
      const alb = new Alb("MyAlb", {
        existing: { loadBalancer: ALB_ARN, securityGroup: "sg-other" },
      } as any);
      await pulumi.settle();

      expect(resource("MyAlbSecurityGroup").options.id).toBe("sg-other");
      expect(await pulumi.resolve(alb.securityGroupId)).toBe("sg-other");
    });
  });

  describe("what it's given", () => {
    it("needs the listeners and the domain as plain values", () => {
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: output(http) as any,
          }),
      ).toThrow(
        /The "listeners" of the "MyAlb" load balancer has to be a plain value/,
      );
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: [{ port: output(80) as any, protocol: "http" }],
          }),
      ).toThrow(
        /The "listeners" of the "MyAlb" load balancer has to be a plain value/,
      );
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: http,
            domain: output("example.com") as any,
          }),
      ).toThrow(/The "domain" of the "MyAlb" load balancer/);
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: http,
            domain: {
              name: "example.com",
              aliases: output(["a.example.com"]) as any,
            },
          }),
      ).toThrow(/The domain's "aliases" in the "MyAlb" load balancer/);
    });

    it("refuses a domain with nothing to validate a certificate with", () => {
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: https,
            domain: { name: "example.com", dns: false },
          }),
      ).toThrow(/Domain "cert" is required when "dns" is disabled/);
    });

    it("refuses a listener it's given twice", () => {
      expect(
        () =>
          new Alb("MyAlb", {
            vpc: customVpc,
            listeners: [...http, { port: 80, protocol: "http" }],
          }),
      ).toThrow();
    });
  });
});
