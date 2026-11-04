import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, type TakeoverWay } from "../../../helpers/graph";

const TRIGGER = "cloudflare:index/workersCronTrigger:WorkersCronTrigger";
const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
// The mock builds a worker into a file of this extension
const handler = "src/cron.mjs";
const schedules = ["*/5 * * * *"];

const pulumi = mockPulumi();

type CronClass =
  | typeof import("../../../../src/components/cloudflare/cron").Cron
  | typeof import("../../../../src/components/cloudflare/v5/cron").Cron;

describe("Cron", () => {
  let Original: typeof import("../../../../src/components/cloudflare/cron").Cron;
  let Cron: typeof import("../../../../src/components/cloudflare/v5/cron").Cron;
  let Secret: typeof import("../../../../src/components/secret").Secret;

  beforeAll(async () => {
    Original = (await import("../../../../src/components/cloudflare/cron"))
      .Cron;
    Cron = (await import("../../../../src/components/cloudflare/v5/cron")).Cron;
    Secret = (await import("../../../../src/components/secret")).Secret;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  beforeEach(() => {
    pulumi.reset();
    // @ts-ignore
    global.$dev = false;
  });

  const resource = (name: string) =>
    pulumi.resources.find((r) => r.name === name)!;
  const named = (type: string) =>
    pulumi.resources.filter((r) => r.type === type).map((r) => r.name);

  // SST 4 created the Worker with no parent, so with the app's provider,
  // whatever the cron job had. The V5 one gives it the cron job's, so with a
  // provider of its own each of the Worker's resources is given that one.
  const provided = (way: TakeoverWay): [string, string[]][] =>
    way === "with another provider"
      ? [["MyCronHandlerScript", ["options.provider"]]]
      : [];

  // Each case deploys the 4.x Cron, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. 4.x created the Worker at the top of the app; V5 creates it
  // inside the cron job.
  describe("takes over a deployed Cron", () => {
    pulumi.takeoverCases<CronClass, CronClass>({
      original: () => Original,
      v5: () => Cron,
      provider: "cloudflare",
      changed: provided,
      check: () => {
        expect(named(TRIGGER)).toEqual(["MyCronTrigger"]);
        expect(resource("MyCronTrigger").inputs).toMatchObject({
          scriptName: "app-test-mycronhandlerscript",
          schedules: [{ cron: "*/5 * * * *" }],
        });
      },
      cases: {
        "a cron job from a handler": (Cron, opts) => {
          new Cron("MyCron", { worker: handler, schedules }, opts);
        },
        "a cron job from worker args": (Cron, opts) => {
          new Cron(
            "MyCron",
            {
              worker: { handler, url: true, environment: { MODE: "cron" } },
              schedules,
            },
            opts,
          );
        },
        // What `sst dev` runs, which the CLI reads from the Worker
        "a cron job in sst dev": {
          create: (Cron, opts) => {
            // @ts-ignore
            global.$dev = true;
            new Cron("MyCron", { worker: handler, schedules }, opts);
          },
          check: () =>
            expect(pulumi.outputsOf("MyCronHandler")?._live).toMatchObject({
              functionID: "MyCronHandler",
              handler,
            }),
        },
        "a cron job whose worker is linked": (Cron, opts) => {
          const secret = new Secret("MySecret", "shh");
          new Cron(
            "MyCron",
            { worker: { handler, link: [secret] }, schedules },
            opts,
          );
        },
        "a cron job written with the deprecated job": {
          original: (opts) =>
            new Original("MyCron", { job: handler, schedules }, opts),
          v5: (opts) =>
            new Cron("MyCron", { worker: handler, schedules }, opts),
        },
        "a cron job with its trigger transformed": {
          original: (opts) =>
            new Original(
              "MyCron",
              {
                worker: handler,
                schedules: ["0 * * * *"],
                transform: {
                  trigger: (args) => {
                    args.schedules = [{ cron: "*/5 * * * *" }];
                  },
                },
              },
              opts,
            ),
          v5: (opts) =>
            new Cron(
              "MyCron",
              {
                worker: handler,
                schedules: ["0 * * * *"],
                transform: {
                  trigger: (args) => {
                    args.schedules = [{ cron: "*/5 * * * *" }];
                  },
                },
              },
              opts,
            ),
        },
      },
    });
  });

  it("creates its Worker inside, with the name SST 4 gave it", async () => {
    const cron = new Cron("MyCron", { worker: handler, schedules });
    await pulumi.settle();
    expect(named(SCRIPT)).toEqual(["MyCronHandlerScript"]);
    expect(resource("MyCronHandler").parent).toMatch(
      /sst:cloudflare:Cron::MyCron$/,
    );
    expect(cron.nodes.worker.nodes.worker).toBeDefined();
    expect(cron.nodes.trigger).toBeDefined();
  });

  it("transforms the Worker", async () => {
    new Cron("MyCron", {
      worker: handler,
      schedules,
      transform: { worker: { environment: { MODE: "cron" } } },
    });
    await pulumi.settle();
    expect(resource("MyCronHandlerScript").inputs.bindings).toContainEqual({
      type: "plain_text",
      name: "MODE",
      text: "cron",
    });
  });

  it("takes schedules that are outputs", async () => {
    new Cron("MyCron", { worker: handler, schedules: output(schedules) });
    await pulumi.settle();
    expect(resource("MyCronTrigger").inputs.schedules).toEqual([
      { cron: "*/5 * * * *" },
    ]);
  });

  it("refuses job, saying what to write", () => {
    expect(
      () => new Cron("MyCron", { job: handler, schedules } as any),
    ).toThrow(
      `"job" isn't an option for the "MyCron" cron job. Use "worker": "job" was its old name.`,
    );
  });

  it("refuses a worker that's an output, or missing", () => {
    expect(
      () => new Cron("MyCron", { worker: output(handler) as any, schedules }),
    ).toThrow(
      'The "worker" of the "MyCron" cron job has to be a plain value, not an output.',
    );
    expect(() => new Cron("Other", { schedules } as any)).toThrow(
      `The "Other" cron job is given no "worker": pass the path to the Worker's handler, or the Worker's args.`,
    );
    expect(
      () => new Cron("Third", { worker: { url: true } as any, schedules }),
    ).toThrow(
      `The "worker" of the "Third" cron job needs a "handler": pass the path to the Worker's handler, or the Worker's args with one.`,
    );
  });

  it("refuses an existing worker or trigger", () => {
    expect(
      () =>
        new Cron("MyCron", {
          worker: handler,
          schedules,
          existing: { trigger: "id" },
        }),
    ).toThrow(`"existing.trigger" isn't an option for the "MyCron" cron job.`);
  });
});
