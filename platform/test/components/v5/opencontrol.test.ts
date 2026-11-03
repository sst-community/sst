import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../../helpers/graph";

const SIG = "4dabf18193072939515e22adb298388d";
const SECRET = "1b47061264138c4ac30d75fd1eb44270";

const pulumi = mockPulumi({
  state: (args) =>
    args.type === "aws:lambda/functionUrl:FunctionUrl"
      ? { functionUrl: `https://${args.name.toLowerCase()}.lambda-url.on.aws/` }
      : args.type === "random:index/randomPassword:RandomPassword"
        ? // A password's result is a secret, as it is in AWS
          { result: { [SIG]: SECRET, value: "generated-key" } }
        : {},
});

type OpenControlClass =
  | typeof import("../../../src/components/aws/opencontrol").OpenControl
  | typeof import("../../../src/components/aws/v5/opencontrol").OpenControl;

describe("OpenControl", () => {
  let Original: typeof import("../../../src/components/aws/opencontrol").OpenControl;
  let OpenControl: typeof import("../../../src/components/aws/v5/opencontrol").OpenControl;

  beforeAll(async () => {
    Original = (await import("../../../src/components/aws/opencontrol"))
      .OpenControl;
    OpenControl = (await import("../../../src/components/aws/v5/opencontrol"))
      .OpenControl;
    await import("../../../src/components/aws/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;

  // Each case deploys the 4.x OpenControl, then the same thing as the V5
  // one. Everything the 4.x one created has to be kept by the V5 one, with
  // the same inputs.
  describe("takes over a deployed OpenControl", () => {
    pulumi.takeoverCases<OpenControlClass, OpenControlClass>({
      original: () => Original,
      v5: () => OpenControl,
      // SST 4 created the server in an `apply` over all of its args, so its
      // URL waited on what it links. Nothing in AWS needs that.
      needlessOrder: /^MyServerServerUrl\w* before MyBucket/,
      check: () =>
        expect(resource("MyServerServerFunction").type).toBe(
          "aws:lambda/function:Function",
        ),
      cases: {
        "a server from a handler": (OpenControl, opts) => {
          new OpenControl("MyServer", { server: "src/server.handler" }, opts);
        },
        "a server from function args": async (OpenControl, opts) => {
          const { Bucket } = await import(
            "../../../src/components/aws/v5/bucket"
          );
          new OpenControl(
            "MyServer",
            {
              server: {
                handler: "src/server.handler",
                link: [new Bucket("MyBucket")],
                timeout: "60 seconds",
                policies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
                environment: { MODE: "tools" },
              },
            },
            opts,
          );
        },
        "a URL of its own": (OpenControl, opts) => {
          new OpenControl(
            "MyServer",
            { server: { handler: "src/server.handler", url: { cors: true } } },
            opts,
          );
        },
        "permissions of its own": (OpenControl, opts) => {
          new OpenControl(
            "MyServer",
            {
              server: {
                handler: "src/server.handler",
                permissions: [
                  {
                    actions: ["s3:GetObject"],
                    resources: ["arn:aws:s3:::my-bucket/*"],
                  },
                ],
              },
            },
            opts,
          );
        },
        "a key of its own": (OpenControl, opts) => {
          new OpenControl(
            "MyServer",
            {
              server: {
                handler: "src/server.handler",
                environment: { OPENCONTROL_KEY: "my-key" },
              },
            },
            opts,
          );
        },
        "in sst dev": (OpenControl, opts) => {
          // @ts-ignore
          global.$dev = true;
          new OpenControl("MyServer", { server: "src/server.handler" }, opts);
        },
        "in sst dev, with args and a link": async (OpenControl, opts) => {
          const { Bucket } = await import(
            "../../../src/components/aws/v5/bucket"
          );
          // @ts-ignore
          global.$dev = true;
          new OpenControl(
            "MyServer",
            {
              server: {
                handler: "src/server.handler",
                link: [new Bucket("MyBucket")],
                environment: { MODE: "tools" },
              },
            },
            opts,
          );
        },
      },
    });
  });

  it("gives the server its key and a URL without CORS", async () => {
    const server = new OpenControl("MyServer", {
      server: { handler: "src/server.handler", environment: { MODE: "tools" } },
    });
    await pulumi.settle();

    expect(resource("MyServerKey").inputs).toMatchObject({
      length: 16,
      special: false,
    });
    // The key is a secret, so the function's environment is kept secret
    expect(
      resource("MyServerServerFunction").inputs.environment.variables,
    ).toEqual({
      [SIG]: SECRET,
      value: expect.objectContaining({
        OPENCONTROL_KEY: "generated-key",
        MODE: "tools",
      }),
    });
    expect(resource("MyServerServerUrl").inputs.cors).toBeUndefined();
    expect(await pulumi.resolve(server.password)).toBe("generated-key");
    expect(await pulumi.resolve(server.url)).toBe(
      "https://myserverserverurl.lambda-url.on.aws/",
    );
    expect(pulumi.reportOf("MyServer")?.hint).toBe(
      "https://myserverserverurl.lambda-url.on.aws/",
    );
    expect(Object.keys(server.nodes).sort()).toEqual(["key", "server"]);
  });

  it("refuses a server it can't create", () => {
    expect(() => new OpenControl("MyServer", {} as any)).toThrow(
      /The "MyServer" OpenControl server needs a "server"/,
    );
    expect(
      () =>
        new OpenControl("MyServer", {
          server: "arn:aws:lambda:us-east-1:123456789012:function:server",
        }),
    ).toThrow(
      /is the ARN of a function\. Pass the handler or the function's args/,
    );
    expect(
      () =>
        new OpenControl("MyServer", {
          server: output("src/server.handler") as any,
        }),
    ).toThrow(/The "server" of the "MyServer" OpenControl server/);
  });

  it("refuses an existing server or key", () => {
    expect(
      () =>
        new OpenControl("MyServer", {
          server: "src/server.handler",
          existing: {
            server: "arn:aws:lambda:us-east-1:123456789012:function:server",
          },
        }),
    ).toThrow(
      /"existing\.server" isn't an option for the "MyServer" OpenControl server\. Pass the handler/,
    );
    expect(
      () =>
        new OpenControl("MyServer", {
          server: "src/server.handler",
          existing: { key: "key-id" },
        }),
    ).toThrow(
      /"existing\.key" isn't an option for the "MyServer" OpenControl server\. It generates the key/,
    );
  });

  it("transforms the server and the key", async () => {
    new OpenControl("MyServer", {
      server: "src/server.handler",
      transform: {
        server: { memory: "512 MB" },
        key: (args) => {
          args.length = 32;
        },
      },
    });
    await pulumi.settle();

    expect(resource("MyServerKey").inputs).toMatchObject({
      length: 32,
      special: false,
    });
    expect(resource("MyServerServerFunction").inputs.memorySize).toBe(512);
  });
});
