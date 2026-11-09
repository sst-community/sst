import { beforeAll, describe, expect, it } from "vitest";
import { mockPulumi } from "../helpers/graph";
import { VisibleError } from "../../src/components/error";
import { renamedNodes } from "../../src/components/sst4";

const pulumi = mockPulumi({
  // The `Auth`'s issuer has a URL
  state: (args) =>
    args.type === "aws:lambda/functionUrl:FunctionUrl"
      ? { functionUrl: "https://issuer.lambda-url.us-east-1.on.aws/" }
      : {},
  call: (args) =>
    args.token === "aws:index/getAvailabilityZones:getAvailabilityZones"
      ? { names: ["us-east-1a", "us-east-1b"] }
      : undefined,
});

// SST 4's names that SST 5 doesn't have fail with what to write, where they'd
// fail with "is not a constructor" or read `undefined`: a config written for
// SST 4 that `sst migrate --codemod` hasn't been run on.
const GROUPS = ["aws", "cloudflare"] as const;

const isComponent = (value: unknown) =>
  typeof (value as { __pulumiType?: unknown })?.__pulumiType === "string";

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(VisibleError);
    return (error as Error).message;
  }
  throw new Error("It didn't throw");
}

describe.each(GROUPS)("sst.%s", (group) => {
  let v4: Record<string, any>;
  let v5: Record<string, any>;

  beforeAll(async () => {
    v4 = await import(`../fixtures/v4/components/${group}/index.ts`);
    v5 = await import(`../../src/components/${group}/index.ts`);
  });

  it("has every one of SST 4's components, or a name that says what to write", () => {
    const sst4 = Object.keys(v4).filter((name) => isComponent(v4[name]));
    expect(sst4.length).toBeGreaterThan(10);
    for (const name of sst4) {
      expect(v5[name], `sst.${group}.${name}`).toBeTypeOf("function");
      if (isComponent(v5[name])) continue;
      expect(
        refusal(() => new v5[name]("MyComponent", {})),
        `sst.${group}.${name}`,
      ).toMatch(
        new RegExp(
          `^"sst\\.${group}\\.${name}" (is SST 4's name: it's "sst\\.${group}\\.\\w+" in SST 5|has no SST 5 form)`,
        ),
      );
    }
  });

  it("has SST 4's experimental components under `x`, or names that say what to write", () => {
    const sst4 = Object.keys(v4.x ?? {}).filter((name) =>
      isComponent(v4.x[name]),
    );
    expect(sst4.sort()).toEqual(
      group === "cloudflare" ? ["Astro", "SolidStart", "StaticSite"] : [],
    );
    for (const name of sst4) {
      if (isComponent(v5.x?.[name])) continue;
      expect(refusal(() => new v5.x[name]("MyComponent", {}))).toMatch(
        new RegExp(
          `^"sst\\.${group}\\.x\\.${name}" (is SST 4's name: it's "sst\\.${group}\\.${name}" in SST 5|has no SST 5 form)`,
        ),
      );
    }
  });

  it("names the component it's called now, and the codemod that renames it", () => {
    const renamed =
      group === "aws"
        ? {
            ApiGatewayV1: "ApiGatewayRest",
            ApiGatewayV2: "ApiGatewayHttp",
            CronV2: "Cron",
          }
        : { StaticSiteV2: "StaticSite" };
    for (const [old, now] of Object.entries(renamed)) {
      expect(isComponent(v5[now]), now).toBe(true);
      expect(refusal(() => new v5[old]("MyComponent"))).toBe(
        `"sst.${group}.${old}" is SST 4's name: it's "sst.${group}.${now}" in SST 5. "sst migrate --codemod" renames it, and lists anything else to change in your config.`,
      );
    }
  });

  it("refuses SST 4's static `get` the same way", () => {
    for (const name of Object.keys(v4).filter(
      (name) =>
        isComponent(v4[name]) &&
        typeof v4[name].get === "function" &&
        !isComponent(v5[name]),
    ))
      expect(refusal(() => v5[name].get("MyComponent", "id"))).toBe(
        refusal(() => new v5[name]("MyComponent")),
      );
    if (group === "aws")
      expect(refusal(() => v5.Vector.get("MyVectors", "cluster-id"))).toMatch(
        /^"sst\.aws\.Vector" has no SST 5 form\./,
      );
  });

  it("refuses SST 4's `.v1` of a component", () => {
    const withV1 = Object.keys(v4).filter(
      (name) => isComponent(v4[name]) && isComponent(v4[name].v1),
    );
    expect(withV1.sort()).toEqual(
      group === "aws" ? ["Auth", "Cluster", "Postgres", "Redis", "Vpc"] : [],
    );
    for (const name of withV1) {
      const now =
        name === "Auth"
          ? `OpenAuth's "sst.aws.Auth", which works differently`
          : `"sst.aws.${name}"`;
      expect(refusal(() => v5[name].v1)).toBe(
        `"sst.aws.${name}.v1" is SST 4's first version of "sst.aws.${name}", which SST 5 doesn't have: use ${now}. A stage deployed with the first version moves to the current one with SST 4 first.`,
      );
    }
  });
});

describe("sst.linkable", () => {
  it("says to use sst.Linkable.wrap", async () => {
    const sst = await import("../../src/components/core");
    expect(refusal(() => sst.linkable(class {}, () => ({})))).toBe(
      `"sst.linkable" is SST 4's: use "sst.Linkable.wrap", which takes the same.`,
    );
  });
});

describe("SST 4's nodes names", () => {
  it("are each for one of SST 5's components", async () => {
    const types = new Set<string>();
    for (const group of GROUPS) {
      const v5: Record<string, any> = await import(
        `../../src/components/${group}/index.ts`
      );
      for (const value of Object.values(v5))
        if (isComponent(value)) types.add(value.__pulumiType);
    }
    for (const type of Object.keys(renamedNodes))
      expect(types, type).toContain(type);
  });

  it("refuse with a key SST 5's nodes has, and aren't listed", async () => {
    const aws = await import("../../src/components/aws/index");
    const handler = "src/a.handler";
    const made: Record<string, any> = {
      "sst:aws:Bus": new aws.Bus("Bus"),
      "sst:aws:SnsTopic": new aws.SnsTopic("Topic"),
      "sst:aws:KinesisStream": new aws.KinesisStream("Stream"),
      "sst:aws:Queue": new aws.Queue("Queue"),
      "sst:aws:Bucket": new aws.Bucket("Bucket"),
      "sst:aws:Dynamo": new aws.Dynamo("Table", {
        fields: { id: "string" },
        primaryIndex: { hashKey: "id" },
      }),
      "sst:aws:CronV2": new aws.Cron("Cron", {
        schedule: "rate(1 day)",
        function: handler,
      }),
      "sst:aws:ApiGatewayV2": new aws.ApiGatewayHttp("Http"),
      "sst:aws:ApiGatewayV1": new aws.ApiGatewayRest("Rest"),
      "sst:aws:ApiGatewayWebSocket": new aws.ApiGatewayWebSocket("Socket"),
      "sst:aws:Vpc": new aws.Vpc("Vpc"),
      "sst:aws:Realtime": new aws.Realtime("Realtime", { authorizer: handler }),
      "sst:aws:Auth": new aws.Auth("Auth", { issuer: handler }),
    };
    // Each type is built here but these: the `Alb`'s is checked in its own
    // test, and a `Nextjs` or a Cloudflare `Queue` needs more than the mock
    expect(
      Object.keys(renamedNodes)
        .filter((type) => !(type in made))
        .sort(),
    ).toEqual(["sst:aws:Alb", "sst:aws:Nextjs", "sst:cloudflare:Queue"]);
    await pulumi.settle();
    for (const [type, component] of Object.entries(made)) {
      const nodes = component.nodes;
      for (const [key, now] of Object.entries(renamedNodes[type])) {
        const message = refusal(() => nodes[key]);
        expect(message, `${type} ${key}`).toContain(
          ` is SST 4's: read ${now}.`,
        );
        expect(Object.keys(nodes), `${type} ${key}`).not.toContain(key);
        const part = now.match(/^"nodes\.(\w+)"/)?.[1];
        expect(Object.keys(nodes), `${type} ${key} -> ${part}`).toContain(part);
      }
    }
  });
});

describe("What takes a component's class", () => {
  it("says what to write when it's given one of SST 4's names", async () => {
    const { $transform } = await import("../../src/components/component");
    const { Linkable } = await import("../../src/components/linkable");
    const aws = await import("../../src/components/aws/index");
    const said = refusal(() => new (aws.ApiGatewayV2 as any)("Api"));
    expect(refusal(() => $transform(aws.ApiGatewayV2 as any, () => {}))).toBe(
      said,
    );
    expect(
      refusal(() =>
        Linkable.wrap(aws.Vector as any, () => ({ properties: {} })),
      ),
    ).toBe(refusal(() => new (aws.Vector as any)("V")));
    // And what isn't a class of a component or a resource
    expect(refusal(() => $transform(class {} as any, () => {}))).toMatch(
      /^\$transform takes a component's or a resource's class/,
    );
  });
});
