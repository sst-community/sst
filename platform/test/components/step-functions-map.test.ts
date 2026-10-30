import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

let partition = "aws";

pulumi.runtime.setMocks(
  {
    newResource: (args) => ({ id: `${args.name}_id`, state: args.inputs }),
    call: (args) => {
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: args.provider ? "aws-cn" : partition };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

function resolve<T>(value: pulumi.Input<T>) {
  return new Promise<any>((resolve) => pulumi.output(value).apply(resolve));
}

type MapState =
  typeof import("../../src/components/aws/step-functions/map").Map;
type MapArgs = ConstructorParameters<MapState>[0];

let Map: MapState;
let Pass: typeof import("../../src/components/aws/step-functions/pass").Pass;
let Task: typeof import("../../src/components/aws/step-functions/task").Task;
let Parallel: typeof import("../../src/components/aws/step-functions/parallel").Parallel;

beforeAll(async () => {
  Map = (await import("../../src/components/aws/step-functions/map")).Map;
  Pass = (await import("../../src/components/aws/step-functions/pass")).Pass;
  Task = (await import("../../src/components/aws/step-functions/task")).Task;
  Parallel = (await import("../../src/components/aws/step-functions/parallel"))
    .Parallel;
});

function map(args: Partial<MapArgs> = {}) {
  return new Map({
    name: "Read",
    mode: "standard",
    processor: new Pass({ name: "Process" }),
    ...args,
  });
}

// The definition of the state, as it ends up in the state machine
async function definition(args: Partial<MapArgs> = {}) {
  const state = map(args);
  return JSON.parse(JSON.stringify(await resolve(state.serialize()))).Read;
}

// The permissions the role of the state machine gets
async function permissions(args: Partial<MapArgs> = {}) {
  const state = map(args);
  return JSON.parse(JSON.stringify(await resolve(state.getPermissions())));
}

const reader = { bucket: "data", type: "jsonl" } as const;

describe("Map state with an itemReader", () => {
  it("reads a JSON Lines file", async () => {
    const state = await definition({
      itemReader: { ...reader, key: "manifests/all.jsonl" },
    });
    expect(state.ItemReader).toEqual({
      Resource: "arn:aws:states:::s3:getObject",
      Arguments: { Bucket: "data", Key: "manifests/all.jsonl" },
      ReaderConfig: { InputType: "JSONL" },
    });
    expect(state.Items).toBeUndefined();
  });

  it("reads a JSON file, with the key from a JSONata expression and a limit", async () => {
    const state = await definition({
      itemReader: {
        type: "json",
        bucket: "data",
        key: "{% $states.input.manifestKey %}",
        maxItems: "{% $states.input.limit %}",
      },
    });
    expect(state.ItemReader).toEqual({
      Resource: "arn:aws:states:::s3:getObject",
      Arguments: { Bucket: "data", Key: "{% $states.input.manifestKey %}" },
      ReaderConfig: {
        InputType: "JSON",
        MaxItems: "{% $states.input.limit %}",
      },
    });
  });

  it("reads a CSV file with a header row, or with the headers it's given", async () => {
    const withHeader = await definition({
      itemReader: { type: "csv", bucket: "data", key: "rows.csv" },
    });
    expect(withHeader.ItemReader.ReaderConfig).toEqual({
      InputType: "CSV",
      CSVHeaderLocation: "FIRST_ROW",
    });

    const given = await definition({
      itemReader: {
        type: "csv",
        bucket: "data",
        key: "rows.csv",
        csvHeaders: ["id", "name"],
      },
    });
    expect(given.ItemReader.ReaderConfig).toEqual({
      InputType: "CSV",
      CSVHeaderLocation: "GIVEN",
      CSVHeaders: ["id", "name"],
    });
  });

  it("lists the objects under a prefix", async () => {
    const state = await definition({
      itemReader: {
        type: "objects",
        bucket: "data",
        prefix: "docs/",
        maxItems: 10,
      },
    });
    expect(state.ItemReader).toEqual({
      Resource: "arn:aws:states:::s3:listObjectsV2",
      Arguments: { Bucket: "data", Prefix: "docs/" },
      ReaderConfig: { MaxItems: 10 },
    });
  });

  it("sends no ReaderConfig for objects without a limit", async () => {
    const state = await definition({
      itemReader: { type: "objects", bucket: "data" },
    });
    expect(state.ItemReader).toEqual({
      Resource: "arn:aws:states:::s3:listObjectsV2",
      Arguments: { Bucket: "data" },
    });
  });

  it("takes the bucket from an output", async () => {
    const state = await definition({
      itemReader: {
        ...reader,
        bucket: pulumi.output("from-output"),
        key: "all.jsonl",
      },
    });
    expect(state.ItemReader.Arguments.Bucket).toBe("from-output");
  });

  it("rejects items next to the itemReader", () => {
    expect(() =>
      map({
        items: [1, 2],
        itemReader: { ...reader, key: "all.jsonl" },
      }).serialize(),
    ).toThrow(/both "items" and "itemReader"/);
  });

  it("wants a key for a file, and a prefix for objects", () => {
    expect(() => map({ itemReader: reader }).serialize()).toThrow(
      /Set its "key"/,
    );
    expect(() =>
      map({ itemReader: { ...reader, key: "a", prefix: "b" } }).serialize(),
    ).toThrow(/Use "key" and not "prefix"/);
    expect(() =>
      map({
        itemReader: { type: "objects", bucket: "data", key: "a" },
      }).serialize(),
    ).toThrow(/Use "prefix" and not "key"/);
  });

  it("rejects empty csvHeaders", () => {
    expect(() =>
      map({
        itemReader: {
          type: "csv",
          bucket: "data",
          key: "a.csv",
          csvHeaders: [],
        },
      }).serialize(),
    ).toThrow(/has no "csvHeaders". Leave them out to use the first row/);
  });

  it("rejects a type it doesn't know", () => {
    expect(() =>
      map({
        itemReader: { type: "parquet" as any, bucket: "data", key: "a" },
      }).serialize(),
    ).toThrow(
      /has the type "parquet". The types are "objects", "json", "jsonl", "csv"/,
    );
  });

  it("only takes csvHeaders for a CSV file", () => {
    expect(() =>
      map({
        itemReader: { ...reader, key: "a", csvHeaders: ["id"] },
      }).serialize(),
    ).toThrow(/only apply to the "csv" type/);
  });

  it("rejects a JSONata expression as the bucket of the reader", () => {
    expect(() =>
      map({
        itemReader: {
          ...reader,
          bucket: "{% $states.input.bucket %}",
          key: "a",
        },
      }).serialize(),
    ).toThrow(/must be a bucket name, not a JSONata expression/);
  });

  it("rejects a JSONata expression as the bucket of the writer", () => {
    expect(() =>
      map({
        resultWriter: { bucket: "{% $states.input.bucket %}", prefix: "r" },
      }).serialize(),
    ).toThrow(/must be a bucket name, not a JSONata expression/);
  });
});

describe("Map state with an itemBatcher", () => {
  it("batches by item count and passes on the batch input", async () => {
    const state = await definition({
      itemBatcher: {
        maxItemsPerBatch: 3,
        batchInput: { runId: "{% $states.input.runId %}" },
      },
    });
    expect(state.ItemBatcher).toEqual({
      MaxItemsPerBatch: 3,
      BatchInput: { runId: "{% $states.input.runId %}" },
    });
  });

  it("batches by size", async () => {
    const state = await definition({
      itemBatcher: { maxInputBytesPerBatch: 1024 },
    });
    expect(state.ItemBatcher).toEqual({ MaxInputBytesPerBatch: 1024 });
  });

  it("needs a size or a count", () => {
    expect(() =>
      map({ itemBatcher: { batchInput: { a: 1 } } }).serialize(),
    ).toThrow(/needs "maxItemsPerBatch", "maxInputBytesPerBatch" or both/);
  });
});

describe("Map state with a resultWriter", () => {
  it("writes the results to a prefix as they are", async () => {
    const state = await definition({
      resultWriter: { bucket: "out", prefix: "results/read" },
    });
    expect(state.ResultWriter).toEqual({
      Resource: "arn:aws:states:::s3:putObject",
      Arguments: { Bucket: "out", Prefix: "results/read" },
    });
  });

  it("formats the results", async () => {
    const state = await definition({
      resultWriter: {
        bucket: "out",
        prefix: "results",
        transformation: "flatten",
        outputType: "jsonl",
      },
    });
    expect(state.ResultWriter.WriterConfig).toEqual({
      Transformation: "FLATTEN",
      OutputType: "JSONL",
    });
  });

  it("fills in the other half of the format", async () => {
    const state = await definition({
      resultWriter: { bucket: "out", prefix: "r", transformation: "compact" },
    });
    expect(state.ResultWriter.WriterConfig).toEqual({
      Transformation: "COMPACT",
      OutputType: "JSON",
    });
  });
});

describe("Map state with an empty resultWriter prefix", () => {
  it("rejects a prefix that is empty or only slashes", () => {
    for (const prefix of ["", "/", "//"])
      expect(() =>
        map({ resultWriter: { bucket: "out", prefix } }).serialize(),
      ).toThrow(/needs a "prefix", which can't be empty or only slashes/);
  });
});

describe("Map state with tolerated failures", () => {
  it("takes numbers and JSONata expressions", async () => {
    const state = await definition({
      toleratedFailurePercentage: 5,
      toleratedFailureCount: "{% $states.input.failures %}",
    });
    expect(state.ToleratedFailurePercentage).toBe(5);
    expect(state.ToleratedFailureCount).toBe("{% $states.input.failures %}");
  });

  it("keeps 0 when asked for it", async () => {
    const state = await definition({ toleratedFailureCount: 0 });
    expect(state.ToleratedFailureCount).toBe(0);
  });
});

describe("Map state in inline mode", () => {
  it("leaves the new fields out of a state that doesn't use them", async () => {
    const state = await definition({ mode: "inline", items: [1, 2] });
    for (const key of [
      "ItemReader",
      "ItemBatcher",
      "ResultWriter",
      "ToleratedFailurePercentage",
      "ToleratedFailureCount",
    ])
      expect(state[key]).toBeUndefined();
    expect(state.ItemProcessor.ProcessorConfig).toEqual({ Mode: "INLINE" });
  });

  it("rejects the options that only the distributed modes have", () => {
    expect(() =>
      map({
        mode: "inline",
        itemBatcher: { maxItemsPerBatch: 2 },
        toleratedFailureCount: 1,
      }).serialize(),
    ).toThrow(
      /"itemBatcher", "toleratedFailureCount", which need the "standard" or "express" mode/,
    );
  });

  it("rejects them when the mode is not set", () => {
    expect(() =>
      map({
        mode: undefined,
        itemReader: { ...reader, key: "a" },
      }).serialize(),
    ).toThrow(/"itemReader", which needs the "standard" or "express" mode/);
  });

  it("allows them in the express mode", async () => {
    const state = await definition({
      mode: "express",
      itemBatcher: { maxItemsPerBatch: 2 },
    });
    expect(state.ItemProcessor.ProcessorConfig).toEqual({
      Mode: "DISTRIBUTED",
      ExecutionType: "EXPRESS",
    });
  });
});

describe("Map state permissions", () => {
  const find = (perms: any[], action: string) =>
    perms.filter((p) => p.actions.includes(action));

  it("has none for a state that doesn't touch S3", async () => {
    expect(await permissions({ items: [1] })).toEqual([]);
  });

  it("reads the one object of a file", async () => {
    const perms = await permissions({
      itemReader: { ...reader, bucket: "data", key: "manifests/all.jsonl" },
    });
    expect(perms).toEqual([
      {
        actions: ["s3:GetObject"],
        resources: ["arn:aws:s3:::data/manifests/all.jsonl"],
      },
    ]);
  });

  it("reads any object in the bucket when the key is a JSONata expression", async () => {
    const perms = await permissions({
      itemReader: { ...reader, key: "{% $states.input.manifestKey %}" },
    });
    expect(perms[0].resources).toEqual(["arn:aws:s3:::data/*"]);
  });

  it("only lets a key match itself", async () => {
    const perms = await permissions({
      itemReader: { ...reader, key: "a*b/${aws:username}/c?.jsonl" },
    });
    expect(perms[0].resources).toEqual([
      "arn:aws:s3:::data/a${*}b/${$}{aws:username}/c${?}.jsonl",
    ]);
  });

  it("only lets a bucket name match itself", async () => {
    const perms = await permissions({
      itemReader: { ...reader, bucket: "data-*", key: "a.jsonl" },
    });
    expect(perms[0].resources).toEqual(["arn:aws:s3:::data-${*}/a.jsonl"]);
  });

  it("lists and reads the objects under a prefix", async () => {
    const perms = await permissions({
      itemReader: { type: "objects", bucket: "data", prefix: "docs/" },
    });
    const [list] = find(perms, "s3:ListBucket");
    expect(list.resources).toEqual(["arn:aws:s3:::data"]);
    expect(list.conditions).toEqual([
      { test: "StringLike", variable: "s3:prefix", values: ["docs/*"] },
    ]);
    expect(find(perms, "s3:GetObject")[0].resources).toEqual([
      "arn:aws:s3:::data/docs/*",
    ]);
  });

  it("lists the whole bucket without a prefix, or with one from a JSONata expression", async () => {
    for (const prefix of [undefined, "{% $states.input.prefix %}" as const]) {
      const perms = await permissions({
        itemReader: { type: "objects", bucket: "data", prefix },
      });
      expect(find(perms, "s3:ListBucket")[0].conditions).toEqual([]);
      expect(find(perms, "s3:GetObject")[0].resources).toEqual([
        "arn:aws:s3:::data/*",
      ]);
    }
  });

  it("uses the partition of the account", async () => {
    partition = "aws-cn";
    try {
      const perms = await permissions({
        itemReader: { ...reader, key: "a.jsonl" },
      });
      expect(perms[0].resources).toEqual(["arn:aws-cn:s3:::data/a.jsonl"]);
    } finally {
      partition = "aws";
    }
  });

  it("writes the results under the prefix", async () => {
    const perms = await permissions({
      resultWriter: { bucket: "out", prefix: "results/read" },
    });
    expect(perms).toEqual([
      {
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListMultipartUploadParts",
          "s3:AbortMultipartUpload",
        ],
        resources: ["arn:aws:s3:::out/results/read/*"],
      },
    ]);
  });

  it("writes under one slash, whether the prefix ends with one or not", async () => {
    for (const prefix of ["results", "results/", "results//"]) {
      const perms = await permissions({
        resultWriter: { bucket: "out", prefix },
      });
      expect(perms[0].resources).toEqual(["arn:aws:s3:::out/results/*"]);
    }
  });

  it("writes anywhere in the bucket when the prefix is a JSONata expression", async () => {
    const perms = await permissions({
      resultWriter: { bucket: "out", prefix: "{% $states.input.prefix %}" },
    });
    expect(perms[0].resources).toEqual(["arn:aws:s3:::out/*"]);
  });

  it("adds none for a state that is not valid", () => {
    expect(() =>
      map({
        mode: "inline",
        itemReader: { ...reader, key: "a.jsonl" },
      }).getPermissions(),
    ).toThrow(/"itemReader", which needs the "standard" or "express" mode/);
    expect(() =>
      map({
        items: [1],
        itemReader: { ...reader, key: "a.jsonl" },
      }).getPermissions(),
    ).toThrow(/both "items" and "itemReader"/);
    expect(() =>
      map({
        itemBatcher: {},
        resultWriter: { bucket: "out", prefix: "r" },
      }).getPermissions(),
    ).toThrow(/needs "maxItemsPerBatch", "maxInputBytesPerBatch" or both/);
    expect(() =>
      map({ resultWriter: { bucket: "out", prefix: "" } }).getPermissions(),
    ).toThrow(/needs a "prefix", which can't be empty or only slashes/);
  });

  it("keeps the permissions of the processor, and of the states around it", async () => {
    const processor = new Task({
      name: "Process",
      resource: "arn:aws:states:::lambda:invoke",
      permissions: [
        { actions: ["lambda:InvokeFunction"], resources: ["arn:fn"] },
      ],
    });
    const after = new Task({
      name: "After",
      resource: "arn:aws:states:::sns:publish",
      permissions: [{ actions: ["sns:Publish"], resources: ["arn:topic"] }],
    });
    const state = map({
      processor,
      itemReader: { ...reader, key: "a.jsonl" },
      resultWriter: { bucket: "out", prefix: "r" },
    });
    state.next(after);

    const perms = JSON.parse(
      JSON.stringify(await resolve(state.getPermissions())),
    );
    expect(perms.map((p: any) => p.actions[0]).sort()).toEqual([
      "lambda:InvokeFunction",
      "s3:GetObject",
      "s3:PutObject",
      "sns:Publish",
    ]);
  });

  it("resolves the partition with the options of the component", async () => {
    const provider = new aws.Provider("other", { region: "cn-north-1" });

    // directly, through a state that comes before it, and in a branch of a Parallel
    const direct = map({ itemReader: { ...reader, key: "a.jsonl" } });
    const first = new Pass({ name: "First" });
    first.next(
      map({ name: "Next", itemReader: { ...reader, key: "a.jsonl" } }),
    );
    const parallel = new Parallel({ name: "Branches" });
    parallel.branch(
      map({ name: "InBranch", itemReader: { ...reader, key: "a.jsonl" } }),
    );

    for (const state of [direct, first, parallel]) {
      const perms = JSON.parse(
        JSON.stringify(await resolve(state.getPermissions({ provider }))),
      );
      expect(perms[0].resources).toEqual(["arn:aws-cn:s3:::data/a.jsonl"]);
    }

    // without them, it's the partition of the default provider
    const perms = await permissions({
      itemReader: { ...reader, key: "a.jsonl" },
    });
    expect(perms[0].resources).toEqual(["arn:aws:s3:::data/a.jsonl"]);
  });
});
