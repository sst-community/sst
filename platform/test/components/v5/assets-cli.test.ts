import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Provider } from "@pulumi/aws";
import { mockPulumi } from "../../../src/testing/mock";

// SST's components in an SST app, which keeps their code and images in SST's
// bootstrap unless it declares its own. A Pulumi program's are in
// assets.test.ts.

const maps = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-maps-"));
const SOURCEMAPS = ["index.mjs.map"].map((file) => {
  fs.writeFileSync(path.join(maps, file), "{}");
  return path.join(maps, file);
});

const pulumi = mockPulumi({
  sourcemaps: () => SOURCEMAPS,
  // A repository has its URL, as AWS gives it
  state: (args) =>
    args.type === "aws:ecr/repository:Repository"
      ? {
          repositoryUrl: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${args.inputs.name}`,
          registryId: "123456789012",
        }
      : {},
  call: (args) => {
    if (
      args.token === "aws:index/getRegion:getRegion" &&
      String(args.provider ?? "").includes("::West::")
    )
      return { name: "us-west-2", region: "us-west-2", id: "us-west-2" };
    if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken")
      return {
        proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
        userName: "AWS",
        password: "token",
      };
    return undefined;
  },
});

const handler = "src/index.handler";
// SST's bootstrap in the mock
const BOOTSTRAP = "sst-asset-bucket";

type Module = typeof import("../../../src/components/aws/assets");
type FunctionModule = typeof import("../../../src/components/aws/function");

describe("Assets, in an SST app", () => {
  let Assets: Module["Assets"];
  let Function: FunctionModule["Function"];

  beforeAll(async () => {
    ({ Assets } = await import("../../../src/components/aws/assets"));
    ({ Function } = await import("../../../src/components/aws/function"));
  });

  beforeEach(() => pulumi.reset());

  const resource = (name: string) => {
    const found = pulumi.resources.find((r) => r.name === name);
    if (!found) throw new Error(`No ${name} was created`);
    return found;
  };

  it("isn't needed: SST's bootstrap keeps the code, and its source maps", async () => {
    new Function("Api", { handler });
    await pulumi.settle();

    expect(resource("ApiCode").inputs.bucket).toBe(BOOTSTRAP);
    const map = resource("ApiSourcemap0");
    expect(map.inputs.bucket).toBe(BOOTSTRAP);
    expect(map.options.retainOnDelete).toBe(true);
  });

  it("keeps the code where the app points it, and the source maps in SST's bootstrap", async () => {
    Assets.use({ bucket: "my-code" });
    new Function("Api", { handler });
    await pulumi.settle();

    expect(resource("ApiCode").inputs.bucket).toBe("my-code");
    expect(resource("ApiFunction").inputs.s3Bucket).toBe("my-code");
    // SST's Console reads them there
    const map = resource("ApiSourcemap0");
    expect(map.inputs.bucket).toBe(BOOTSTRAP);
    expect(map.options.retainOnDelete).toBe(true);
  });

  it("pushes images to the app's repository", async () => {
    new Assets("Assets");
    new Function("Api", {
      handler: "functions/src/functions/api.handler",
      runtime: "python3.12",
      python: { container: true },
    });
    await pulumi.settle();

    const url = `123456789012.dkr.ecr.us-east-1.amazonaws.com/${
      resource("AssetsRepository").inputs.name
    }`;
    const image = pulumi.resources.find(
      (r) => r.type === "docker-build:index:Image",
    )!;
    expect(image.inputs.tags).toEqual([`${url}:Api`]);
    expect(image.inputs.cacheTo[0].registry.ref).toBe(`${url}:Api-cache`);
  });

  it("uses SST's bootstrap in a region the app declares none for", async () => {
    const west = new Provider("West", { region: "us-west-2" });
    new Assets("Assets");
    new Function("Api", { handler });
    new Function("WestApi", { handler }, { providers: [west] });
    await pulumi.settle();

    expect(resource("ApiCode").inputs.bucket).toBe(
      resource("AssetsBucket").inputs.bucket,
    );
    expect(resource("WestApiCode").inputs.bucket).toBe(BOOTSTRAP);
  });
});
