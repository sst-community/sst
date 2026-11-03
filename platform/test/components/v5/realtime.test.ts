import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";
import {
  hashStringToPrettyString,
  logicalName,
} from "../../../src/components/naming";

const RULE = "aws:iot/topicRule:TopicRule";
const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:my-subscriber";
const FILTER = "app/test/chat/room1";

const pulumi = mockPulumi({
  call: (args) =>
    args.token === "aws:iot/getEndpoint:getEndpoint"
      ? { endpointAddress: "abc123-ats.iot.us-east-1.amazonaws.com" }
      : undefined,
});

type RealtimeClass =
  | typeof import("../../../src/components/aws/realtime").Realtime
  | typeof import("../../../src/components/aws/v5/realtime").Realtime;

// The hash 4.x named a subscriber with, from its filter and handler
const hashOf = (filter: string, handler: string) =>
  logicalName(hashStringToPrettyString(filter + handler, 6));
// What 4.x kept in the state and the V5 one doesn't: each subscriber's
// component, which has nothing in the cloud behind it
const subscriber = (filter: string, handler: string) =>
  `sst:aws:RealtimeLambdaSubscriber::MyServerSubscriber${hashOf(
    filter,
    handler,
  )}`;

describe("Realtime", () => {
  let Original: typeof import("../../../src/components/aws/realtime").Realtime;
  let Realtime: typeof import("../../../src/components/aws/v5/realtime").Realtime;
  let Function: typeof import("../../../src/components/aws/v5/function").Function;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/realtime")).Realtime;
    Realtime = (await import("../../../src/components/aws/v5/realtime"))
      .Realtime;
    Function = (await import("../../../src/components/aws/v5/function"))
      .Function;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const names = () => pulumi.resources.map((r) => r.name);
  const rules = () =>
    pulumi.resources
      .filter((r) => r.type === RULE)
      .map((r) => r.name)
      .sort();
  // The hash a subscriber is named with
  const hashes = () =>
    pulumi.resources
      .filter((r) => r.type === "sst:aws:RealtimeLambdaSubscriber")
      .map((r) => r.name.replace("MyServerSubscriber", ""))
      .sort();

  // Each case deploys the 4.x Realtime, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept, with the same inputs.
  describe("takes over a deployed Realtime", () => {
    pulumi.takeoverCases<RealtimeClass, RealtimeClass>({
      original: () => Original,
      v5: () => Realtime,
      cases: {
        "an authorizer from a handler": {
          create: (R, opts) => {
            new R("MyServer", { authorizer: "src/authorizer.handler" }, opts);
          },
          check: () =>
            expect(resource("MyServerAuthorizerHandler").type).toBe(
              "sst:aws:Function",
            ),
        },
        "an authorizer from its args, with permissions of its own": (
          R,
          opts,
        ) => {
          new R(
            "MyServer",
            {
              authorizer: {
                handler: "src/authorizer.handler",
                description: "Mine",
                timeout: "10 seconds",
                permissions: [{ actions: ["s3:GetObject"], resources: ["*"] }],
              },
              transform: {
                authorizer: { enableCachingForHttp: true } as any,
              },
            },
            opts,
          );
        },
        "subscribers from a handler, their args and an ARN": {
          create: (R, opts) => {
            const server = new R(
              "MyServer",
              { authorizer: "src/authorizer.handler" },
              opts,
            );
            server.subscribe("src/a.handler", { filter: FILTER });
            server.subscribe(
              { handler: "src/b.handler", timeout: "60 seconds" },
              { filter: "app/test/chat/#" },
            );
            server.subscribe(FUNCTION_ARN, { filter: FILTER });
          },
          unclaimed: [
            subscriber(FILTER, "src/a.handler"),
            subscriber("app/test/chat/#", "src/b.handler"),
            subscriber(FILTER, FUNCTION_ARN),
          ],
          check: () => {
            expect(rules()).toHaveLength(3);
          },
        },
        // 4.x took a subscriber's own transform. The V5 one takes the
        // component's, which every subscriber's rule goes through.
        "a subscriber's rule transformed": {
          original: (opts) => {
            const server = new Original(
              "MyServer",
              { authorizer: "src/authorizer.handler" },
              opts,
            );
            server.subscribe("src/a.handler", {
              filter: FILTER,
              transform: { topicRule: { description: "Chat" } },
            });
            return server;
          },
          v5: (opts) =>
            new Realtime(
              "MyServer",
              {
                authorizer: "src/authorizer.handler",
                transform: { topicRule: { description: "Chat" } },
              },
              opts,
            ).subscribe("src/a.handler", { filter: FILTER }),
          unclaimed: [subscriber(FILTER, "src/a.handler")],
        },
      },
    });
  });

  // SST 4 gave the subscribers only a provider passed to the component itself, so
  // one it took from a parent didn't reach them. The 5.0 ones have the
  // component's, so a switch replaces them, as "Switch from" says.
  it("replaces the subscribers of one that takes its provider from a parent", async () => {
    const { ComponentResource } = await import("@pulumi/pulumi");
    const { Provider } = await import("@pulumi/aws");
    const inParent = (C: any) => {
      const parent = new ComponentResource(
        "test:index:Parent",
        "Parent",
        {},
        {
          providers: { aws: new Provider("East", { region: "us-east-1" }) },
        },
      );
      new C(
        "MyRealtime",
        { authorizer: "src/auth.handler" },
        { parent },
      ).subscribe("src/a.handler", { filter: "chat/#" });
    };
    const result = await pulumi.takesOver(
      () => inParent(Original),
      () => inParent(Realtime),
    );
    const replaced = result.changed
      .filter((c) => c.fields.includes("options.provider"))
      .map((c) => c.name);
    expect(replaced).toContain("MyRealtimeSubscriberHuueahRule");
    expect(replaced).toContain("MyRealtimeSubscriberHuueahHandlerLogGroup");
  });

  it("names each subscriber with SST 4's hash, inside the server", async () => {
    new Original("MyServer", {
      authorizer: "src/authorizer.handler",
    }).subscribe("src/a.handler", { filter: FILTER });
    await pulumi.settle();
    const [hash] = hashes();
    expect(hash).toBe(hashOf(FILTER, "src/a.handler"));
    pulumi.reset();
    const server = new Realtime("MyServer", {
      authorizer: "src/authorizer.handler",
    }).subscribe("src/a.handler", { filter: FILTER });
    await pulumi.settle();
    expect(names()).toContain(`MyServerSubscriber${hash}`);
    expect(rules()).toEqual([`MyServerTopicRule${hash}`]);
    expect(Object.keys(server.nodes.topicRule)).toEqual([hash]);
    expect(resource(`MyServerTopicRule${hash}`).inputs.sql).toBe(
      `SELECT * FROM '${FILTER}'`,
    );
  });

  it("gives the authorizer what it may do on IoT, after the user's permissions", async () => {
    new Realtime("MyServer", {
      authorizer: {
        handler: "src/authorizer.handler",
        permissions: [{ actions: ["s3:GetObject"], resources: ["*"] }],
      },
    });
    await pulumi.settle();
    const policy = JSON.stringify(
      await pulumi.resolve(
        resource("MyServerAuthorizerHandlerRole").inputs.inlinePolicies,
      ),
    );
    expect(policy.indexOf("s3:GetObject")).toBeLessThan(
      policy.indexOf("iot:*"),
    );
  });

  it("turns down a filter given as an output, a subscriber twice, and a subscriber's own transform", () => {
    const server = new Realtime("MyServer", {
      authorizer: "src/authorizer.handler",
    });
    expect(() =>
      server.subscribe("src/a.handler", { filter: output(FILTER) as any }),
    ).toThrow(/"filter"/);
    server.subscribe("src/a.handler", { filter: FILTER });
    expect(() => server.subscribe("src/a.handler", { filter: FILTER })).toThrow(
      /already has a subscriber with the filter/,
    );
    expect(() =>
      server.subscribe("src/b.handler", {
        filter: FILTER,
        // @ts-expect-error
        transform: { topicRule: {} },
      }),
    ).toThrow(/Use the "transform" of "MyServer"/);
  });

  it("can be linked by a function, which may publish", async () => {
    const server = new Realtime("MyServer", {
      authorizer: "src/authorizer.handler",
    });
    new Function("Api", { handler: "src/api.handler", link: [server] });
    await pulumi.settle();
    expect(names()).toContain("ApiFunction");
    expect(await pulumi.resolve(server.endpoint)).toBe(
      "abc123-ats.iot.us-east-1.amazonaws.com",
    );
  });
});
