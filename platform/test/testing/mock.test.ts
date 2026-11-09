import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { mock } from "../../src/testing";

// What an app's own test does: mock, then load the file with its component
const app = await mock({ app: "acme", stage: "dev" });
const { Uploads, Renamed, Kept } = await import("./uploads");

describe("mock()", () => {
  beforeEach(() => app.reset());

  const names = () => app.resources.map((r) => r.name).sort();
  const resource = (name: string) =>
    app.resources.find((r) => r.name === name)!;

  it("gives a test the globals a config has", () => {
    expect($app).toMatchObject({ name: "acme", stage: "dev" });
    expect($dev).toBe(false);
    expect(typeof sst.component).toBe("function");
    expect(typeof sst.aws.Function).toBe("function");
    expect((globalThis as any).aws.s3.Bucket.name).toBe("Bucket");
    expect((globalThis as any).cloudflare.R2Bucket.name).toBe("R2Bucket");
    for (const name of [
      "$output",
      "$resolve",
      "$interpolate",
      "$concat",
      "$jsonParse",
      "$jsonStringify",
      "$transform",
      "$asset",
    ])
      expect(typeof (globalThis as any)[name], name).toBe("function");
    expect($cli.paths.root).toBe(process.cwd());
  });

  it("records what a component creates, and what it was created with", async () => {
    const uploads = new Uploads("Docs", {
      teams: ["design", "legal"],
      transform: { bucket: { tags: { team: "storage" } } },
    });
    await app.settle();

    expect(names()).toEqual([
      "Docs",
      "DocsBucket",
      "DocsReaderDesign",
      "DocsReaderLegal",
    ]);
    expect(resource("DocsBucket")).toMatchObject({
      type: "aws:s3/bucket:Bucket",
      inputs: {
        // Named for the app and the stage
        bucket: expect.stringMatching(/^acme-dev-docsbucket-/),
        forceDestroy: true,
        tags: { team: "storage" },
      },
    });
    expect(resource("DocsBucket").parent).toMatch(/acme:index:Uploads::Docs$/);
    // An output is whatever the resource was given, or made from its name
    expect(await app.resolve(uploads.name)).toMatch(/^acme-dev-docsbucket-/);
    expect(await app.resolve(uploads.nodes.bucket.arn)).toBe(
      "arn:aws:mock:us-east-1:123456789012:DocsBucket",
    );
  });

  it("gives a linked function the component's permissions", async () => {
    const uploads = new Uploads("Docs", { teams: [] });
    new sst.aws.Function("Api", {
      handler: "src/api.handler",
      link: [uploads],
    });
    await app.settle();

    const policy = resource("ApiRole").inputs.inlinePolicies[0].policy;
    expect(JSON.parse(policy).statements).toContainEqual({
      effect: "Allow",
      actions: ["s3:GetObject"],
      resources: ["arn:aws:mock:us-east-1:123456789012:DocsBucket/*"],
    });
  });

  // A function's links go into its code, so they're in no resource's inputs
  it("records what a function's code is built from", async () => {
    const uploads = new Uploads("Docs", { teams: [] });
    new sst.aws.Function("Api", {
      handler: "src/api.handler",
      link: [uploads],
    });
    await app.settle();

    const { build } = app.graph().find((r) => r.name === "Api" && !r.custom)!;
    expect(build!.handler).toBe("src/api.handler");
    expect(Object.keys(build!.links)).toEqual(["Docs"]);
    expect(build!.links.Docs.name).toMatch(/^acme-dev-docsbucket-/);
  });

  it("deploys a function's stub in sst dev", async () => {
    (globalThis as any).$dev = true;
    try {
      new sst.aws.Function("Api", {
        handler: "src/api.handler",
        runtime: "nodejs22.x",
      });
      await app.settle();
      expect(resource("ApiFunction").inputs).toMatchObject({
        description: "live",
        runtime: "provided.al2023",
      });
    } finally {
      (globalThis as any).$dev = false;
    }
  });

  // An email's DKIM records are made from what SES answers, so a package's
  // test of a component with an `Email` needs no state of its own for it
  it("gives an email's domain the DKIM tokens SES would", async () => {
    new sst.aws.Email("Mail", { sender: "example.com" });
    await app.settle();
    const dkim = app.resources
      .filter((r) => r.inputs.type === "CNAME")
      .map((r) => r.inputs.name)
      .sort();
    expect(dkim).toEqual([
      "tokena._domainkey.example.com",
      "tokenb._domainkey.example.com",
      "tokenc._domainkey.example.com",
    ]);
  });

  // What's recorded can be saved, and a later version of the component
  // checked against it: what a deploy would remove, and what it would update
  describe("checks a change against what's deployed", () => {
    const deploy = async (create: () => unknown) => {
      app.reset();
      create();
      await app.settle();
      // As it would be read back from a file
      return JSON.parse(JSON.stringify(app.graph()));
    };

    it("says what a renamed part would remove", async () => {
      const deployed = await deploy(() => new Uploads("Docs", { teams: [] }));

      app.reset();
      new Renamed("Docs");
      await app.settle();
      expect(app.takeover(deployed)).toEqual({
        unclaimed: ["aws:s3/bucket:Bucket::DocsBucket"],
        changed: [],
        unordered: [],
        revealed: [],
      });
    });

    it("passes when the part keeps its name", async () => {
      const deployed = await deploy(() => new Uploads("Docs", { teams: [] }));

      app.reset();
      new Kept("Docs");
      await app.settle();
      expect(app.takeover(deployed)).toEqual({ unclaimed: [], changed: [], unordered: [], revealed: [] });
    });

    it("says which inputs changed", async () => {
      const deployed = await deploy(() => new Uploads("Docs", { teams: ["a"] }));

      app.reset();
      new Uploads("Docs", {
        teams: ["a"],
        transform: { reader: { maxSessionDuration: 7200 } },
      });
      await app.settle();
      const { unclaimed, changed } = app.takeover(deployed);
      expect(unclaimed).toEqual([]);
      expect(changed.map((c) => [c.name, c.fields])).toEqual([
        ["DocsReaderA", ["maxSessionDuration"]],
      ]);
    });

    it("says where a value that was secret is in plain text now", async () => {
      const aws = (globalThis as any).aws as typeof import("@pulumi/aws");
      const create = (secret: (value: string) => any) => () => {
        new aws.iam.Role("Role", {
          assumeRolePolicy: "{}",
          description: secret("hunter2"),
        });
        new aws.lambda.Function("Fn", {
          role: "role",
          environment: {
            variables: { A: $util.secret("a"), B: secret("b") },
          },
        });
        new Holder("Holder", secret("hunter2"));
      };
      const deployed = await deploy(create($util.secret));

      app.reset();
      create((value) => value)();
      await app.settle();
      // A deploy updates nothing for it, but the state holds it in plain
      // text from then on
      expect(app.takeover(deployed)).toEqual({
        unclaimed: [],
        changed: [],
        unordered: [],
        revealed: [
          "Fn.environment.variables.B",
          "Holder.outputs.token",
          "Role.description",
        ],
      });
    });

    it("compares a file by what was in it when it was registered", async () => {
      const aws = (globalThis as any).aws as typeof import("@pulumi/aws");
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sst-mock-"));
      const page = (file: string) => () =>
        new aws.s3.BucketObjectv2("Page", {
          bucket: "site",
          key: "index.html",
          source: new $util.asset.FileAsset(path.join(folder, file)),
        });
      fs.writeFileSync(path.join(folder, "one.html"), "one");
      const deployed = await deploy(page("one.html"));

      // The same file, written again by the next build
      fs.writeFileSync(path.join(folder, "one.html"), "two");
      app.reset();
      page("one.html")();
      await app.settle();
      expect(
        app.takeover(deployed).changed.map((c) => [c.name, c.fields]),
      ).toEqual([["Page", ["source"]]]);

      // What was deployed, at another path
      fs.writeFileSync(path.join(folder, "other.html"), "one");
      app.reset();
      page("other.html")();
      await app.settle();
      expect(app.takeover(deployed).changed).toEqual([]);
    });

    it("says when what a function is built from changed", async () => {
      const api = (link: boolean) => () => {
        const uploads = new Uploads("Docs", { teams: [] });
        new sst.aws.Function("Api", {
          handler: "src/api.handler",
          link: link ? [uploads] : [],
        });
      };
      const deployed = await deploy(api(true));

      app.reset();
      api(false)();
      await app.settle();
      const { changed } = app.takeover(deployed);
      expect(changed.map((c) => [c.name, c.fields])).toContainEqual([
        "Api",
        ["build"],
      ]);
    });
  });
});

// A component that registers what it's given as its outputs
class Holder extends $util.ComponentResource {
  constructor(name: string, token: $util.Input<string>) {
    super("acme:index:Holder", name);
    this.registerOutputs({ token });
  }
}

describe("settle()", () => {
  beforeEach(() => app.reset());
  const { ComponentResource } = require("@pulumi/pulumi") as typeof import("@pulumi/pulumi");

  it("waits for a component's outputs, which resolve a while after anything else", async () => {
    const { output } = require("@pulumi/pulumi") as typeof import("@pulumi/pulumi");
    class Late extends ComponentResource {
      constructor(name: string) {
        super("acme:index:Late", name, {});
        // Pulumi registers them once they've resolved
        const later = new Promise((done) => setTimeout(() => done(true), 150));
        this.registerOutputs({ done: output(later) });
      }
    }
    new Late("Late");
    await app.settle();
    expect(app.outputsOf("Late")).toEqual({ done: true });
  });

  it("stops waiting soon for one whose outputs never come", async () => {
    const { output } = require("@pulumi/pulumi") as typeof import("@pulumi/pulumi");
    class Stuck extends ComponentResource {
      constructor(name: string) {
        super("acme:index:Stuck", name, {});
        this.registerOutputs({ never: output(new Promise(() => {})) });
      }
    }
    new Stuck("Stuck");
    const started = Date.now();
    await app.settle();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
