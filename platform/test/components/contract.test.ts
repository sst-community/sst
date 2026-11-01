import { readFileSync } from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import { output } from "@pulumi/pulumi";
import { mockPulumi } from "../helpers/graph";

const pulumi = mockPulumi({ app: "shop", stage: "dev" });

type Module = typeof import("../../src/components/parts-component");
type Contract = typeof import("../../src/components/contract");

// The program contract, as a component in a package uses it: what it reports
// is in the record the core reads, and it never names an output.
describe("The program contract", () => {
  let component: Module["component"];
  let context: Contract["context"];

  beforeAll(async () => {
    ({ component } = await import("../../src/components/parts-component"));
    ({ context } = await import("../../src/components/contract"));
  });

  beforeEach(() => pulumi.reset());

  // Something to link to
  function defineStore() {
    const parts = { bucket: aws.s3.Bucket };
    return class Store extends component("acme:index:Store", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
      }
      link() {
        return { properties: { name: this.nodes.bucket.bucket } };
      }
    };
  }

  it("gives the program the context", () => {
    expect(context()).toMatchObject({
      contract: 1,
      app: { name: "shop", stage: "dev" },
      dev: false,
      command: "deploy",
      versions: {},
    });
    expect(context().paths.root).toBe("/");
    expect(context().target).toBeUndefined();
  });

  it("gives the program its stage's target", () => {
    const app = (globalThis as any).$app;
    const emulator = { name: "emulator", endpoint: "http://127.0.0.1:4566" };
    app.targets = { dev: emulator, other: { name: "other" } };
    try {
      expect(context().target).toEqual(emulator);
    } finally {
      delete app.targets;
    }
  });

  // The record the core's test reads (pkg/project/report_test.go), so the two
  // sides agree on it
  const record = JSON.parse(
    readFileSync(
      path.join(__dirname, "../../../testdata/contract/report-v1.json"),
      "utf8",
    ),
  );

  it("reports what the core reads, with the contract's version", async () => {
    const Store = defineStore();
    const store = new Store("Docs");
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        const bucket = this.part("bucket", {});
        this.report({
          function: { handler: "src/server.handler", dev: true },
          dev: {
            command: "npm run dev",
            directory: "web",
            link: [store],
            environment: { MODE: "local" },
          },
          task: { command: "node seed.js", directory: "scripts" },
          tunnel: {
            ip: "10.0.0.1",
            username: "ec2-user",
            privateKey: "key",
            subnets: ["10.0.0.0/16"],
          },
          hint: bucket.bucket.apply((b) => `https://${b}.example.com`),
        });
      }
    }
    new Site("Web");
    await pulumi.settle();

    expect(pulumi.outputsOf("Web")).toEqual({ _sst: record });
  });

  it("adds the record to the outputs the component registers", async () => {
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
        this.report({ hint: "https://old.example.com" });
        this.report({ dev: { command: "npm run dev", autostart: false } });
        // given again, it replaces the first
        this.report({ hint: "https://example.com" });
        this.registerOutputs({ url: "https://example.com" });
      }
    }
    new Site("Web");
    await pulumi.settle();

    expect(pulumi.outputsOf("Web")).toEqual({
      url: "https://example.com",
      _sst: {
        contract: 1,
        hint: "https://example.com",
        dev: { command: "npm run dev", autostart: false, links: [] },
      },
    });
  });

  it("writes no record when nothing is reported", async () => {
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        this.part("bucket", {});
        this.report({ hint: undefined });
      }
    }
    new Site("Web");
    await pulumi.settle();

    expect(pulumi.outputsOf("Web")).toEqual({});
  });

  it("says when it's told something SST doesn't read", () => {
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        this.report({ functions: { handler: "index.handler" } } as any);
      }
    }
    expect(() => new Site("Web")).toThrow(
      'The "Web" component (acme.index.Site) reported "functions", which SST doesn\'t read. It reads "function", "dev", "task", "tunnel", "hint".',
    );
  });

  // As one Output, a secret anywhere in the outputs would hide the report
  it("says when the outputs it registers are one Output", () => {
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        this.report({ hint: "https://example.com" });
        this.registerOutputs(output({ url: "https://example.com" }));
      }
    }
    expect(() => new Site("Web")).toThrow(
      'The "Web" component (acme.index.Site) reported to SST, and registers its outputs as one Output. Pass registerOutputs() an object, with an Output for each value that needs one.',
    );
  });

  it("says when a report comes after the outputs are registered", () => {
    const parts = { bucket: aws.s3.Bucket };
    class Site extends component("acme:index:Site", parts) {
      constructor(name: string) {
        super(name);
        this.registerOutputs({});
        this.report({ hint: "https://example.com" });
      }
    }
    expect(() => new Site("Web")).toThrow(
      'The "Web" component (acme.index.Site) reported to SST after it registered its outputs. Call report() before registerOutputs(), in its constructor.',
    );
  });
});
