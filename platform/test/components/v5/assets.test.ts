import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Provider } from "@pulumi/aws";
import { ComponentResource, type Output } from "@pulumi/pulumi";
import { mockPulumi } from "../../../src/testing/mock";
import { rejectionsOf } from "../../helpers/rejections";

// SST's components in a program Pulumi runs on its own, which declares where
// their code and images are kept. An SST app's are in assets-cli.test.ts.

const maps = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-maps-"));
const SOURCEMAPS = ["index.mjs.map"].map((file) => {
  fs.writeFileSync(path.join(maps, file), "{}");
  return path.join(maps, file);
});

const pulumi = mockPulumi({
  plain: true,
  sourcemaps: () => SOURCEMAPS,
  call: (args) => {
    // The region is the provider's, as AWS answers
    if (
      args.token === "aws:index/getRegion:getRegion" &&
      String(args.provider ?? "").includes("::West::")
    )
      return { name: "us-west-2", region: "us-west-2", id: "us-west-2" };
    if (args.token === "aws:index/getAvailabilityZones:getAvailabilityZones")
      return { names: ["us-east-1a", "us-east-1b"] };
    return undefined;
  },
});

const handler = "src/index.handler";

type Module = typeof import("../../../src/components/aws/assets");
type FunctionModule = typeof import("../../../src/components/aws/function");
type ServiceModule = typeof import("../../../src/components/aws/service");
type ClusterModule = typeof import("../../../src/components/aws/cluster");
type StoreModule =
  typeof import("../../../src/components/aws/helpers/bootstrap");

// A cluster in a VPC of the program's, for a service
const vpc = {
  id: "vpc-1",
  securityGroups: ["sg-1"],
  containerSubnets: ["subnet-1", "subnet-2"],
  loadBalancerSubnets: ["subnet-3", "subnet-4"],
};

// What an output resolves to
const valueOf = <T>(value: Output<T>) =>
  new Promise<T>((resolve) => value.apply(resolve));

describe("Assets, in a Pulumi program", () => {
  let Assets: Module["Assets"];
  let Function: FunctionModule["Function"];
  let Service: ServiceModule["Service"];
  let Cluster: ClusterModule["Cluster"];
  let assetStore: StoreModule["assetStore"];

  beforeAll(async () => {
    ({ Assets } = await import("../../../src/components/aws/assets"));
    ({ Function } = await import("../../../src/components/aws/function"));
    ({ Service } = await import("../../../src/components/aws/service"));
    ({ Cluster } = await import("../../../src/components/aws/cluster"));
    ({ assetStore } = await import(
      "../../../src/components/aws/helpers/bootstrap"
    ));
  });

  beforeEach(() => pulumi.reset());

  const resource = (name: string) => {
    const found = pulumi.resources.find((r) => r.name === name);
    if (!found) throw new Error(`No ${name} was created`);
    return found;
  };

  it("makes a bucket and a repository, deleted with the program", async () => {
    new Assets("Assets");
    await pulumi.settle();

    const bucket = resource("AssetsBucket");
    expect(bucket.type).toBe("aws:s3/bucket:Bucket");
    expect(bucket.parent).toContain("sst:aws:Assets::Assets");
    expect(bucket.inputs.forceDestroy).toBe(true);
    expect(bucket.inputs.bucket).toMatch(/^app-test-assetsbucket-/);
    expect(bucket.options.retainOnDelete).toBeFalsy();

    const repository = resource("AssetsRepository");
    expect(repository.type).toBe("aws:ecr/repository:Repository");
    expect(repository.inputs.forceDelete).toBe(true);
    expect(repository.inputs.name).toMatch(/^app-test-assetsrepository-/);
    expect(repository.options.retainOnDelete).toBeFalsy();
  });

  it("makes no repository when it's turned off", async () => {
    new Assets("Assets", { repository: false });
    await pulumi.settle();

    expect(pulumi.resources.map((r) => r.name)).not.toContain(
      "AssetsRepository",
    );
  });

  it("passes retainOnDelete and protect to its parts", async () => {
    new Assets("Assets", {}, { retainOnDelete: true, protect: true });
    await pulumi.settle();

    for (const name of ["AssetsBucket", "AssetsRepository"])
      expect(resource(name).options).toMatchObject({
        retainOnDelete: true,
        protect: true,
      });
  });

  it("keeps a function's code and source maps, deleted with them", async () => {
    new Assets("Assets");
    new Function("Api", { handler });
    await pulumi.settle();

    const bucket = resource("AssetsBucket").inputs.bucket;
    expect(resource("ApiCode").inputs.bucket).toBe(bucket);
    expect(resource("ApiFunction").inputs.s3Bucket).toBe(bucket);
    const map = resource("ApiSourcemap0");
    expect(map.inputs.bucket).toBe(bucket);
    expect(map.options.retainOnDelete).toBeFalsy();
  });

  it("keeps them in a bucket of the program's own", async () => {
    Assets.use({ bucket: "my-code" });
    new Function("Api", { handler });
    await pulumi.settle();

    expect(resource("ApiCode").inputs.bucket).toBe("my-code");
    expect(resource("ApiSourcemap0").inputs.bucket).toBe("my-code");
    expect(pulumi.resources.map((r) => r.type)).not.toContain(
      "aws:s3/bucket:Bucket",
    );
  });

  it("is an error when the program declares none", async () => {
    const failures = await rejectionsOf(async () => {
      new Function("Api", { handler });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toMatch(
      /nowhere to keep the code or images of the "Api" function.*new Assets\("Assets"\)/,
    );
  });

  it("is declared before the components that use it", async () => {
    await rejectionsOf(async () => {
      new Function("Api", { handler });
      expect(() => new Assets("Assets")).toThrow(
        /Assets\("Assets"\) comes after the "Api" function/,
      );
      expect(() => Assets.use({ bucket: "my-code" })).toThrow(
        /Assets\.use\(\) comes after the "Api" function/,
      );
      await pulumi.settle();
    });
  });

  it("is the one in the component's region", async () => {
    const west = new Provider("West", { region: "us-west-2" });
    new Assets("Assets");
    new Assets("WestAssets", {}, { provider: west });
    new Function("Api", { handler });
    new Function("WestApi", { handler }, { providers: [west] });
    await pulumi.settle();

    expect(resource("ApiCode").inputs.bucket).toBe(
      resource("AssetsBucket").inputs.bucket,
    );
    expect(resource("WestApiCode").inputs.bucket).toBe(
      resource("WestAssetsBucket").inputs.bucket,
    );
  });

  it("is an error when none is in the component's region", async () => {
    const west = new Provider("West", { region: "us-west-2" });
    const failures = await rejectionsOf(async () => {
      new Assets("Assets");
      new Function("Api", { handler }, { providers: [west] });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toMatch(
      /"Api" function in us-west-2: the program's assets are in us-east-1/,
    );
  });

  it("is an error when it has no bucket for a function's code", async () => {
    const failures = await rejectionsOf(async () => {
      Assets.use({
        repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/images",
      });
      new Function("Api", { handler });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toMatch(
      /Assets\.use\(\) has no bucket, and the "Api" function keeps its code in one/,
    );
  });

  it("is given a bucket, a repository or both", () => {
    expect(() => Assets.use({})).toThrow(
      /takes a bucket, a repository, or both/,
    );
  });

  it("is an error when two in a region have the component's provider", async () => {
    // As a bucket and a repository each given on its own
    Assets.use({ bucket: "my-code" });
    Assets.use({
      repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/images",
    });
    const failures = await rejectionsOf(async () => {
      new Function("Api", { handler });
      await pulumi.settle();
    });
    expect((failures[0] as Error).message).toMatch(
      /more than one assets in us-east-1 with the provider of the "Api" function: Assets\.use\(\), Assets\.use\(\)\. Declare one for each region and provider/,
    );
  });

  it("isn't needed by a service that runs an image it's given", async () => {
    const failures = await rejectionsOf(async () => {
      const cluster = new Cluster("MyCluster", { vpc });
      new Service("MyService", { cluster, image: "nginx:latest" });
      await pulumi.settle();
    });
    expect(failures).toEqual([]);
  });

  it("can be declared after a service that runs an image it's given", async () => {
    const cluster = new Cluster("MyCluster", { vpc });
    new Service("MyService", { cluster, image: "nginx:latest" });
    expect(() => new Assets("Assets")).not.toThrow();
    await pulumi.settle();
  });

  it("is shared when it's from Assets.use(), as another stack's can be", async () => {
    // What a stage stops using is kept in a shared one, like the dev stub's
    // code every stack in a bucket uses
    Assets.use({ bucket: "shared-code" });
    const thing = new ComponentResource("test:index:Thing", "Thing");
    const store = assetStore(thing, "the thing").forRegion("us-east-1");
    expect(await valueOf(store.shared)).toBe(true);
    expect(await valueOf(store.which)).toBe("Assets.use()");
    await pulumi.settle();
  });

  it("isn't shared when the program makes it", async () => {
    new Assets("Assets");
    const thing = new ComponentResource("test:index:Thing", "Thing");
    const store = assetStore(thing, "the thing").forRegion("us-east-1");
    expect(await valueOf(store.shared)).toBe(false);
    expect(await valueOf(store.which)).toBe('Assets("Assets")');
    await pulumi.settle();
  });
});
