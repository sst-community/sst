import path from "path";
import { describe, expect, it } from "vitest";
import { codemod } from "../../src/codemod";

// The codemod on an app whose files are given here, at /app
function run(files: Record<string, string>) {
  return codemod({
    root: "/app",
    read: (file) =>
      files[path.relative("/app", file).split(path.sep).join("/")],
  });
}

// The config after the codemod, and what it said
function config(text: string) {
  const result = run({ "sst.config.ts": text });
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
    ).toBe(`new sst.aws.Function("Api", { handler: "a.handler" });`);
    // After the swap, SST 4's name is already the 5.0 one
    expect(
      config(`new sst.aws.Function("Api", { handler: "a.handler" });`).text,
    ).toBe(`new sst.aws.Function("Api", { handler: "a.handler" });`);
  });

  // The v5 alphas let a config pick a group's components by it
  it("writes a group's `v5` as the group, where SST 5's components are", () => {
    const out = config(
      `const aws = v5 ? sst.aws.v5 : sst.aws;\nconst cf = sst.cloudflare.v5;\ntype C = typeof sst.aws.v5;\nnew sst.aws.v5.Queue("Q");\nsst.aws.v5["Bucket"];`,
    );
    expect(out.text).toBe(
      `const aws = v5 ? sst.aws : sst.aws;\nconst cf = sst.cloudflare;\ntype C = typeof sst.aws;\nnew sst.aws.Queue("Q");\nsst.aws["Bucket"];`,
    );
    expect(out.changes).toContain("`sst.aws.v5` is `sst.aws`, where SST 5's components are");
    // Not anything else's `v5`
    const other = `const a = x.aws.v5;\nconst b = sst.x.v5;\nconst c = sst.aws.Vpc.v5;`;
    expect(config(other).text).toBe(other);
    // Once written, a second run changes nothing
    expect(config(out.text).changes).toEqual([]);
  });

  // A group passed in as an argument, which the codemod can't follow
  it("leaves a note for a renamed component it can't trace to SST's", () => {
    const out = config(
      `export function api(aws: any) {\n  new aws.ApiGatewayV2("Api");\n  new aws.CronV2("Tick", {});\n  new aws.Queue("Q");\n  new acme.StaticSiteV2("Web");\n}`,
    );
    expect(out.text).toBe(
      `export function api(aws: any) {\n  new aws.ApiGatewayV2("Api");\n  new aws.CronV2("Tick", {});\n  new aws.Queue("Q");\n  new acme.StaticSiteV2("Web");\n}`,
    );
    expect(out.notes).toEqual([
      "If this is SST's `ApiGatewayV2`, it's `sst.aws.ApiGatewayHttp` in SST 5: the codemod can't tell what `aws` holds, so rename it by hand",
      "If this is SST's `CronV2`, it's `sst.aws.Cron` in SST 5: the codemod can't tell what `aws` holds, so rename it by hand",
      "If this is SST's `StaticSiteV2`, it's `sst.cloudflare.StaticSite` in SST 5: the codemod can't tell what `acme` holds, so rename it by hand",
    ]);
    // SST's own, traced, is renamed and gets no note
    const traced = config(`new sst.aws.ApiGatewayV2("Api");`);
    expect(traced.text).toBe(`new sst.aws.ApiGatewayHttp("Api");`);
    expect(traced.notes).toEqual([]);
  });

  it("gives a renamed component its 5.0 name, and its types", () => {
    const out = config(
      `const api = new sst.aws.ApiGatewayV2("Api");\nconst a: sst.aws.ApiGatewayV2Args = {};\nnew sst.aws.CronV2("C", { function: "a.h", schedule: "rate(1 day)" });`,
    );
    expect(out.text).toBe(
      `const api = new sst.aws.ApiGatewayHttp("Api");\nconst a: sst.aws.ApiGatewayHttpArgs = {};\nnew sst.aws.Cron("C", { function: "a.h", schedule: "rate(1 day)" });`,
    );
    expect(out.changes).toContain(
      "`sst.aws.ApiGatewayV2` is `sst.aws.ApiGatewayHttp`",
    );
    expect(config(`new sst.aws.ApiGatewayV1("Api");`).text).toBe(
      `new sst.aws.ApiGatewayRest("Api");`,
    );
    expect(config(`new sst.cloudflare.StaticSiteV2("Site");`).text).toBe(
      `new sst.cloudflare.StaticSite("Site");`,
    );
  });

  it("takes the alphas' v5 out of a name after the swap", () => {
    expect(
      config(`new sst.aws.v5.Queue("Q");\nnew sst.aws.v5.ApiGatewayV2("Api");`)
        .text,
    ).toBe(`new sst.aws.Queue("Q");\nnew sst.aws.ApiGatewayHttp("Api");`);
  });

  it("names a component in $transform and in a type", () => {
    expect(config(`$transform(sst.aws.Function, (args) => {});`).text).toBe(
      `$transform(sst.aws.Function, (args) => {});`,
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
      `new sst.aws.Function("F", { handler: "a.h", existing: { role: "arn:role" } });`,
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
        `new sst.aws.Function("F", {`,
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
      `new sst.aws.Task("T", { cluster, existing: { taskRole: "a", executionRole: "b", taskDefinition: td } });`,
    );
  });

  it("renames a Function's live and url.route", () => {
    expect(
      config(
        `new sst.aws.Function("F", { handler: "a.h", live: false, url: { route: { router } } });`,
      ).text,
    ).toBe(
      `new sst.aws.Function("F", { handler: "a.h", dev: false, url: { router: { instance: router } } });`,
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
      `export const cron = new sst.aws.Cron("Cron", { function: "a.handler", schedule: "rate(1 day)" });`,
    );
    expect(files["sst.config.ts"]).toContain(`cron.nodes.function.name;`);
  });

  it("moves Redis's nodes into cluster, or drops it where SST 4 ignored it", () => {
    expect(config(`new sst.aws.Redis("R", { vpc, nodes: 2 });`).text).toBe(
      `new sst.aws.Redis("R", { vpc, cluster: { nodes: 2 } });`,
    );
    expect(
      config(
        `new sst.aws.Redis("R", { vpc, cluster: { nodes: 3 }, nodes: 2 });`,
      ).text,
    ).toBe(`new sst.aws.Redis("R", { vpc, cluster: { nodes: 3 } });`);
    // The alphas had it too
    expect(config(`new sst.aws.v5.Redis("R", { vpc, nodes: 2 });`).text).toBe(
      `new sst.aws.Redis("R", { vpc, cluster: { nodes: 2 } });`,
    );
  });

  it("changes a Bucket's public and its public access block", () => {
    expect(config(`new sst.aws.Bucket("B", { public: true });`).text).toBe(
      `new sst.aws.Bucket("B", { access: "public" });`,
    );
    expect(
      config(
        `new sst.aws.Bucket("B", { transform: { publicAccessBlock: false } });`,
      ).text,
    ).toBe(`new sst.aws.Bucket("B", { publicAccessBlock: false, });`);
    // Cloudflare's Bucket isn't AWS's
    expect(
      config(`new sst.cloudflare.Bucket("B", { public: true });`).text,
    ).toBe(`new sst.cloudflare.Bucket("B", { public: true });`);
  });

  it("tells an Email that signs with its own key that its DKIM records are its own", () => {
    expect(
      config(
        `new sst.aws.Email("E", { sender: "a.com", transform: { identity: { dkimSigningAttributes: { domainSigningPrivateKey: k, domainSigningSelector: "s" } } } });`,
      ).text,
    ).toMatch(/^new sst\.aws\.Email\("E", \{ dkim: false, sender/);
  });

  it("changes Cloudflare's Kv id, D1's get and Cron's job", () => {
    const out = config(
      `const kv = new sst.cloudflare.Kv("K");\nkv.id;\nsst.cloudflare.D1.get("Db", "abc");\nnew sst.cloudflare.Cron("C", { job: "w.ts", schedules: [] });`,
    );
    expect(out.text).toBe(
      `const kv = new sst.cloudflare.Kv("K");\nkv.namespaceId;\nsst.cloudflare.D1.get("Db", { databaseId: "abc" });\nnew sst.cloudflare.Cron("C", { worker: "w.ts", schedules: [] });`,
    );
  });

  it("changes nothing a second time", () => {
    const first = config(
      `new sst.aws.Function("F", { handler: "a.h", role: "r" });\nnew sst.aws.ApiGatewayV2("Api");`,
    );
    const second = config(first.text);
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
      `queue.subscribe({ handler: "a.h", existing: { role: "r" } });\nconst queue = new sst.aws.Queue("Q");`,
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
      `new sst.aws.Function("F", {\n  existing: { logGroup: "/l" },\n  handler: "a.h",\n});`,
    );
  });

  it("gives an API its domain by existing, and drops what SST 4 ignored next to nameId", () => {
    const out = config(
      `new sst.aws.ApiGatewayWebSocket("Ws", {\n  domain: { nameId: "api.a.com", dns: false },\n});`,
    );
    expect(out.text).toBe(
      `new sst.aws.ApiGatewayWebSocket("Ws", {\n  existing: { domainName: "api.a.com" },\n});`,
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
      `new sst.aws.ApiGatewayHttp("Api", { transform: { handler: { memory: "1 GB" }, } });`,
    );
  });

  it("changes a site's route, cdn and what its router took that SST 4 ignored", () => {
    expect(
      config(
        `new sst.aws.Nextjs("Web", { route: { router, path: "/docs" }, cdn: true });`,
      ).text,
    ).toBe(
      `new sst.aws.Nextjs("Web", { router: { instance: router, path: "/docs" } });`,
    );
    const out = config(
      `new sst.aws.Astro("Web", { router: { instance: router, rewrite: { regex: "^/a", to: "/" } } });`,
    );
    expect(out.text).toBe(
      `new sst.aws.Astro("Web", { router: { instance: router } });`,
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
      `const ws = new sst.aws.ApiGatewayWebSocket("Ws");\nws.addAuthorizer({ name: "Auth", lambda: { function: "a.h" } });`,
    );
  });

  it("puts a REST route's streaming on its function", () => {
    expect(
      config(
        `const api = new sst.aws.ApiGatewayV1("Api");\napi.route("GET /", "a.h", { streaming: true });`,
      ).text,
    ).toBe(
      `const api = new sst.aws.ApiGatewayRest("Api");\napi.route("GET /", { handler: "a.h", streaming: true }, { });`,
    );
  });

  it("makes a static subscribe a method of what get gives", () => {
    expect(config(`sst.aws.Bus.subscribe("Sub", "arn:bus", "a.h");`).text).toBe(
      `sst.aws.Bus.get("SubBus", "arn:bus").subscribe("Sub", "a.h");`,
    );
    expect(
      config(
        `sst.aws.Queue.subscribe(queueArn, "a.h", { batch: { size: 5 } });`,
      ).text,
    ).toBe(
      `sst.aws.Queue.get("SubscribedQueue", queueArn).subscribe("a.h", { batch: { size: 5 } });`,
    );
  });

  it("makes a cluster's addService a Service, with its provider", () => {
    expect(
      config(
        `const cluster = new sst.aws.Cluster("C", { vpc }, { provider: east });\ncluster.addService("Web", { image: "nginx" });`,
      ).text,
    ).toBe(
      `const cluster = new sst.aws.Cluster("C", { vpc }, { provider: east });\nnew sst.aws.Service("Web", { cluster, image: "nginx" }, { provider: east });`,
    );
    // Args written one to a line get the cluster on a line of its own
    expect(
      config(
        `const c = new sst.aws.Cluster("C", { vpc });\nc.addService("Web", {\n  image: "nginx",\n});`,
      ).text,
    ).toBe(
      `const c = new sst.aws.Cluster("C", { vpc });\nnew sst.aws.Service("Web", {\n  cluster: c,\n  image: "nginx",\n});`,
    );
  });

  it("renames an Alb's nodes.listeners, and moves a Nextjs revalidation subscriber's transform", () => {
    expect(
      config(`const alb = new sst.aws.Alb("A", { vpc });\nalb.nodes.listeners;`)
        .text,
    ).toBe(`const alb = new sst.aws.Alb("A", { vpc });\nalb.nodes.listener;`);
    expect(
      config(
        `new sst.aws.Nextjs("Web", { transform: { revalidationEventsSubscriber: { memory: "1 GB" } } });`,
      ).text,
    ).toBe(
      `new sst.aws.Nextjs("Web", { transform: { revalidationQueue: { transform: { subscriber: { memory: "1 GB" } } } } });`,
    );
  });

  it("renames DevCommand, and Cloudflare's experimental names", () => {
    expect(
      config(`new sst.x.DevCommand("Studio", { dev: { command: "x" } });`).text,
    ).toBe(`new sst.x.DevCommand("Studio", { dev: { command: "x" } });`);
    expect(
      config(
        `new sst.cloudflare.x.Astro("Web");\nnew sst.cloudflare.x.StaticSite("Docs");`,
      ).text,
    ).toBe(
      `new sst.cloudflare.Astro("Web");\nnew sst.cloudflare.StaticSite("Docs");`,
    );
    expect(
      config(`new sst.cloudflare.x.SolidStart("Web");`).notes,
    ).toHaveLength(1);
  });
});

describe("services, sites and nodes", () => {
  it("makes a Service's public its loadBalancer, ports its rules and a rule's path a condition", () => {
    const out = config(
      `new sst.aws.Service("Web", { cluster, public: { domain: "a.com", ports: [{ listen: "80/http", path: "/api/*" }, { listen: "443/https", forward: "80/http", conditions: { header: h } , path: "/x" }] } });`,
    );
    expect(out.text).toBe(
      `new sst.aws.Service("Web", { cluster, loadBalancer: { domain: "a.com", rules: [{ listen: "80/http", conditions: { path: "/api/*" } }, { listen: "443/https", forward: "80/http", conditions: { path: "/x", header: h } }] } });`,
    );
    expect(out.notes).toEqual([]);
  });

  it("drops what's set for one container next to containers, and permissions next to a role of your own", () => {
    const out = config(
      `new sst.aws.Service("Web", {\n  cluster,\n  image: "nginx",\n  health: { command: ["x"] },\n  containers: [{ name: "a", image: "a" }],\n  dev: { command: "npm run dev", url: "http://localhost:3000" },\n});\nnew sst.aws.Task("Job", { cluster, taskRole: "my-role", permissions: [{ actions: ["s3:*"], resources: ["*"] }] });`,
    );
    expect(out.text).toBe(
      `new sst.aws.Service("Web", {\n  cluster,\n  containers: [{ name: "a", image: "a" }],\n  dev: { url: "http://localhost:3000" },\n});\nnew sst.aws.Task("Job", { cluster, existing: { taskRole: "my-role" } });`,
    );
    expect(out.changes.filter((c) => c.includes("next to"))).toHaveLength(4);
  });

  it("changes a StaticSite's route and its KV stores, and a Router's", () => {
    const out = config(
      `new sst.aws.StaticSite("Web", { route: { router, path: "/docs" }, cdn: true, edge: { viewerRequest: { injection: "x", kvStores: [a] }, viewerResponse: { injection: "y", kvStores: [b, c] } } });\nnew sst.aws.Router("R", { edge: { viewerRequest: { injection: "x", kvStore: a, kvStores: [a] } } });`,
    );
    expect(out.text).toBe(
      `new sst.aws.StaticSite("Web", { router: { instance: router, path: "/docs" }, edge: { viewerRequest: { injection: "x" }, viewerResponse: { injection: "y", kvStore: b } } });\nnew sst.aws.Router("R", { edge: { viewerRequest: { injection: "x", kvStore: a } } });`,
    );
    expect(
      config(`new sst.aws.Router("R", { routes: { "/*": "https://a.com" } });`)
        .notes,
    ).toHaveLength(1);
  });

  it("gives a Workflow's transform.function to the function's transform, with its role", () => {
    expect(
      config(
        `new sst.aws.Workflow("W", { handler: "a.h", role: role.arn, transform: { function: { function: { timeout: 30 } } } });`,
      ).text,
    ).toBe(
      `new sst.aws.Workflow("W", { handler: "a.h", transform: { function: { transform: { function: { timeout: 30 } }, existing: { role: role.arn } } } });`,
    );
    expect(
      config(`new sst.aws.Workflow("W", { handler: "a.h", role: "r" });`).text,
    ).toBe(
      `new sst.aws.Workflow("W", { handler: "a.h", transform: { function: { existing: { role: "r" } } } });`,
    );
  });

  it("reads a Vpc's records where SST 4 had lists, and a Cloudflare Cron's script on its Worker", () => {
    expect(
      config(
        `const vpc = new sst.aws.Vpc("V");\nf(vpc.nodes.privateSubnets);\nvpc.nodes.publicSubnets[1].id;\nvpc.nodes.natGateways.apply((n) => n.length);`,
      ).text,
    ).toBe(
      `const vpc = new sst.aws.Vpc("V");\nf(Object.values(vpc.nodes.privateSubnet));\nvpc.nodes.publicSubnet["2"].id;\n$output(Object.values(vpc.nodes.natGateway)).apply((n) => n.length);`,
    );
    expect(
      config(
        `const cron = new sst.cloudflare.Cron("C", { job: "a.ts", schedules: ["* * * * *"] });\ncron.nodes.worker.id;\ncron.nodes.worker.url;`,
      ).text,
    ).toBe(
      `const cron = new sst.cloudflare.Cron("C", { worker: "a.ts", schedules: ["* * * * *"] });\ncron.nodes.worker.nodes.worker.id;\ncron.nodes.worker.url;`,
    );
  });

  it("reads a site's nodes.server as SST 4's, or leaves a note where it's empty while the config runs", () => {
    // A site whose build may have no server has each region from the start,
    // as `undefined` when there's none, as SST 4's was
    for (const site of ["Astro", "React"])
      expect(
        config(`const web = new sst.aws.${site}("Web");\nf(web.nodes.server);`)
          .text,
        site,
      ).toBe(
        `const web = new sst.aws.${site}("Web");\nf(Object.values(web.nodes.server)[0]);`,
      );
    const west = `const web = new sst.aws.Nextjs("Web", {}, { provider: west });\nf(web.nodes.server);`;
    expect(config(west).text).toBe(west);
    expect(config(west).notes).toEqual([
      expect.stringMatching(
        /With a provider of its own, .*set the site's `regions`/,
      ),
    ]);
    // With its regions, it's listed from the start
    expect(
      config(
        `const web = new sst.aws.Nextjs("Web", { regions: ["us-west-2"] }, { provider: west });\nf(web.nodes.server);`,
      ).text,
    ).toContain("f(Object.values(web.nodes.server)[0]);");
    // An optional chain keeps giving `undefined` without the site
    expect(
      config(`const web = new sst.aws.Nextjs("Web");\nf(web?.nodes.server);`)
        .text,
    ).toContain("f(Object.values(web?.nodes.server ?? {})[0]);");
    // ...and is left as it is a second time
    const once = config(
      `const web = new sst.aws.Nextjs("Web");\nf(web?.nodes.server);`,
    ).text;
    expect(config(once)).toMatchObject({ text: once, changes: [] });
    // A provider the codemod can't rule out: options in a variable, a
    // provider by name, or a parent's
    for (const opts of [
      "opts",
      "{ providers: { aws: west } }",
      "{ parent: app }",
    ]) {
      const text = `const web = new sst.aws.Nextjs("Web", {}, ${opts});\nf(web.nodes.server);`;
      const out = config(text);
      expect(out.text, opts).toBe(text);
      expect(out.notes, opts).toEqual([
        expect.stringMatching(
          /from its options or a parent, the site's region is read in the deploy/,
        ),
      ]);
    }
    // Read by key, or destructured: a note
    const read = config(
      `const web = new sst.aws.Nextjs("Web");\nf(web.nodes["server"]);\nconst { server } = web.nodes;`,
    );
    expect(read.changes).toEqual([]);
    expect(read.notes).toEqual([
      expect.stringMatching(
        /^`Nextjs`'s `nodes.server` is a record by region, and SST 4's was the first region's: read/,
      ),
      expect.stringMatching(
        /^`Nextjs`'s `nodes.server` is a record by region, and SST 4's was the first region's: read/,
      ),
    ]);
  });

  it("keeps an apply on nodes read by key, and notes what it can't rewrite", () => {
    const out = config(
      `const fn = new sst.aws.Function("F", { handler: "a.handler" });\nfn.nodes["function"].apply((f) => f.name);\nfn?.nodes.function.apply((f) => f.name);\nconst { function: lambda, role } = fn.nodes;\nconst router = new sst.aws.Router("R");\nrouter.nodes.cdn.apply((cdn) => cdn.nodes.distribution.apply((d) => d.arn));`,
    );
    expect(out.text).toContain(
      `$output(fn.nodes["function"]).apply((f) => f.name);`,
    );
    // Left as it is, with a note each
    expect(out.text).toContain(`fn?.nodes.function.apply((f) => f.name);`);
    expect(out.text).toContain(
      `$output(router.nodes.cdn).apply((cdn) => cdn.nodes.distribution.apply((d) => d.arn));`,
    );
    expect(out.notes).toEqual([
      "`Function`'s `nodes.function` is the resource, not an output of it, so it has no `apply`: read it directly, or wrap it in `$output()` where it's set",
      "`Function`'s `nodes.function` is the resource, not an output of it: an `apply` on one needs `$output()`",
      "If this is one of SST's components, its `nodes.distribution` may be the resource, not an output of it, so it has no `apply`: read it directly, or wrap it in `$output()`",
    ]);
  });

  it("keeps an apply on what nodes gives as the resource now, and reads a site's server by region", () => {
    expect(
      config(
        `const router = new sst.aws.Router("R");\nrouter.nodes.cdn.apply((cdn) => cdn.nodes.distribution.arn);\nrouter.nodes.cdn.nodes.distribution;\nconst fn = new sst.aws.Function("F", { handler: "a.handler" });\nfn.nodes.function.apply((f) => f.name);\nfn.nodes.function.name;`,
      ),
    ).toEqual({
      text: `const router = new sst.aws.Router("R");\n$output(router.nodes.cdn).apply((cdn) => cdn.nodes.distribution.arn);\nrouter.nodes.cdn.nodes.distribution;\nconst fn = new sst.aws.Function("F", { handler: "a.handler" });\n$output(fn.nodes.function).apply((f) => f.name);\nfn.nodes.function.name;`,
      changes: [
        "`Router`'s `nodes.cdn` is the resource, not an output of it: `$output()` keeps `apply` working",
        "`Function`'s `nodes.function` is the resource, not an output of it: `$output()` keeps `apply` working",
      ],
      notes: [],
    });
    // What's still an output, as a `Cron`'s function, is left as it is
    const cron = `const cron = new sst.aws.CronV2("C", { function: "a.handler", schedule: "rate(1 day)" });\ncron.nodes.function.apply((f) => f.name);`;
    expect(config(cron).text).toContain(
      `\ncron.nodes.function.apply((f) => f.name);`,
    );

    expect(
      config(
        `const web = new sst.aws.Nextjs("Web");\nweb.nodes.server.apply((s) => s?.name);\nf(web.nodes.server);\nweb.nodes.server["us-east-1"];`,
      ).text,
    ).toBe(
      `const web = new sst.aws.Nextjs("Web");\nObject.values(web.nodes.server)[0].apply((s) => s?.name);\nf(Object.values(web.nodes.server)[0]);\nweb.nodes.server["us-east-1"];`,
    );
  });

  it("changes nothing a second time", () => {
    for (const text of [
      `new sst.aws.Service("Web", { cluster, public: { ports: [{ listen: "80/http", path: "/a" }] }, image: "x", containers: [] });`,
      `new sst.aws.StaticSite("Web", { edge: { viewerResponse: { injection: "y", kvStores: [b] } } });`,
      `new sst.aws.Workflow("W", { handler: "a.h", role: "r", transform: { function: { role: x } } });`,
      `const vpc = new sst.aws.Vpc("V");\nvpc.nodes.privateSubnets[0];`,
      `const c = new sst.cloudflare.Cron("C", { worker: "a.ts" });\nc.nodes.worker.id;`,
      `const r = new sst.aws.Router("R");\nr.nodes.cdn.apply((c) => c.urn);`,
      `const web = new sst.aws.Nextjs("Web");\nf(web.nodes.server);`,
    ]) {
      const once = config(text).text;
      expect(once).not.toBe(text);
      const twice = config(once);
      expect(twice.text, text).toBe(once);
      expect(twice.changes, text).toEqual([]);
    }
  });
});

describe("what a method gave", () => {
  it("reads its nodes on the component, by its id", () => {
    const out = config(
      `const bus = new sst.aws.Bus("Bus");\nconst sub = bus.subscribe("Sub", "a.handler");\nlink(sub.nodes.function);\nconst api = new sst.aws.ApiGatewayV2("Api");\nconst r = api.route("get /notes", "b.handler");\nr.nodes.integration.id;\nconst a = api.addAuthorizer({ name: "Auth", jwt: {} });\na.nodes.authorizer.id;\nconst q = new sst.aws.Queue("Q");\nconst s = q.subscribe("c.handler");\ns.nodes.function.name;`,
    );
    expect(out.text).toBe(
      `const bus = new sst.aws.Bus("Bus");\nconst sub = bus.subscribe("Sub", "a.handler");\nlink(bus.nodes.subscriber["Sub"]);\nconst api = new sst.aws.ApiGatewayHttp("Api");\nconst r = api.route("get /notes", "b.handler");\napi.nodes.integration["GET /notes"].id;\nconst a = api.addAuthorizer({ name: "Auth", jwt: {} });\na.id;\nconst q = new sst.aws.Queue("Q");\nconst s = q.subscribe("c.handler");\nq.nodes.subscriber.name;`,
    );
    expect(out.notes).toEqual([]);
  });

  it("lists a read whose id it can't write there", () => {
    const out = config(
      `const bus = new sst.aws.Bus("Bus");\nfunction f(n: string) { return bus.subscribe(n, "a.handler"); }\nconst api = new sst.aws.ApiGatewayV2("Api");\nconst r = api.route(route, "b.handler");\nr.nodes.route;`,
    );
    expect(out.text).toContain("r.nodes.route;");
    expect(out.notes).toHaveLength(1);
  });

  it("gives a Realtime subscriber's nodes by the id it's named with", () => {
    const out = config(
      `const rt = new sst.aws.Realtime("Rt", { authorizer: "auth.handler" });\nconst s = rt.subscribe("sub.handler", { filter: "chat/#" });\ns.nodes.rule.arn;`,
    );
    expect(out.text).toMatch(/rt\.nodes\.topicRule\["[A-Z][a-z]{5}"\]\.arn;$/);
  });

  it("puts a sub-item's own transform in the component's, for its id", () => {
    const out = config(
      `const api = new sst.aws.ApiGatewayV2("Api", { cors: true });\napi.route("GET /a", "a.handler", { transform: { route: { authorizationType: "NONE" } } });\napi.route("POST /b", "b.handler", { transform: { route: (args) => { args.operationName = "b"; } } });`,
    );
    expect(out.text).toBe(
      `const api = new sst.aws.ApiGatewayHttp("Api", { transform: { route: (args_, opts, name, id) => { if (id === "GET /a") Object.assign(args_, { authorizationType: "NONE" }); if (id === "POST /b") ((args) => { args.operationName = "b"; })(args_, opts, name); } }, cors: true });\napi.route("GET /a", "a.handler");\napi.route("POST /b", "b.handler");`,
    );
  });

  it("keeps a WebSocket authorizer's args when it gives it its name, and lists an API's transform.route.args", () => {
    const out = config(
      `const ws = new sst.aws.ApiGatewayWebSocket("Ws");\nws.addAuthorizer("Auth", { transform: { authorizer: { name: "x" } } });\nnew sst.aws.ApiGatewayV2("Api", { transform: { route: { args: { auth: { iam: true } } } } });`,
    );
    expect(out.text).toBe(
      `const ws = new sst.aws.ApiGatewayWebSocket("Ws", { transform: { authorizer: (args, opts, name, id) => { if (id === "Auth") Object.assign(args, { name: "x" }); } } });\nws.addAuthorizer({ name: "Auth", });\nnew sst.aws.ApiGatewayHttp("Api", { transform: { route: { args: { auth: { iam: true } } } } });`,
    );
    expect(out.notes).toHaveLength(1);
  });

  it("puts a single part's transform there as it is, and lists what it can't move", () => {
    expect(
      config(
        `const q = new sst.aws.Queue("Q");\nq.subscribe("a.handler", { batch: { size: 5 }, transform: { function: { memory: "1 GB" }, eventSourceMapping: (a) => {} } });`,
      ).text,
    ).toBe(
      `const q = new sst.aws.Queue("Q", { transform: { subscriber: { memory: "1 GB" }, eventSourceMapping: (a) => {} } });\nq.subscribe("a.handler", { batch: { size: 5 } });`,
    );
    const out = config(
      `const topic = new sst.aws.SnsTopic("T", { transform: { subscription: {} } });\ntopic.subscribe("S", "a.handler", { transform: { subscription: { rawMessageDelivery: true } } });`,
    );
    expect(out.text).toContain(
      `{ transform: { subscription: { rawMessageDelivery: true } } }`,
    );
    expect(out.notes).toHaveLength(1);
  });

  it("makes a Bucket's subscribe a notification, and its static subscribeEventBridge the bucket's", () => {
    const out = config(
      `const bucket = new sst.aws.Bucket("B");\nbucket.subscribe({ handler: "a.handler", live: false }, { events: ["s3:ObjectCreated:*"], transform: { notification: { eventbridge: false } } });\nsst.aws.Bucket.subscribeEventBridge("Resize", bucket.name, "r.handler", { pattern: {}, transform: { rule: { state: "ENABLED" } } });\nsst.aws.Bucket.subscribeEventBridge("Other", "their-bucket", "o.handler");`,
    );
    expect(out.text).toBe(
      `const bucket = new sst.aws.Bucket("B", { transform: { notification: { eventbridge: false }, eventBridgeRule: (args, opts, name, id) => { if (id === "Resize") Object.assign(args, { state: "ENABLED" }); } } });\nbucket.notify({ notifications: [{ name: "Subscriber", function: { handler: "a.handler", dev: false }, events: ["s3:ObjectCreated:*"] }] });\nbucket.subscribeEventBridge("Resize", "r.handler", { pattern: {} });\nsst.aws.Bucket.get("OtherBucket", "their-bucket").subscribeEventBridge("Other", "o.handler");`,
    );
    expect(out.notes).toEqual([]);
  });

  it("changes nothing a second time", () => {
    for (const text of [
      `const bus = new sst.aws.Bus("Bus");\nconst sub = bus.subscribe("Sub", "a.handler", { transform: { rule: { name: "x" } } });\nsub.nodes.rule;`,
      `const bucket = new sst.aws.Bucket("B");\nbucket.subscribeQueue(queue.arn, { filterPrefix: "a/" });`,
    ]) {
      const once = config(text).text;
      expect(once).not.toBe(text);
      const twice = config(once);
      expect(twice.text, text).toBe(once);
      expect(twice.changes, text).toEqual([]);
    }
  });
});

describe("a site's server.edge", () => {
  it("moves it to the top level, where SST 4 took it", () => {
    expect(
      config(
        `new sst.aws.Nextjs("Web", { server: { memory: "1 GB", edge: { viewerRequest: { injection: "x" } } } });\nnew sst.aws.Astro("A", { server: { edge: e } });`,
      ).text,
    ).toBe(
      `new sst.aws.Nextjs("Web", { edge: { viewerRequest: { injection: "x" } }, server: { memory: "1 GB" } });\nnew sst.aws.Astro("A", { edge: e, });`,
    );
  });
});

describe("subscribers without a name", () => {
  it("lists one 5.0 doesn't keep, and rewrites one with a name", () => {
    const out = config(
      `const topic = new sst.aws.SnsTopic("T");\ntopic.subscribe("a.handler", { filter: {} });\ntopic.subscribe("Named", "a.handler");\ntopic.subscribeQueue("Q", queue);\nsst.aws.SnsTopic.subscribe(arn, "b.handler");\nsst.aws.SnsTopic.subscribe("Other", arn, "b.handler");`,
    );
    expect(out.text).toBe(
      `const topic = new sst.aws.SnsTopic("T");\ntopic.subscribe("a.handler", { filter: {} });\ntopic.subscribe("Named", "a.handler");\ntopic.subscribeQueue("Q", queue);\nsst.aws.SnsTopic.subscribe(arn, "b.handler");\nsst.aws.SnsTopic.get("OtherTopic", arn).subscribe("Other", "b.handler");`,
    );
    // The first and the static one with no name; `queue` can't be told apart
    expect(out.notes).toHaveLength(3);
  });

  it("gives SST 4's Queue.subscribe options to get", () => {
    expect(
      config(
        `sst.aws.Queue.subscribe(arn, "a.handler", { batch: { size: 1 } }, { provider: east });`,
      ).text,
    ).toBe(
      `sst.aws.Queue.get("SubscribedQueue", arn, { provider: east }).subscribe("a.handler", { batch: { size: 1 } });`,
    );
  });
});
