import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import { mockPulumi } from "../../src/testing/mock";
import {
  HIDDEN,
  SECRET,
  SIG,
  type StateExport,
  asChecked,
  asStateHas,
  comparable,
  policyDocument,
  revealedPaths,
} from "../../src/testing/state";

// A secret as a state holds it, and as a program gives it
const encrypted = { [SIG]: SECRET, ciphertext: "v1:abc" };
const secret = (value: any) => ({ [SIG]: SECRET, value });

describe("a resource compared with a state", () => {
  it("is hidden only where the state has a secret", () => {
    // An object keeps its secret on the field the provider marks
    const state = {
      target: { arn: encrypted, roleArn: "arn:role/one", input: "{}" },
    };
    expect(comparable(state)).toEqual({
      target: { arn: HIDDEN, roleArn: "arn:role/one", input: "{}" },
    });
    const now = (roleArn: string) =>
      asStateHas(
        state,
        { target: { arn: secret("arn:fn"), roleArn, input: "{}" } },
        new Set(),
      );
    expect(now("arn:role/one")).toEqual(comparable(state));
    expect(now("arn:role/two")).not.toEqual(comparable(state));
  });

  it("is hidden as a whole where the state has the whole of it secret", () => {
    // A list holding a secret is encrypted as a whole
    const state = { inlinePolicies: encrypted, name: "role" };
    expect(
      asStateHas(
        state,
        {
          inlinePolicies: [{ name: "inline", policy: secret("{}") }],
          name: "role",
        },
        new Set(),
      ),
    ).toEqual(comparable(state));
  });

  it("is a secret's value where the state has it plain", () => {
    expect(
      asStateHas(
        { description: "plain" },
        { description: secret("plain") },
        new Set(),
      ),
    ).toEqual({ description: "plain" });
  });

  it("is written as JSON where the state has a string", () => {
    expect(
      asStateHas(
        { policy: '{"b":1,"a":"<x>"}' },
        { policy: { b: 1, a: "<x>" } },
        new Set(),
      ),
    ).toEqual({ policy: '{"a":"\\u003cx\\u003e","b":1}' });
  });
});

describe("an image, as the Docker build provider checks it", () => {
  it("has the provider's defaults, and its registry's password secret", () => {
    const given = {
      push: true,
      dockerfile: { location: "/app/Dockerfile" },
      cacheTo: [{ registry: { ref: "cache", mode: "max" } }],
      registries: [{ address: "https://registry", password: "token" }],
    };
    expect(asChecked("docker-build:index:Image", given)).toEqual({
      push: true,
      exec: false,
      load: false,
      noCache: false,
      pull: false,
      target: "",
      dockerfile: { location: "/app/Dockerfile", inline: "" },
      cacheTo: [
        {
          raw: "",
          disabled: false,
          registry: {
            ref: "cache",
            mode: "max",
            ignoreError: false,
            ociMediaTypes: true,
            imageManifest: false,
            compression: "gzip",
            compressionLevel: 0,
            forceCompression: false,
          },
        },
      ],
      registries: [
        {
          address: "https://registry",
          username: "",
          password: secret("token"),
        },
      ],
    });
    // Inside a secret, and for anything else, as it's given
    expect(
      asChecked("docker-build:index:Image", {
        registries: [secret({ address: "a", password: secret("p") })],
      }).registries,
    ).toEqual([secret({ address: "a", username: "", password: secret("p") })]);
    expect(asChecked("aws:s3/bucket:Bucket", { bucket: "b" })).toEqual({
      bucket: "b",
    });
  });
});

describe("where a secret is in plain text now", () => {
  it("is each plain value a secret held before", () => {
    expect(
      revealedPaths(
        { variables: secret({ A: "a", B: "b" }) },
        { variables: { A: secret("a"), B: "b" } },
      ),
    ).toEqual(["variables.B"]);
  });

  it("isn't where a state has the secret on what holds it", () => {
    const state = { inlinePolicies: encrypted };
    const now = { inlinePolicies: [{ name: "inline", policy: secret("{}") }] };
    expect(revealedPaths(state, now)).toEqual(["inlinePolicies[0].name"]);
    expect(revealedPaths(state, now, true)).toEqual([]);
    expect(
      revealedPaths(state, { inlinePolicies: [{ policy: "{}" }] }, true),
    ).toEqual(["inlinePolicies[0].policy"]);
  });
});

// What the provider writes, by its source (terraform-provider-aws,
// internal/service/iam/policy_document_data_source.go and policy_model.go)
describe("a policy document", () => {
  it("is laid out as the provider writes it", () => {
    const { json, minifiedJson, statements } = policyDocument({
      statements: [
        {
          sid: "Read",
          actions: ["s3:GetObject", "s3:PutObject", "s3:GetObject"],
          resources: ["arn:aws:s3:::a/*", "arn:aws:s3:::b/&{aws:username}"],
          principals: [
            { type: "Service", identifiers: ["lambda.amazonaws.com"] },
          ],
          conditions: [
            {
              test: "StringEquals",
              variable: "aws:SourceAccount",
              values: ["123456789012"],
            },
            {
              test: "ArnLike",
              variable: "aws:SourceArn",
              values: ["arn:z", "arn:a", "arn:z"],
            },
          ],
        },
      ],
    });
    const doc = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Read",
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:GetObject"],
          Resource: ["arn:aws:s3:::b/${aws:username}", "arn:aws:s3:::a/*"],
          Principal: { Service: "lambda.amazonaws.com" },
          Condition: {
            ArnLike: { "aws:SourceArn": ["arn:z", "arn:a", "arn:z"] },
            StringEquals: { "aws:SourceAccount": "123456789012" },
          },
        },
      ],
    };
    expect(json).toBe(JSON.stringify(doc, null, 2));
    expect(minifiedJson).toBe(JSON.stringify(doc));
    expect(statements).toHaveLength(1);
  });

  it("has a principal of anyone as the provider writes it", () => {
    const principal = (principals: any[]) =>
      JSON.parse(policyDocument({ statements: [{ principals }] }).json)
        .Statement[0].Principal;
    expect(principal([{ type: "*", identifiers: ["*"] }])).toBe("*");
    expect(principal([{ type: "AWS", identifiers: ["*"] }])).toEqual({
      AWS: "*",
    });
    expect(principal([{ type: "*", identifiers: ["a", "b"] }])).toEqual({
      "*": ["b", "a"],
    });
    // Principals of a type are joined
    expect(
      principal([
        { type: "AWS", identifiers: ["x"] },
        { type: "AWS", identifiers: ["y", "z"] },
        { type: "Service", identifiers: ["s"] },
      ]),
    ).toEqual({ AWS: ["x", "z", "y"], Service: "s" });
  });

  it("escapes what HTML treats as markup, as Go does", () => {
    const { json } = policyDocument({
      statements: [
        {
          conditions: [
            { test: "StringLike", variable: "v", values: ["a<b>&c "] },
          ],
        },
      ],
    });
    expect(json).toContain('"v": "a\\u003cb\\u003e\\u0026c\\u2028"');
  });

  it("has no statements when it's given none", () => {
    expect(policyDocument({})).toMatchObject({
      statements: undefined,
      json: '{\n  "Version": "2012-10-17"\n}',
    });
  });
});

describe("a replay of a state", () => {
  // Two resources of the same type and name, inside components of two types
  const state: StateExport = {
    version: 3,
    checkpoint: {
      latest: {
        resources: [
          ["acme:index:Site", "A", "page-a"],
          ["acme:index:Docs", "B", "page-b"],
        ].flatMap(([type, name, id]) => [
          {
            urn: `urn:pulumi:rec::lab::${type}::${name}`,
            type,
            custom: false,
          },
          {
            urn: `urn:pulumi:rec::lab::${type}$aws:s3/bucketObjectv2:BucketObjectv2::Page`,
            type: "aws:s3/bucketObjectv2:BucketObjectv2",
            custom: true,
            id,
            parent: `urn:pulumi:rec::lab::${type}::${name}`,
            outputs: { bucket: name, key: "index.html", etag: secretOf(id) },
          },
        ]),
      },
    },
  };

  it("gives each resource what was deployed at its address", async () => {
    const engine = mockPulumi({ recorded: state });
    const page = (type: string, name: string) =>
      new aws.s3.BucketObjectv2(
        "Page",
        { bucket: name, key: "index.html" },
        { parent: new pulumi.ComponentResource(type, name) },
      );
    const pages = [page("acme:index:Site", "A"), page("acme:index:Docs", "B")];
    await engine.settle();
    const read = (o: pulumi.Output<any>) =>
      new Promise((resolve) => o.apply(resolve));
    expect(await Promise.all(pages.map((p) => read(p.id)))).toEqual([
      "page-a",
      "page-b",
    ]);
    // A secret the state has comes back hidden
    expect(await read(pages[0].etag)).toBe(HIDDEN);
  });
});

function secretOf(id: string) {
  return { ...encrypted, ciphertext: `v1:${id}` };
}
