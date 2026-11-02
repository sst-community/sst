import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../helpers/graph";

// What isn't known until a resource is created, as Pulumi marks it on the wire
const UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

const maps = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-maps-"));
const SOURCEMAPS = ["index.mjs.map", "chunk.mjs.map"].map((file) => {
  fs.writeFileSync(path.join(maps, file), "{}");
  return path.join(maps, file);
});

// A new stage's preview: everything is about to be created, so of each
// resource only what it was given is known, and nothing AWS gives back
const pulumi = mockPulumi({
  preview: true,
  state: (args) =>
    Object.fromEntries(
      [
        "arn",
        "base64",
        "bucket",
        "name",
        "invokeArn",
        "qualifiedArn",
        "version",
      ]
        .filter((key) => !(key in args.inputs))
        .map((key) => [key, UNKNOWN]),
    ),
  sourcemaps: () => SOURCEMAPS,
});

describe("a function in a new stage's preview", () => {
  it("plans everything a deploy creates", async () => {
    const { Function } = await import(
      "../../../src/components/aws/v5/function"
    );
    const { Bucket } = await import("../../../src/components/aws/v5/bucket");
    const files = new Bucket("Files");
    new Function("Api", { handler: "src/api.handler", link: [files] });
    await pulumi.settle();

    const inApi = pulumi.resources
      .filter((r) => r.parent.endsWith("::sst:aws:Function::Api"))
      .map((r) => r.name)
      .sort();
    // What a deploy creates. The build waits for the key and the links, which
    // aren't known yet, so the preview learns from a build without them.
    expect(inApi).toEqual([
      "ApiCode",
      "ApiFunction",
      "ApiLogGroup",
      "ApiRole",
      "ApiSourcemap0",
      "ApiSourcemap1",
    ]);
    const fn = pulumi.resources.find((r) => r.name === "ApiFunction")!;
    expect(fn.inputs.handler).toEqual(expect.any(String));
    expect(fn.inputs.handler).not.toBe(UNKNOWN);
  });

  // Who may call the URL depends on whether the router signs its requests,
  // which its settings say. Its distribution isn't created yet.
  it("plans who may call its URL behind a router", async () => {
    pulumi.reset();
    const { Function } = await import(
      "../../../src/components/aws/v5/function"
    );
    const { Router } = await import("../../../src/components/aws/router");
    const { Bucket } = await import("../../../src/components/aws/v5/bucket");
    const signs = new Router("Signs", { protection: "oac" });
    const open = new Router("Open");
    // A route field that's only known once something else is created
    const files = new Bucket("Files");
    new Function("Signed", {
      handler: "src/api.handler",
      url: {
        router: { instance: signs, path: files.arn.apply(() => "/api") },
      },
    });
    new Function("Public", {
      handler: "src/api.handler",
      url: { router: { instance: open, path: "/api" } },
    });
    await pulumi.settle();

    const access = (name: string) =>
      pulumi.resources
        .filter((r) => r.name.startsWith(`${name}Url`))
        .map((r) => [r.name, r.inputs.principal, r.inputs.sourceArn]);
    expect(access("Signed")).toEqual([
      ["SignedUrl", undefined, undefined],
      ["SignedUrlAccess", "cloudfront.amazonaws.com", UNKNOWN],
      ["SignedUrlInvoke", "cloudfront.amazonaws.com", UNKNOWN],
    ]);
    expect(access("Public")).toEqual([
      ["PublicUrl", undefined, undefined],
      ["PublicUrlAccess", "*", undefined],
      ["PublicUrlInvoke", "*", undefined],
    ]);
  });

  it("plans who may call its URL behind a V5 router, which says plainly whether it signs", async () => {
    pulumi.reset();
    const { Function } = await import(
      "../../../src/components/aws/v5/function"
    );
    const { Router } = await import("../../../src/components/aws/v5/router");
    const signs = new Router("Signs", { protection: "oac-with-edge-signing" });
    const open = new Router("Open", { domain: "example.com" });
    new Function("Signed", {
      handler: "src/api.handler",
      url: { router: { instance: signs, path: "/api" } },
    });
    new Function("Public", {
      handler: "src/api.handler",
      url: { router: { instance: open, path: "/api" } },
    });
    await pulumi.settle();

    const access = (name: string) =>
      pulumi.resources
        .filter((r) => r.name.startsWith(`${name}Url`))
        .map((r) => [r.name, r.inputs.principal, r.inputs.sourceArn]);
    expect(access("Signed")).toEqual([
      ["SignedUrl", undefined, undefined],
      ["SignedUrlAccess", "cloudfront.amazonaws.com", UNKNOWN],
      ["SignedUrlInvoke", "cloudfront.amazonaws.com", UNKNOWN],
    ]);
    expect(access("Public")).toEqual([
      ["PublicUrl", undefined, undefined],
      ["PublicUrlAccess", "*", undefined],
      ["PublicUrlInvoke", "*", undefined],
    ]);
    // The router's own parts are planned too
    const router = (name: string) =>
      pulumi.resources
        .filter((r) => r.name.startsWith(name) && r.type.startsWith("aws:"))
        .map((r) => r.name)
        .sort();
    expect(router("Signs")).toEqual([
      "SignsCdnDistribution",
      "SignsCloudfrontFunctionRequest",
      "SignsEdgeFunction",
      "SignsEdgeFunctionRole",
      "SignsKvStore",
      "SignsServerCachePolicy",
    ]);
    // Not yet the domain's DNS records, or the certificate's: the DNS
    // adapters create them inside an `apply`, until they're built the 5.0 way
    expect(router("Open")).toEqual(
      expect.arrayContaining([
        "OpenCdnDistribution",
        "OpenCdnSslCertificate",
        "OpenCdnSslValidation",
      ]),
    );
  });
});
