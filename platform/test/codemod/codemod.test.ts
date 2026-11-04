import path from "path";
import { describe, expect, it } from "vitest";
import { codemod, type Namespace } from "../../src/codemod";

// The codemod on an app whose files are given here, at /app
function run(files: Record<string, string>, namespace: Namespace = "v5") {
  return codemod({
    root: "/app",
    namespace,
    read: (file) =>
      files[path.relative("/app", file).split(path.sep).join("/")],
  });
}

// The config after the codemod, and what it said
function config(text: string, namespace: Namespace = "v5") {
  const result = run({ "sst.config.ts": text }, namespace);
  return {
    text: result.files.find((f) => f.file === "sst.config.ts")?.after ?? text,
    changes: result.changes.map((c) => c.message),
    notes: result.notes.map((n) => n.message),
  };
}

describe("names", () => {
  it("writes each component where its 5.0 form is", () => {
    expect(
      config(`new sst.aws.Function("Api", { handler: "a.handler" });`).text,
    ).toBe(`new sst.aws.v5.Function("Api", { handler: "a.handler" });`);
    // After the swap, SST 4's name is already the 5.0 one
    expect(
      config(`new sst.aws.Function("Api", { handler: "a.handler" });`, "").text,
    ).toBe(`new sst.aws.Function("Api", { handler: "a.handler" });`);
  });

  it("gives a renamed component its 5.0 name, and its types", () => {
    const out = config(
      `const api = new sst.aws.ApiGatewayV2("Api");\nconst a: sst.aws.ApiGatewayV2Args = {};\nnew sst.aws.CronV2("C", { function: "a.h", schedule: "rate(1 day)" });`,
    );
    expect(out.text).toBe(
      `const api = new sst.aws.v5.ApiGatewayHttp("Api");\nconst a: sst.aws.v5.ApiGatewayHttpArgs = {};\nnew sst.aws.v5.Cron("C", { function: "a.h", schedule: "rate(1 day)" });`,
    );
    expect(out.changes).toContain(
      "`sst.aws.ApiGatewayV2` is `sst.aws.v5.ApiGatewayHttp`",
    );
    expect(config(`new sst.aws.ApiGatewayV1("Api");`, "").text).toBe(
      `new sst.aws.ApiGatewayRest("Api");`,
    );
    expect(config(`new sst.cloudflare.StaticSiteV2("Site");`).text).toBe(
      `new sst.cloudflare.v5.StaticSite("Site");`,
    );
  });

  it("takes the alphas' v5 out of a name after the swap", () => {
    expect(
      config(
        `new sst.aws.v5.Queue("Q");\nnew sst.aws.v5.ApiGatewayV2("Api");`,
        "",
      ).text,
    ).toBe(`new sst.aws.Queue("Q");\nnew sst.aws.ApiGatewayHttp("Api");`);
  });

  it("names a component in $transform and in a type", () => {
    expect(config(`$transform(sst.aws.Function, (args) => {});`).text).toBe(
      `$transform(sst.aws.v5.Function, (args) => {});`,
    );
  });

  it("leaves what isn't a component", () => {
    const text = `sst.aws.permission({ actions: ["s3:*"], resources: ["*"] });\nsst.aws.dns();\nsst.aws.iamEdit;`;
    expect(config(text).text).toBe(text);
  });

  it("lists a component with no 5.0 form, and changes nothing of it", () => {
    for (const text of [
      `new sst.aws.Vector("V", { dimension: 1536 });`,
      `new sst.aws.OpenControl("C", {});`,
      `new sst.aws.Cron("C", { job: "a.handler", schedule: "rate(1 day)" });`,
      `new sst.aws.Vpc.v1("Net");`,
      `new sst.aws.Auth.v1("Auth", {});`,
      `new sst.cloudflare.Auth("Auth", {});`,
    ]) {
      const out = config(text);
      expect(out.text, text).toBe(text);
      expect(out.notes, text).toHaveLength(1);
    }
    expect(config(`new sst.aws.Vector("V", {});`).notes[0]).toContain(
      "vector database of their own",
    );
  });

  it("knows the 5.0 Cron by its function, after the swap", () => {
    const out = config(
      `new sst.aws.Cron("C", { function: "a.handler", schedule: "rate(1 day)" });`,
      "",
    );
    expect(out.notes).toEqual([]);
    expect(out.changes).toEqual([]);
  });

  it("renames sst.linkable", () => {
    expect(
      config(`sst.linkable(aws.s3.Bucket, (b) => ({ properties: {} }));`).text,
    ).toBe(`sst.Linkable.wrap(aws.s3.Bucket, (b) => ({ properties: {} }));`);
  });
});

describe("args", () => {
  it("moves a Function's role into existing", () => {
    expect(
      config(`new sst.aws.Function("F", { handler: "a.h", role: "arn:role" });`)
        .text,
    ).toBe(
      `new sst.aws.v5.Function("F", { handler: "a.h", existing: { role: "arn:role" } });`,
    );
  });

  it("puts two moves into one existing, and into one that's there", () => {
    const text = [
      `new sst.aws.Function("F", {`,
      `  handler: "a.h",`,
      `  role: role.arn,`,
      `  logging: { logGroup: "/my/logs", retention: "1 week" },`,
      `});`,
    ].join("\n");
    expect(config(text).text).toBe(
      [
        `new sst.aws.v5.Function("F", {`,
        `  handler: "a.h",`,
        `  existing: { role: role.arn, logGroup: "/my/logs" },`,
        `  logging: { retention: "1 week" },`,
        `});`,
      ].join("\n"),
    );
    expect(
      config(
        `new sst.aws.Task("T", { cluster, existing: { taskDefinition: td }, taskRole: "a", executionRole: "b" });`,
      ).text,
    ).toBe(
      `new sst.aws.v5.Task("T", { cluster, existing: { taskRole: "a", executionRole: "b", taskDefinition: td } });`,
    );
  });

  it("renames a Function's live and url.route", () => {
    expect(
      config(
        `new sst.aws.Function("F", { handler: "a.h", live: false, url: { route: { router } } });`,
      ).text,
    ).toBe(
      `new sst.aws.v5.Function("F", { handler: "a.h", dev: false, url: { router: { instance: router } } });`,
    );
  });

  it("renames CronV2's job, and nodes.job wherever the cron is read", () => {
    const out = run({
      "sst.config.ts": [
        `export default $config({`,
        `  async run() {`,
        `    const { cron } = await import("./infra/cron");`,
        `    cron.nodes.job.name;`,
        `  },`,
        `});`,
      ].join("\n"),
      "infra/cron.ts": `export const cron = new sst.aws.CronV2("Cron", { job: "a.handler", schedule: "rate(1 day)" });`,
    });
    const files = Object.fromEntries(out.files.map((f) => [f.file, f.after]));
    expect(files["infra/cron.ts"]).toBe(
      `export const cron = new sst.aws.v5.Cron("Cron", { function: "a.handler", schedule: "rate(1 day)" });`,
    );
    expect(files["sst.config.ts"]).toContain(`cron.nodes.function.name;`);
  });

  it("moves Redis's nodes into cluster, or drops it where SST 4 ignored it", () => {
    expect(config(`new sst.aws.Redis("R", { vpc, nodes: 2 });`).text).toBe(
      `new sst.aws.v5.Redis("R", { vpc, cluster: { nodes: 2 } });`,
    );
    expect(
      config(
        `new sst.aws.Redis("R", { vpc, cluster: { nodes: 3 }, nodes: 2 });`,
      ).text,
    ).toBe(`new sst.aws.v5.Redis("R", { vpc, cluster: { nodes: 3 } });`);
    // The alphas had it too
    expect(config(`new sst.aws.v5.Redis("R", { vpc, nodes: 2 });`).text).toBe(
      `new sst.aws.v5.Redis("R", { vpc, cluster: { nodes: 2 } });`,
    );
  });

  it("changes a Bucket's public and its public access block", () => {
    expect(config(`new sst.aws.Bucket("B", { public: true });`).text).toBe(
      `new sst.aws.v5.Bucket("B", { access: "public" });`,
    );
    expect(
      config(
        `new sst.aws.Bucket("B", { transform: { publicAccessBlock: false } });`,
      ).text,
    ).toBe(`new sst.aws.v5.Bucket("B", { publicAccessBlock: false, });`);
    // Cloudflare's Bucket isn't AWS's
    expect(
      config(`new sst.cloudflare.Bucket("B", { public: true });`).text,
    ).toBe(`new sst.cloudflare.v5.Bucket("B", { public: true });`);
  });

  it("tells an Email that signs with its own key that its DKIM records are its own", () => {
    expect(
      config(
        `new sst.aws.Email("E", { sender: "a.com", transform: { identity: { dkimSigningAttributes: { domainSigningPrivateKey: k, domainSigningSelector: "s" } } } });`,
      ).text,
    ).toMatch(/^new sst\.aws\.v5\.Email\("E", \{ dkim: false, sender/);
  });

  it("changes Cloudflare's Kv id, D1's get and Cron's job", () => {
    const out = config(
      `const kv = new sst.cloudflare.Kv("K");\nkv.id;\nsst.cloudflare.D1.get("Db", "abc");\nnew sst.cloudflare.Cron("C", { job: "w.ts", schedules: [] });`,
    );
    expect(out.text).toBe(
      `const kv = new sst.cloudflare.v5.Kv("K");\nkv.namespaceId;\nsst.cloudflare.v5.D1.get("Db", { databaseId: "abc" });\nnew sst.cloudflare.v5.Cron("C", { worker: "w.ts", schedules: [] });`,
    );
  });

  it("changes nothing a second time", () => {
    const first = config(
      `new sst.aws.Function("F", { handler: "a.h", role: "r" });\nnew sst.aws.ApiGatewayV2("Api");`,
      "",
    );
    const second = config(first.text, "");
    expect(second.changes).toEqual([]);
    expect(second.text).toBe(first.text);
  });
});

describe("more args", () => {
  it("applies a function's changes where another component is given its args", () => {
    expect(
      config(
        `queue.subscribe({ handler: "a.h", role: "r", live: true });\nconst queue = new sst.aws.Queue("Q");`,
      ).text,
    ).toBe(
      `queue.subscribe({ handler: "a.h", existing: { role: "r" } });\nconst queue = new sst.aws.v5.Queue("Q");`,
    );
    // Not in a 5.0 component's call, nor twice in a Function inside one
    expect(
      config(
        `new sst.aws.v5.Queue("Q").subscribe({ handler: "a.h", role: "r" });`,
      ).text,
    ).toContain(`role: "r"`);
    expect(
      config(
        `new sst.aws.Cron("C", { function: new sst.aws.Function("F", { handler: "a.h", role: "r" }), schedule: "rate(1 day)" });`,
        "",
      ).text,
    ).toBe(
      `new sst.aws.Cron("C", { function: new sst.aws.Function("F", { handler: "a.h", existing: { role: "r" } }), schedule: "rate(1 day)" });`,
    );
  });

  it("drops a logging left empty by its log group", () => {
    expect(
      config(
        `new sst.aws.Function("F", {\n  handler: "a.h",\n  logging: { logGroup: "/l" },\n});`,
      ).text,
    ).toBe(
      `new sst.aws.v5.Function("F", {\n  existing: { logGroup: "/l" },\n  handler: "a.h",\n});`,
    );
  });

  it("gives an API its domain by existing, and drops what SST 4 ignored next to nameId", () => {
    const out = config(
      `new sst.aws.ApiGatewayWebSocket("Ws", {\n  domain: { nameId: "api.a.com", dns: false },\n});`,
    );
    expect(out.text).toBe(
      `new sst.aws.v5.ApiGatewayWebSocket("Ws", {\n  existing: { domainName: "api.a.com" },\n});`,
    );
    expect(out.changes.some((c) => c.includes("`domain.dns` is removed"))).toBe(
      true,
    );
  });

  it("moves an API's transform.route.handler", () => {
    expect(
      config(
        `new sst.aws.ApiGatewayV2("Api", { transform: { route: { handler: { memory: "1 GB" } } } });`,
      ).text,
    ).toBe(
      `new sst.aws.v5.ApiGatewayHttp("Api", { transform: { handler: { memory: "1 GB" }, } });`,
    );
  });

  it("changes a site's route, cdn and what its router took that SST 4 ignored", () => {
    expect(
      config(
        `new sst.aws.Nextjs("Web", { route: { router, path: "/docs" }, cdn: true });`,
      ).text,
    ).toBe(
      `new sst.aws.v5.Nextjs("Web", { router: { instance: router, path: "/docs" } });`,
    );
    const out = config(
      `new sst.aws.Astro("Web", { router: { instance: router, rewrite: { regex: "^/a", to: "/" } } });`,
    );
    expect(out.text).toBe(
      `new sst.aws.v5.Astro("Web", { router: { instance: router } });`,
    );
    expect(
      config(`new sst.aws.Astro("Web", { cdn: false });`).notes,
    ).toHaveLength(1);
  });

  it("gives a WebSocket API's addAuthorizer one object, without what it ignored", () => {
    expect(
      config(
        `const ws = new sst.aws.ApiGatewayWebSocket("Ws");\nws.addAuthorizer("Auth", { lambda: { function: "a.h", payload: "2.0" } });`,
      ).text,
    ).toBe(
      `const ws = new sst.aws.v5.ApiGatewayWebSocket("Ws");\nws.addAuthorizer({ name: "Auth", lambda: { function: "a.h" } });`,
    );
  });

  it("puts a REST route's streaming on its function", () => {
    expect(
      config(
        `const api = new sst.aws.ApiGatewayV1("Api");\napi.route("GET /", "a.h", { streaming: true });`,
      ).text,
    ).toBe(
      `const api = new sst.aws.v5.ApiGatewayRest("Api");\napi.route("GET /", { handler: "a.h", streaming: true }, { });`,
    );
  });

  it("makes a static subscribe a method of what get gives", () => {
    expect(config(`sst.aws.Bus.subscribe("Sub", "arn:bus", "a.h");`).text).toBe(
      `sst.aws.v5.Bus.get("SubBus", "arn:bus").subscribe("Sub", "a.h");`,
    );
    expect(
      config(
        `sst.aws.Queue.subscribe(queueArn, "a.h", { batch: { size: 5 } });`,
      ).text,
    ).toBe(
      `sst.aws.v5.Queue.get("SubscribedQueue", queueArn).subscribe("a.h", { batch: { size: 5 } });`,
    );
  });

  it("makes a cluster's addService a Service, with its provider", () => {
    expect(
      config(
        `const cluster = new sst.aws.Cluster("C", { vpc }, { provider: east });\ncluster.addService("Web", { image: "nginx" });`,
      ).text,
    ).toBe(
      `const cluster = new sst.aws.v5.Cluster("C", { vpc }, { provider: east });\nnew sst.aws.v5.Service("Web", { cluster: cluster, image: "nginx" }, { provider: east });`,
    );
  });

  it("renames an Alb's nodes.listeners, and moves a Nextjs revalidation subscriber's transform", () => {
    expect(
      config(`const alb = new sst.aws.Alb("A", { vpc });\nalb.nodes.listeners;`)
        .text,
    ).toBe(
      `const alb = new sst.aws.v5.Alb("A", { vpc });\nalb.nodes.listener;`,
    );
    expect(
      config(
        `new sst.aws.Nextjs("Web", { transform: { revalidationEventsSubscriber: { memory: "1 GB" } } });`,
      ).text,
    ).toBe(
      `new sst.aws.v5.Nextjs("Web", { transform: { revalidationQueue: { transform: { subscriber: { memory: "1 GB" } } } } });`,
    );
  });

  it("renames DevCommand, and Cloudflare's experimental names", () => {
    expect(
      config(`new sst.x.DevCommand("Studio", { dev: { command: "x" } });`).text,
    ).toBe(`new sst.x.v5.DevCommand("Studio", { dev: { command: "x" } });`);
    expect(
      config(
        `new sst.cloudflare.x.Astro("Web");\nnew sst.cloudflare.x.StaticSite("Docs");`,
      ).text,
    ).toBe(
      `new sst.cloudflare.v5.Astro("Web");\nnew sst.cloudflare.v5.StaticSite("Docs");`,
    );
    expect(
      config(`new sst.cloudflare.x.SolidStart("Web");`).notes,
    ).toHaveLength(1);
  });
});
