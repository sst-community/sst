/// <reference path="../../src/global.d.ts" />
import { describe, beforeAll, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
global.$util = pulumi;

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs): {
      id: string;
      state: any;
    } {
      // A resource without a name input, as a security group, or a resource
      // read with .get(), is named after its resource.
      const name = args.inputs.name || args.name;
      return {
        id: name + "_id",
        state: {
          ...args.inputs,
          arn: `arn:aws:elasticloadbalancing:us-east-1:123456789:${args.type}/${name}`,
          dnsName: `${name}.us-east-1.elb.amazonaws.com`,
          zoneId: "Z1234567890",
          vpcId: "vpc-mock-id",
          securityGroups: ["sg-mock-id"],
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      // Mock lb.getListener — return a fake ARN so Listener.get works
      if (args.token === "aws:alb/getListener:getListener") {
        return {
          arn: `arn:aws:elasticloadbalancing:us-east-1:123456789:listener/app/mock/${args.inputs.port}`,
          ...args.inputs,
        };
      }
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

describe("Alb", function () {
  let Alb: typeof import("../../src/components/aws/alb").Alb;

  beforeAll(async function () {
    Alb = (await import("../../src/components/aws/alb")).Alb;
  });

  describe("#constructor", () => {
    it("creates load balancer with correct type", async () => {
      const alb = new Alb("TestAlb", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      const arn = await new Promise((resolve) => alb.arn.apply(resolve));
      expect(arn).toMatch(
        /:aws:lb\/loadBalancer:LoadBalancer\/TestAlbLoadBala-/,
      );
    });

    it("exposes url without domain", async () => {
      const alb = new Alb("TestAlbUrl", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      const url = await new Promise((resolve) => alb.url.apply(resolve));
      expect(url).toMatch(
        /^http:\/\/TestAlbUrlLoadB-[a-z]+\.us-east-1\.elb\.amazonaws\.com$/,
      );
    });

    it("exposes security group ID", async () => {
      const alb = new Alb("TestAlbSg", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      const sgId = await new Promise((resolve) =>
        alb.securityGroupId.apply(resolve),
      );
      expect(sgId).toBe("TestAlbSgSecurityGroup_id");
    });

    it("exposes nodes with loadBalancer, securityGroup, listeners", async () => {
      const alb = new Alb("TestAlbNodes", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      expect(alb.nodes.loadBalancer).toBeDefined();
      expect(alb.nodes.securityGroup).toBeDefined();
      expect(alb.nodes.listeners).toBeDefined();
    });
  });

  describe("#getListener", () => {
    it("returns a listener it declares", async () => {
      const alb = new Alb("TestAlbDeclared", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      // the one it made, which is among its nodes before it's asked for
      const declared = alb.nodes.listeners["HTTP80"];
      expect(declared).toBeDefined();
      expect(alb.getListener("http", 80)).toBe(declared);
    });

    // A listener added to the load balancer some other way is read from AWS
    it("looks up a listener it doesn't declare", async () => {
      const alb = new Alb("TestAlbMissing", {
        vpc: {
          id: "vpc-123",
          publicSubnets: ["subnet-a", "subnet-b"],
          privateSubnets: ["subnet-c", "subnet-d"],
        },
        listeners: [{ port: 80, protocol: "http" }],
      });

      expect(alb.nodes.listeners["HTTPS443"]).toBeUndefined();
      const listener = alb.getListener("https", 443);
      const urn = await new Promise((resolve) => listener.urn.apply(resolve));
      expect(urn).toMatch(/::TestAlbMissingListenerHTTPS443$/);
      expect(alb.getListener("https", 443)).toBe(listener);
    });
  });

  describe(".get() reference", () => {
    it("creates a referenced ALB from ARN", async () => {
      const alb = Alb.get(
        "RefAlb",
        "arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/app/my-alb/abc123",
      );

      const arn = await new Promise((resolve) => alb.arn.apply(resolve));
      expect(arn).toMatch(
        /:aws:lb\/loadBalancer:LoadBalancer\/RefAlbLoadBalan/,
      );
    });

    it("lazy discovers listener via getListener on ref ALB", async () => {
      const alb = Alb.get(
        "RefAlbListener",
        "arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/app/my-alb/abc123",
      );

      // Should not throw — lazy discovery kicks in
      const listener = alb.getListener("http", 80);
      expect(listener).toBeDefined();
    });

    it("caches discovered listeners on subsequent calls", async () => {
      const alb = Alb.get(
        "RefAlbCache",
        "arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/app/my-alb/abc123",
      );

      const listener1 = alb.getListener("http", 80);
      const listener2 = alb.getListener("http", 80);
      expect(listener1).toBe(listener2);
    });

    it("discovers different listeners independently", async () => {
      const alb = Alb.get(
        "RefAlbMulti",
        "arn:aws:elasticloadbalancing:us-east-1:123456789:loadbalancer/app/my-alb/abc123",
      );

      const http = alb.getListener("http", 80);
      const https = alb.getListener("https", 443);
      expect(http).not.toBe(https);
    });
  });
});
