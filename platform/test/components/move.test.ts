import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import { mockPulumi } from "../helpers/graph";

// As `sst migrate --check` runs the program
const pulumi = mockPulumi({ move: true, preview: true });

type Module = typeof import("../../src/components/parts-component");
type Takeover = typeof import("../../src/components/takeover");

describe("A component's parts, while the stage moves", () => {
  let component: Module["component"];
  let many: Module["many"];
  let takeover: Takeover["takeover"];

  beforeAll(async () => {
    ({ component, many } = await import(
      "../../src/components/parts-component"
    ));
    ({ takeover } = await import("../../src/components/takeover"));
  });

  beforeEach(() => pulumi.reset());

  function defineSite(type: string) {
    const parts = {
      bucket: aws.s3.BucketV2,
      code: aws.s3.BucketObjectv2,
      files: many(aws.s3.BucketObjectv2),
      logs: aws.cloudwatch.LogGroup,
    };
    return class Site extends component(type, parts) {
      constructor(name: string, opts?: object) {
        super(name, {}, opts);
        const bucket = this.part("bucket", {});
        this.part("code", { bucket: bucket.bucket, key: "code.zip" });
        for (const page of ["index", "about"])
          this.part("files", page, {
            bucket: bucket.bucket,
            key: `${page}.html`,
          });
        this.part("logs", {});
      }
    };
  }

  it("reports what the state map says about each part", async () => {
    const Site = defineSite("acme:index:Site");
    takeover(Site, {
      added: ["logs"],
      replaced: { code: "Its code is uploaded again under a new key." },
      released: {
        files: (_, { name, id }) => ({
          type: "pulumi-nodejs:dynamic:Resource",
          name: `${name}Assets${id}.sst.aws.BucketFiles`,
        }),
      },
    });
    new Site("Docs");
    await pulumi.settle();

    const site = "urn:pulumi:stack::project::acme:index:Site::Docs";
    const object =
      "urn:pulumi:stack::project::acme:index:Site$aws:s3/bucketObjectv2:BucketObjectv2";
    expect(
      pulumi
        .moved()
        .sort((a, b) =>
          `${a.key}${a.id ?? ""}`.localeCompare(`${b.key}${b.id ?? ""}`),
        ),
    ).toEqual([
      {
        component: site,
        type: "acme:index:Site",
        key: "code",
        urn: `${object}::DocsCode`,
        replaced: "Its code is uploaded again under a new key.",
      },
      {
        component: site,
        type: "acme:index:Site",
        key: "files",
        id: "about",
        urn: `${object}::DocsFilesAbout`,
        // Where it was: in the component it takes over from
        releases: [
          "urn:pulumi:stack::project::acme:index:Site$pulumi-nodejs:dynamic:Resource::DocsAssetsabout.sst.aws.BucketFiles",
        ],
      },
      {
        component: site,
        type: "acme:index:Site",
        key: "files",
        id: "index",
        urn: `${object}::DocsFilesIndex`,
        releases: [
          "urn:pulumi:stack::project::acme:index:Site$pulumi-nodejs:dynamic:Resource::DocsAssetsindex.sst.aws.BucketFiles",
        ],
      },
      {
        component: site,
        type: "acme:index:Site",
        key: "logs",
        urn: "urn:pulumi:stack::project::acme:index:Site$aws:cloudwatch/logGroup:LogGroup::DocsLogs",
        added: true,
      },
    ]);
  });

  it("finds what's released where the map says it was", async () => {
    const Site = defineSite("acme:index:NewSite");
    takeover(Site, {
      from: "acme:index:OldSite",
      released: {
        // In the component it takes over from, which had another type
        code: (_, { name }) => ({
          type: "acme:index:Code",
          name: `${name}Code`,
        }),
        // At the top of the app
        logs: (_, { name }) => ({
          type: "aws:cloudwatch/logGroup:LogGroup",
          name: `${name}Logs`,
          parent: false,
        }),
        // In another component, at the top of the app
        bucket: (_, { name }) => ({
          type: "aws:s3/bucketV2:BucketV2",
          name: `${name}Bucket`,
          parent: { type: "acme:index:Storage", name: `${name}Storage` },
        }),
      },
    });
    new Site("Docs");
    await pulumi.settle();

    const releases = Object.fromEntries(
      pulumi.moved().map((part) => [part.key, part.releases]),
    );
    expect(releases).toEqual({
      // Where it can be: in the component it takes over from, or in this one
      // under the same name
      code: [
        "urn:pulumi:stack::project::acme:index:NewSite$acme:index:Code::DocsCode",
        "urn:pulumi:stack::project::acme:index:OldSite$acme:index:Code::DocsCode",
      ],
      logs: [
        "urn:pulumi:stack::project::aws:cloudwatch/logGroup:LogGroup::DocsLogs",
      ],
      bucket: [
        "urn:pulumi:stack::project::acme:index:Storage$aws:s3/bucketV2:BucketV2::DocsBucket",
      ],
    });
  });

  it("reports nothing for a part the map says nothing about", async () => {
    const Site = defineSite("acme:index:Quiet");
    takeover(Site, { moved: { logs: "logGroup" } });
    new Site("Docs");
    await pulumi.settle();
    expect(pulumi.moved()).toEqual([]);
  });
});

describe("SST's components, while the stage moves", () => {
  beforeEach(() => pulumi.reset());

  it("a Vpc's bastion may be replaced, for its image", async () => {
    const { Vpc } = await import("../../src/components/aws/v5/vpc");
    await import("../../src/components/aws/takeover/vpc");
    new Vpc("Net", { az: ["us-east-1a"], bastion: true });
    await pulumi.settle();
    expect(pulumi.moved()).toEqual([
      expect.objectContaining({
        key: "bastionInstance",
        replaced: expect.stringContaining("Amazon Linux 2023"),
      }),
    ]);
  });
});
