import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

const pulumi = mockPulumi();

describe("DevCommand", () => {
  let OriginalDevCommand: typeof import("../../../src/components/experimental/dev-command").DevCommand;
  let DevCommand: typeof import("../../../src/components/experimental/v5/dev-command").DevCommand;

  beforeAll(async () => {
    OriginalDevCommand = (
      await import("../../../src/components/experimental/dev-command")
    ).DevCommand;
    DevCommand = (
      await import("../../../src/components/experimental/v5/dev-command")
    ).DevCommand;
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  // Neither has anything in AWS behind it. SST 4's kept what `sst dev` runs
  // in its outputs in every deploy; the V5 one reports it in `sst dev` alone.
  describe("takes over a deployed DevCommand", () => {
    pulumi.takeoverCases({
      original: () => OriginalDevCommand,
      v5: () => DevCommand,
      changed: [["Studio", ["outputs"]]],
      cases: {
        "in a deploy": (DevCommand, opts) => {
          new DevCommand(
            "Studio",
            { dev: { command: "npx drizzle-kit studio" } },
            opts,
          );
        },
        "in sst dev": (DevCommand, opts) => {
          // @ts-ignore
          global.$dev = true;
          new DevCommand(
            "Studio",
            {
              dev: { command: "npx drizzle-kit studio", directory: "db" },
              environment: { PORT: "4983" },
            },
            opts,
          );
        },
      },
    });
  });

  it("reports what sst dev runs", async () => {
    const { Linkable } = await import("../../../src/components/linkable");
    // @ts-ignore
    global.$dev = true;
    const stripe = new Linkable("Stripe", { properties: { key: "sk_test" } });
    new DevCommand("Studio", {
      link: [stripe],
      environment: { PORT: "4983" },
      dev: {
        command: "npx drizzle-kit studio",
        directory: "db",
        title: "Drizzle",
        autostart: false,
      },
    });
    await pulumi.settle();

    expect(pulumi.reportOf("Studio")).toEqual({
      contract: 1,
      dev: {
        command: "npx drizzle-kit studio",
        directory: "db",
        title: "Drizzle",
        autostart: false,
        links: ["Stripe"],
        environment: { PORT: "4983" },
      },
    });
  });

  it("starts with sst dev by default", async () => {
    // @ts-ignore
    global.$dev = true;
    new DevCommand("Studio", { dev: { command: "npx drizzle-kit studio" } });
    await pulumi.settle();

    expect(pulumi.reportOf("Studio")?.dev).toMatchObject({ autostart: true });
  });

  it("reports nothing in a deploy, and creates nothing", async () => {
    new DevCommand("Studio", {
      dev: { command: "npx drizzle-kit studio" },
      environment: { TOKEN: "not in the state" },
    });
    await pulumi.settle();

    expect(pulumi.reportOf("Studio")).toBeUndefined();
    expect(pulumi.resources.map((r) => r.type)).toEqual(["sst:sst:DevCommand"]);
  });

  it("needs a command", () => {
    expect(() => new DevCommand("Studio", { dev: {} } as any)).toThrow(
      /The "Studio" DevCommand has no "dev.command"/,
    );
    expect(() => new DevCommand("Studio", {} as any)).toThrow(
      /has no "dev.command"/,
    );
  });

  // SST 4's components create SST 4's `DevCommand` inside them, and some of
  // them have no 5.0 form yet. A component with a takeover map is refused in
  // its SST 4 form on a new stage, so this one has none until they're gone:
  // with no parts, it has nothing to map anyway.
  it("leaves SST 4's DevCommand usable", async () => {
    const { takeoverOf } = await import("../../../src/components/takeover");
    expect(takeoverOf(DevCommand)).toBeUndefined();
  });
});
