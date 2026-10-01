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
    expect(typeof sst.aws.v5.Function).toBe("function");
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
    expect(resource("DocsBucket").parent).toMatch(/acme:Uploads::Docs$/);
    // An output is whatever the resource was given, or made from its name
    expect(await app.resolve(uploads.name)).toMatch(/^acme-dev-docsbucket-/);
    expect(await app.resolve(uploads.nodes.bucket.arn)).toBe(
      "arn:aws:mock:us-east-1:123456789012:DocsBucket",
    );
  });

  it("gives a linked function the component's permissions", async () => {
    const uploads = new Uploads("Docs", { teams: [] });
    new sst.aws.v5.Function("Api", {
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

  it("deploys a function's stub in sst dev", async () => {
    (globalThis as any).$dev = true;
    try {
      new sst.aws.v5.Function("Api", {
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
      });
    });

    it("passes when the part keeps its name", async () => {
      const deployed = await deploy(() => new Uploads("Docs", { teams: [] }));

      app.reset();
      new Kept("Docs");
      await app.settle();
      expect(app.takeover(deployed)).toEqual({ unclaimed: [], changed: [] });
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
  });
});
