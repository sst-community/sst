import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { mockPulumi, sidedClass } from "../../../helpers/graph";
import { applyErrors } from "../../../helpers/apply-errors";

const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
const DOMAIN = "cloudflare:index/workersCustomDomain:WorkersCustomDomain";
// The mock builds a worker into a file of this extension
const handler = "src/worker.mjs";

const pulumi = mockPulumi();

type WorkerClass =
  | typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker
  | typeof import("../../../../src/components/cloudflare/worker").Worker;

describe("Worker", () => {
  let Original: typeof import("../../../fixtures/v4/components/cloudflare/worker").Worker;
  let Worker: typeof import("../../../../src/components/cloudflare/worker").Worker;
  // SST 4's for SST 4's side, SST 5's for SST 5's
  let Kv: any;
  let Bucket: typeof import("../../../../src/components/aws/bucket").Bucket;
  let Secret: typeof import("../../../../src/components/secret").Secret;

  beforeAll(async () => {
    Original = (
      await import("../../../fixtures/v4/components/cloudflare/worker")
    ).Worker;
    Worker = (await import("../../../../src/components/cloudflare/worker"))
      .Worker;
    Kv = await sidedClass(
      "Kv",
      import("../../../fixtures/v4/components/cloudflare/kv"),
      import("../../../../src/components/cloudflare/kv"),
      import("../../../../src/components/cloudflare/takeover/kv"),
    );
    Bucket = (await import("../../../../src/components/aws/bucket")).Bucket;
    Secret = (await import("../../../../src/components/secret")).Secret;
    await import("../../../../src/components/cloudflare/takeover/index");
  });

  // Cloudflare's API, which a Worker with Durable Object migrations reads
  // its current migration tag from: none of its scripts are deployed
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
      String(url).startsWith("https://api.cloudflare.com/")
        ? new Response(JSON.stringify({ success: true, result: [] }))
        : realFetch(url, init)) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
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
  const bindingsOf = (name = "MyWorkerScript") =>
    resource(name).inputs.bindings as Record<string, any>[];

  // Each case deploys the 4.x Worker, then the same thing as the V5 one.
  // Everything the 4.x one created has to be kept by the V5 one, with the
  // same inputs. Its zone lookups go: 5.0 finds a zone with a function.
  describe("takes over a deployed Worker", () => {
    pulumi.takeoverCases<WorkerClass, WorkerClass>({
      original: () => Original,
      v5: () => Worker,
      provider: "cloudflare",
      // SST 4's Worker waited on everything in what it's linked to, from
      // reading its name. Its bindings wait on what they name, like a KV
      // namespace or another Worker's script, which is all Cloudflare needs.
      needlessOrder:
        /^MyWorkerScript before (Other|MyBucket)\w*(\.sst\.cloudflare\.\w+)?$/,
      check: () => expect(resource("MyWorkerScript").type).toBe(SCRIPT),
      cases: {
        "a worker": (Worker, opts) => {
          new Worker("MyWorker", { handler }, opts);
        },
        "a worker with its URL": (Worker, opts) => {
          new Worker("MyWorker", { handler, url: true }, opts);
        },
        "a worker transformed": (Worker, opts) => {
          new Worker(
            "MyWorker",
            {
              handler,
              compatibility: { date: "2025-09-01", flags: ["nodejs_als"] },
              transform: { worker: { logpush: true } },
            },
            opts,
          );
        },
        "a worker with environment variables and placement": (Worker, opts) => {
          new Worker(
            "MyWorker",
            {
              handler,
              environment: { MODE: "prod" },
              placement: { mode: "smart" },
            },
            opts,
          );
        },
        "a worker with Durable Object migrations": (Worker, opts) => {
          new Worker(
            "MyWorker",
            {
              handler,
              migrations: [{ tag: "v1", newSqliteClasses: ["Counter"] }],
            },
            opts,
          );
        },
        "a worker with a domain": (Worker, opts) => {
          new Worker("MyWorker", { handler, domain: "example.com" }, opts);
        },
        "a worker with aliases and redirects": (Worker, opts) => {
          new Worker(
            "MyWorker",
            {
              handler,
              domain: {
                name: "app.example.com",
                aliases: ["app.example.net", "app.example.org"],
                redirects: ["www.example.com", "example.net"],
              },
            },
            opts,
          );
        },
        "a worker linked to a KV namespace, a secret and another worker": (
          Worker,
          opts,
        ) => {
          const kv = new Kv("MyKv");
          const secret = new Secret("MySecret", "shh");
          const other = new Worker("Other", { handler }, opts);
          new Worker("MyWorker", { handler, link: [kv, secret, other] }, opts);
        },
        "a worker linked to an AWS bucket": (Worker, opts) => {
          const bucket = new Bucket("MyBucket");
          new Worker("MyWorker", { handler, link: [bucket] }, opts);
        },
      },
    });
  });

  // Once it's switched. On the switch itself, each is matched to the one
  // SST 4 had at its place in the list.
  it("keeps its aliases by their domains, not their places in the list", async () => {
    const aliases = ["app.example.net", "app.example.org"];
    const worker = (aliases: string[]) => () =>
      new Worker("MyWorker", {
        handler,
        domain: { name: "app.example.com", aliases },
      });
    const result = await pulumi.takesOver(
      worker(aliases),
      worker([...aliases].reverse()),
    );
    expect(result.unclaimed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("names a custom domain for each alias and redirect by its domain", async () => {
    new Worker("MyWorker", {
      handler,
      domain: {
        name: "app.example.com",
        aliases: ["app.example.net"],
        redirects: ["www.example.com"],
      },
    });
    await pulumi.settle();
    const hostnames = pulumi.resources
      .filter((r) => r.type === DOMAIN)
      .map((r) => r.inputs.hostname)
      .sort();
    expect(hostnames).toEqual(["app.example.com", "app.example.net"]);
    const rule = pulumi.resources.find(
      (r) => r.type === "cloudflare:index/pageRule:PageRule",
    )!;
    expect(rule.inputs).toMatchObject({
      target: "www.example.com/*",
      priority: 1,
      zoneId: "example-com-zone",
      actions: {
        forwardingUrl: { statusCode: 301, url: "https://app.example.com/$1" },
      },
    });
  });

  it("binds what it's linked to", async () => {
    const kv = new Kv("MyKv");
    new Worker("MyWorker", { handler, link: [kv], environment: { A: "1" } });
    await pulumi.settle();
    expect(bindingsOf().map((b) => [b.type, b.name])).toEqual([
      ["plain_text", "SST_RESOURCE_App"],
      ["kv_namespace", "MyKv"],
      ["plain_text", "A"],
    ]);
    expect(named("aws:iam/user:User")).toEqual([]);
  });

  it("calls AWS as a user of its own when it's linked to something in AWS", async () => {
    const bucket = new Bucket("MyBucket");
    new Worker("MyWorker", { handler, link: [bucket] });
    await pulumi.settle();
    expect(named("aws:iam/user:User")).toEqual(["MyWorkerAwsUser"]);
    expect(named("aws:iam/accessKey:AccessKey")).toEqual([
      "MyWorkerAwsCredentials",
    ]);
    const policy = JSON.parse(resource("MyWorkerAwsPolicy").inputs.policy);
    expect(policy.Statement[0].Effect).toBe("Allow");
    expect(bindingsOf().map((b) => b.name)).toContain("AWS_SECRET_ACCESS_KEY");
  });

  // A Worker inside a component can be linked to that component: its name is
  // read without waiting on the component, which waits on the Worker
  it("can be linked to the component it's in", async () => {
    const { component } = await import(
      "../../../../src/components/parts-component"
    );
    class Holder extends component("test:index:Holder", () => ({
      consumer: Worker,
    })) {
      constructor(name: string) {
        super(name, {});
        this.part("consumer", { handler, link: [this] });
      }
      link() {
        return { properties: { name: "holder" } };
      }
    }
    new Holder("MyHolder");
    await pulumi.settle();
    expect(
      bindingsOf("MyHolderConsumerScript").map((b) => b.name),
    ).toContainEqual("SST_RESOURCE_MyHolder");
  });

  // A domain given as a string is one custom domain, whatever it is
  it("takes a domain that's an output as the domain's name", async () => {
    const worker = new Worker("MyWorker", {
      handler,
      domain: output("app.example.com"),
    });
    await pulumi.settle();
    expect(named(DOMAIN)).toEqual(["MyWorkerDomain"]);
    expect(resource("MyWorkerDomain").inputs).toMatchObject({
      hostname: "app.example.com",
      zoneId: "example-com-zone",
    });
    expect(await new Promise((resolve) => worker.url.apply(resolve))).toBe(
      "https://app.example.com",
    );
  });

  // Its aliases and redirects each create resources
  it("refuses a domain object or a link list that's an output", async () => {
    const errors = await applyErrors(
      () =>
        new Worker("MyWorker", {
          handler,
          domain: output({ name: "app.example.com" }) as any,
        }),
      pulumi.settle,
    );
    expect(errors).toContainEqual(
      expect.stringContaining(
        `The "domain" of the "MyWorker" Worker is an output that isn't a domain's name. A domain given as an object has to be a plain value`,
      ),
    );
    expect(named(DOMAIN)).toEqual([]);
    expect(
      () => new Worker("Other", { handler, link: output([]) as any }),
    ).toThrow(/"link" of the "Other" Worker has to be a plain value/);
  });

  // It builds its code, so a script given by name would be used without it
  it("refuses whatever it's given in existing, saying what to do", () => {
    expect(
      () =>
        new Worker("MyWorker", {
          handler,
          existing: { worker: "my-script" },
        }),
    ).toThrow(
      `"existing.worker" isn't an option for the "MyWorker" Worker. A Worker builds its own code, so it can't use a script you have. To call another Worker of your app, link it.`,
    );
    expect(
      () =>
        new Worker("Other", {
          handler,
          domain: "app.example.com",
          existing: { domain: "domain-id" },
        }),
    ).toThrow(
      `"existing.domain" isn't an option for the "Other" Worker. A Worker creates it from its args. Change how it's created in "transform.domain".`,
    );
  });

  it("takes a placement that's an output", async () => {
    new Worker("MyWorker", {
      handler,
      placement: output({ region: "aws:us-east-1" }),
    });
    await pulumi.settle();
    expect(resource("MyWorkerPlacement").inputs).toMatchObject({
      region: "aws:us-east-1",
      scriptName: resource("MyWorkerScript").inputs.scriptName,
    });
    expect(resource("MyWorkerPlacement").inputs).not.toHaveProperty("mode");
  });

  it("tells sst dev to build it, and reports its handler", async () => {
    // @ts-ignore
    global.$dev = true;
    new Worker("MyWorker", { handler });
    await pulumi.settle();
    expect(pulumi.reportOf("MyWorker")).toMatchObject({
      function: { handler },
    });
    expect(pulumi.outputsOf("MyWorker")?._live).toMatchObject({
      functionID: "MyWorker",
      handler,
      runtime: "worker",
    });
  });
});
