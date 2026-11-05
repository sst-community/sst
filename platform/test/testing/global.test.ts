import { describe, expect, it } from "vitest";
import { notInstalled, sstGlobal } from "../../src/testing/global";

// A provider the app hasn't installed
const missing = "@sst-test/not-installed";

describe("sstGlobal()", () => {
  it("has the core and every group whose providers are installed", async () => {
    const sst: any = await sstGlobal({ aws: ["@pulumi/aws"] });
    expect(typeof sst.component).toBe("function");
    expect(typeof sst.Linkable).toBe("function");
    expect(typeof sst.aws.Function).toBe("function");
    expect(typeof sst.cloudflare.Worker).toBe("function");
  });

  it("says what to install for a group whose providers aren't", async () => {
    const sst: any = await sstGlobal({
      cloudflare: ["@pulumi/cloudflare", missing],
      vercel: [missing, "@sst-test/also-not-installed"],
    });
    expect(typeof sst.aws.Bucket).toBe("function");
    expect(() => sst.cloudflare.Worker).toThrow(
      "sst.cloudflare needs @sst-test/not-installed, which isn't installed here. In a component package's repo, install it as a dev dependency. In an app, use the sst/testing in .sst/platform, where SST's providers are installed.",
    );
    expect(() => sst.vercel).toThrow(
      "sst.vercel needs @sst-test/not-installed and @sst-test/also-not-installed, which aren't installed here. In a component package's repo, install them as dev dependencies. In an app, use the sst/testing in .sst/platform, where SST's providers are installed.",
    );
    expect(Object.keys(sst)).toContain("vercel");
  });
});

describe("notInstalled()", () => {
  it("finds the ones that can't be loaded", () => {
    expect(notInstalled(["@pulumi/aws", "@pulumi/pulumi", missing])).toEqual([
      missing,
    ]);
  });
});
