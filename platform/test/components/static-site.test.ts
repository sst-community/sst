import fs from "fs";
import os from "os";
import path from "path";
import { describe, beforeAll, beforeEach, it, expect, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";

// The real OriginAccessControl is a dynamic provider backed by the CLI, which
// can't be serialized inside a Vitest worker thread.
vi.mock(
  "../../src/components/aws/providers/origin-access-control",
  async () => {
    const { CustomResource } = await import("@pulumi/pulumi");
    return {
      OriginAccessControl: class extends CustomResource {
        constructor(name: string, args: any, opts?: any) {
          super("sst:aws:OriginAccessControl", name, args, opts);
        }
      },
    };
  },
);

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = {
  name: "app",
  stage: "test",
};
// @ts-ignore
global.$dev = false;
global.$util = pulumi;

interface CreatedResource {
  type: string;
  name: string;
  inputs: any;
}

let createdResources: CreatedResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource: function (args: pulumi.runtime.MockResourceArgs) {
      createdResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
      });
      return {
        id: args.name + "_id",
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-east-1:123456789012:${args.name}`,
          bucketRegionalDomainName: `${args.name}.s3.us-east-1.amazonaws.com`,
        },
      };
    },
    call: function (args: pulumi.runtime.MockCallArgs) {
      if (args.token === "aws:index/getRegion:getRegion")
        return { name: "us-east-1", region: "us-east-1" };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

// Flush event loop to let Pulumi .apply() chains settle without wall-clock delays
async function settle() {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function findDistribution(siteName: string) {
  return createdResources.find(
    (r) =>
      r.type === "aws:cloudfront/distribution:Distribution" &&
      r.name.startsWith(siteName),
  )!;
}

describe("StaticSite", function () {
  let StaticSite: typeof import("./../../src/components/aws/static-site").StaticSite;
  let sitePath: string;

  beforeAll(async function () {
    StaticSite = (await import("./../../src/components/aws/static-site"))
      .StaticSite;
    sitePath = fs.mkdtempSync(path.join(os.tmpdir(), "sst-static-site-"));
    fs.writeFileSync(path.join(sitePath, "index.html"), "<h1>index</h1>");
    fs.writeFileSync(path.join(sitePath, "404.html"), "<h1>404</h1>");
  });

  beforeEach(function () {
    createdResources = [];
  });

  it("uses the assets bucket as the default origin", async () => {
    new StaticSite("Site", { path: sitePath, errorPage: "/404.html" });
    await settle();

    const { origins, customErrorResponses } = findDistribution("Site").inputs;
    expect(origins).toEqual([
      {
        originId: "default",
        domainName: "SiteAssetsBucket.s3.us-east-1.amazonaws.com",
        originAccessControlId: "SiteS3AccessControl_id",
      },
    ]);
    expect(customErrorResponses.map((r: any) => r.responsePagePath)).toEqual([
      "/404.html",
      "/404.html",
    ]);
  });

  it("creates one origin access control for a site with an error page", async () => {
    new StaticSite("OacSite", { path: sitePath, errorPage: "404.html" });
    await settle();

    expect(
      createdResources.filter((r) => r.type === "sst:aws:OriginAccessControl"),
    ).toHaveLength(1);
  });

  it("keeps the placeholder origin, and creates no access control, for a site without an error page", async () => {
    new StaticSite("PlainSite", { path: sitePath });
    await settle();

    const { origins, customErrorResponses } = findDistribution("PlainSite").inputs;
    expect(origins).toEqual([
      expect.objectContaining({
        originId: "default",
        domainName: "placeholder.sst.dev",
      }),
    ]);
    expect(origins[0].originAccessControlId).toBeUndefined();
    expect(customErrorResponses).toEqual([]);
    expect(
      createdResources.some((r) => r.type === "sst:aws:OriginAccessControl"),
    ).toBe(false);
  });

  it("gives transform.cdn a plain origins array when errorPage is a string", async () => {
    let origins: any;
    new StaticSite("TransformSite", {
      path: sitePath,
      errorPage: "404.html",
      transform: {
        cdn: (args: any) => {
          origins = args.origins;
        },
      },
    });
    new StaticSite("TransformPlain", {
      path: sitePath,
      transform: {
        cdn: (args: any) => {
          expect(Array.isArray(args.origins)).toBe(true);
        },
      },
    });
    await settle();

    expect(Array.isArray(origins)).toBe(true);
  });

  it("creates one access control when errorPage is an Output", async () => {
    new StaticSite("OutputSite", {
      path: sitePath,
      errorPage: pulumi.output("404.html"),
    });
    await settle();

    expect(
      createdResources.filter((r) => r.type === "sst:aws:OriginAccessControl"),
    ).toHaveLength(1);
    expect(findDistribution("OutputSite").inputs.origins[0].domainName).toBe(
      "OutputSiteAssetsBucket.s3.us-east-1.amazonaws.com",
    );
  });

  it("points the error page at the assets path", async () => {
    new StaticSite("PrefixedSite", {
      path: sitePath,
      errorPage: "404.html",
      assets: { path: "/web/" },
    });
    await settle();

    const { customErrorResponses } = findDistribution("PrefixedSite").inputs;
    expect(customErrorResponses.map((r: any) => r.responsePagePath)).toEqual([
      "/web/404.html",
      "/web/404.html",
    ]);
  });

  describe("with edgeRouting: false", () => {
    it("throws with a router", () => {
      expect(
        () =>
          new StaticSite("NoEdgeRouter", {
            path: sitePath,
            edgeRouting: false,
            router: { instance: {} as any },
          }),
      ).toThrow(/Cannot provide both "edgeRouting: false" and "router"/);
    });

    it("creates only the CloudFront URL block for a domain", async () => {
      new StaticSite("NoEdgeDomain", {
        path: sitePath,
        edgeRouting: false,
        domain: {
          name: "example.com",
          dns: false,
          cert: "arn:aws:acm:us-east-1:123456789012:certificate/mine",
        },
      });
      await settle();

      const fns = createdResources.filter(
        (r) => r.type === "aws:cloudfront/function:Function",
      );
      expect(fns).toHaveLength(1);
      expect(fns[0].inputs.code).toContain("cloudfront.net");
      expect(fns[0].inputs.code).not.toContain("kvs()");
      expect(fns[0].inputs.keyValueStoreAssociations).toEqual([]);
    });

    it("sets no origin path when the assets path is the root", async () => {
      new StaticSite("NoEdgeRootPath", {
        path: sitePath,
        edgeRouting: false,
        assets: { path: "/" },
      });
      await settle();

      expect(
        findDistribution("NoEdgeRootPath").inputs.origins[0].originPath,
      ).toBe("");
    });

    it("creates no KeyValueStore, keys or request function", async () => {
      new StaticSite("NoEdgeSite", { path: sitePath, edgeRouting: false });
      await settle();

      expect(
        createdResources.filter(
          (r) =>
            r.type === "aws:cloudfront/keyValueStore:KeyValueStore" ||
            r.type === "aws:cloudfront/function:Function" ||
            r.name.includes("KvKeys"),
        ),
      ).toEqual([]);
      expect(
        findDistribution("NoEdgeSite").inputs.defaultCacheBehavior
          .functionAssociations,
      ).toEqual([]);
    });

    it("serves a SPA from the assets bucket", async () => {
      new StaticSite("NoEdgeSpa", { path: sitePath, edgeRouting: false });
      await settle();

      const { origins, defaultRootObject, customErrorResponses } =
        findDistribution("NoEdgeSpa").inputs;
      expect(origins).toEqual([
        {
          originId: "default",
          domainName: "NoEdgeSpaAssetsBucket.s3.us-east-1.amazonaws.com",
          originAccessControlId: "NoEdgeSpaS3AccessControl_id",
        },
      ]);
      expect(defaultRootObject).toBe("index.html");
      expect(customErrorResponses).toEqual([
        {
          errorCode: 403,
          responseCode: 200,
          responsePagePath: "/index.html",
          errorCachingMinTtl: 0,
        },
        {
          errorCode: 404,
          responseCode: 200,
          responsePagePath: "/index.html",
          errorCachingMinTtl: 0,
        },
      ]);
    });

    it("serves the error page with a 404", async () => {
      new StaticSite("NoEdgeErrorPage", {
        path: sitePath,
        edgeRouting: false,
        errorPage: "404.html",
      });
      await settle();

      const { customErrorResponses } = findDistribution("NoEdgeErrorPage").inputs;
      expect(
        customErrorResponses.map((r: any) => [
          r.responseCode,
          r.responsePagePath,
        ]),
      ).toEqual([
        [404, "/404.html"],
        [404, "/404.html"],
      ]);
    });

    it("reads the assets path from the origin", async () => {
      new StaticSite("NoEdgePrefixed", {
        path: sitePath,
        edgeRouting: false,
        assets: { path: "/web/" },
      });
      await settle();

      const { origins, customErrorResponses } =
        findDistribution("NoEdgePrefixed").inputs;
      expect(origins[0].originPath).toBe("/web");
      expect(customErrorResponses[0].responsePagePath).toBe("/index.html");
    });

    it("creates a request function for the user's injection", async () => {
      new StaticSite("NoEdgeInjection", {
        path: sitePath,
        edgeRouting: false,
        edge: {
          viewerRequest: {
            // An Output, to check it's resolved, not stringified, into the code
            injection: pulumi.output(
              `event.request.headers["x-test"] = { value: "1" };`,
            ),
            kvStore: "arn:aws:cloudfront::123456789012:key-value-store/mine",
          },
        },
      });
      await settle();

      const fn = createdResources.find(
        (r) => r.type === "aws:cloudfront/function:Function",
      )!;
      expect(fn.inputs.code).toContain(`event.request.headers["x-test"]`);
      expect(fn.inputs.code).not.toContain("kvs()");
      expect(fn.inputs.keyValueStoreAssociations).toEqual([
        "arn:aws:cloudfront::123456789012:key-value-store/mine",
      ]);
    });
  });
});
