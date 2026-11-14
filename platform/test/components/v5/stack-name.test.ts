import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../../src/testing/mock";
import { rejectionsOf } from "../../helpers/rejections";

// A program Pulumi runs on its own, whose project's and stack's names SST's
// CLI wouldn't take as an app's and a stage's. A component that puts one in
// a name it makes itself, not with `physicalName`, holds it to SST's rule
// too, so the error is SST's and nothing in the cloud gets the name, even
// when nothing `physicalName` names comes first. naming-plain.test.ts has
// the rule.

const pulumi = mockPulumi({ plain: true, app: "my_shop", stage: "feature_x" });

// A cluster's VPC, with a Cloud Map namespace for the service
const network = {
  id: "vpc-1",
  securityGroups: ["sg-1"],
  containerSubnets: ["subnet-1", "subnet-2"],
  loadBalancerSubnets: ["subnet-3", "subnet-4"],
  cloudmapNamespaceId: "ns-1",
  cloudmapNamespaceName: "app.local",
};
// A database's
const subnets = { subnets: ["subnet-1", "subnet-2"], securityGroups: ["sg-1"] };

type Modules = {
  ApiGatewayRest: typeof import("../../../src/components/aws/apigateway-rest").ApiGatewayRest;
  Service: typeof import("../../../src/components/aws/service").Service;
  Cluster: typeof import("../../../src/components/aws/cluster").Cluster;
  Postgres: typeof import("../../../src/components/aws/postgres").Postgres;
  Aurora: typeof import("../../../src/components/aws/aurora").Aurora;
};

describe("A project's and a stack's names SST's CLI wouldn't take", () => {
  const m = {} as Modules;

  beforeAll(async () => {
    m.ApiGatewayRest = (
      await import("../../../src/components/aws/apigateway-rest")
    ).ApiGatewayRest;
    m.Service = (await import("../../../src/components/aws/service")).Service;
    m.Cluster = (await import("../../../src/components/aws/cluster")).Cluster;
    m.Postgres = (
      await import("../../../src/components/aws/postgres")
    ).Postgres;
    m.Aurora = (await import("../../../src/components/aws/aurora")).Aurora;
  });

  beforeEach(() => pulumi.reset());

  const cases: Record<string, (m: Modules) => void> = {
    // Its Cloud Map service is named after the stack and the project. With
    // its log group's name given, nothing `physicalName` names comes first.
    Service: (m) =>
      new m.Service("Web", {
        cluster: new m.Cluster("Cluster", { vpc: network }),
        containers: [
          {
            name: "web",
            image: "nginx:latest",
            logging: { name: "/my/logs" },
          },
        ],
      }),
    // Its stage is named after the stack
    ApiGatewayV1: (m) => new m.ApiGatewayRest("Api").deploy(),
    // Its database is named after the project
    Postgres: (m) => new m.Postgres("Db", { vpc: subnets }),
    Aurora: (m) => new m.Aurora("Db", { engine: "postgres", vpc: subnets }),
  };

  for (const [name, create] of Object.entries(cases)) {
    it(`is SST's error for ${name}, and nothing gets them`, async () => {
      // Thrown as it's created, or when what it makes is deployed
      const thrown: unknown[] = [];
      const rejected = await rejectionsOf(async () => {
        try {
          create(m);
        } catch (e) {
          thrown.push(e);
        }
        await pulumi.settle();
      });
      const failures = [...thrown, ...rejected];
      const named = pulumi.resources.filter((r) =>
        /feature_x|my_shop/.test(JSON.stringify(r.inputs)),
      );
      expect(named.map((r) => `${r.type} ${r.name}`)).toEqual([]);
      expect(failures.length).toBeGreaterThan(0);
      expect(String((failures[0] as Error).message)).toMatch(
        /the Pulumi project's name .* "my_shop" isn't one SST's CLI takes/,
      );
    });
  }
});
