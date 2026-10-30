import { getPartitionOutput } from "@pulumi/aws";
import { ComponentResourceOptions, interpolate, output } from "@pulumi/pulumi";
import { Input } from "../../input";
import { FunctionPermissionArgs } from "../function.js";
import {
  CatchArgs,
  Failable,
  isJSONata,
  JSONata,
  Nextable,
  RetryArgs,
  State,
  StateArgs,
} from "./state";

export interface MapArgs extends StateArgs {
  /**
   * The processing mode for the `Map` state.
   *
   * The `inline` mode is the default and has limited concurrency. In this mode, each item
   * in the `Map` state runs as a part of the current workflow.
   *
   * The `standard` and `express` mode have high concurrency. In these mode, each item in
   * the `Map` state runs as a child workflow. This enables high concurrency of up to 10,000
   * parallel child workflows. Each child workflow has its own, separate execution history.
   * - In `standard` mode, each child runs as a StepFunctions Standard workflow.
   * - In `express` mode, each child runs as a StepFunctions Express workflow.
   *
   * :::note
   * `Map` state with `standard` or `express` mode is not supported in `express` type StepFunctions.
   * :::
   *
   * @default `"inline"`
   * @example
   * ```js
   * {
   *   type: "express"
   * }
   * ```
   */
  mode?: Input<"inline" | "standard" | "express">;
  /**
   * The list of items to process. To go through more items than fit in the 256 KB limit of
   * a state's payload, read them from Amazon S3 with `itemReader`.
   *
   * @example
   * For example, you can specify an array of items.
   *
   * ```ts
   * {
   *   items: ["item1", "item2", "item3"]
   * }
   * ```
   *
   * Or, specify a JSONata expression that evaluates to an array of items.
   *
   * ```ts
   * {
   *   items: "{% $states.input.items %}"
   * }
   * ```
   */
  items?: Input<JSONata | any[]>;
  /**
   * Reformat the values of the input array items before they're passed on to each
   * state iteration.
   *
   * For example, you can pass in what you want the fields to be.
   *
   * ```ts
   * {
   *   "itemSelector": {
   *     "size": 10,
   *     "value.$": "$$.Map.Item.Value"
   *   }
   * }
   * ```
   *
   * When applied to the following list of items.
   *
   * ```ts
   * [
   *   {
   *     "resize": "true",
   *     "format": "jpg"
   *   },
   *   {
   *     "resize": "false",
   *     "format": "png"
   *   }
   * ]
   * ```
   *
   * A transformed item will look like.
   *
   * ```ts
   * {
   *   "size": 10,
   *   "value": {
   *     "resize": "true",
   *     "format": "jpg"
   *   }
   * }
   * ```
   *
   * Learn more about [`ItemSelector`](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-itemselector.html).
   */
  itemSelector?: Input<Record<string, Input<any>>>;
  /**
   * An upper bound on the number of `Map` state iterations that can run in parallel.
   * Takes an integer or a JSONata expression that evaluates to an integer.
   *
   * Default to 0, which means there's no limit on the concurrency.
   *
   * @default `0`
   * @example
   * For example, to limit it to 10 concurrent iterations.
   * ```ts
   * {
   *   maxConcurrency: 10
   * }
   * ```
   */
  maxConcurrency?: Input<JSONata | number>;
  /**
   * Read the items from an object in Amazon S3, or from a list of objects, instead of
   * from the state's input. This allows the `Map` state to go through more items than fit
   * in the 256 KB limit of a state's payload, for example thousands of records or
   * document chunks.
   *
   * This requires the `standard` or `express` mode, and it can't be used together with
   * `items`. Learn more about [`ItemReader`](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-itemreader.html).
   *
   * The bucket must be in the same AWS account and Region as the state machine. The
   * permissions to read it are added to the role of the state machine. If the bucket is
   * encrypted with a KMS key that you manage, the role also needs access to the key.
   *
   * @example
   *
   * Read each line of a JSON Lines file as an item.
   *
   * ```ts
   * {
   *   itemReader: {
   *     type: "jsonl",
   *     bucket: bucket.name,
   *     key: "{% $states.input.manifestKey %}"
   *   }
   * }
   * ```
   *
   * Or, use every object that starts with a prefix as an item. Each item has the
   * `Key`, `Size`, `Etag` and other fields of the object.
   *
   * ```ts
   * {
   *   itemReader: {
   *     type: "objects",
   *     bucket: bucket.name,
   *     prefix: "documents/"
   *   }
   * }
   * ```
   */
  itemReader?: {
    /**
     * The kind of data the items are read from.
     *
     * - `json` is a JSON file that contains an array.
     * - `jsonl` is a JSON Lines file, where each line is an item.
     * - `csv` is a CSV file, where each row is an item. The columns are the fields of
     *   the item, named after the header of the file or `csvHeaders`.
     * - `objects` is the list of objects in the bucket, optionally under a `prefix`.
     */
    type: "json" | "jsonl" | "csv" | "objects";
    /**
     * The name of the S3 bucket. This is a bucket name and not a JSONata expression, as the
     * permissions of the state machine are scoped to it.
     */
    bucket: Input<string>;
    /**
     * The key of the object to read. Required for the `json`, `jsonl` and `csv` types.
     *
     * Takes a key or a JSONata expression that evaluates to one. When it's an expression,
     * the state machine can read any object in the `bucket`. Not for the `objects` type,
     * which takes a `prefix`.
     */
    key?: Input<JSONata | string>;
    /**
     * Only use the objects whose key starts with this prefix. Used by the `objects` type.
     *
     * Takes a prefix or a JSONata expression that evaluates to one. When it's an expression,
     * the state machine can list and read any object in the `bucket`. Only for the
     * `objects` type; the other types take a `key`.
     *
     * @default All the objects in the bucket
     */
    prefix?: Input<JSONata | string>;
    /**
     * The maximum number of items to pass on to the `Map` state, up to `100000000`.
     * Takes an integer or a JSONata expression that evaluates to an integer.
     *
     * @default All the items
     */
    maxItems?: Input<JSONata | number>;
    /**
     * The names of the columns of a `csv` file that doesn't have a header row. Only for the
     * `csv` type, and it can't be empty.
     *
     * @default The first row of the file is the header
     */
    csvHeaders?: string[];
  };
  /**
   * Send the items to each iteration in batches, instead of one by one. Each iteration
   * gets an input with the items of the batch in `Items` and `batchInput` in
   * `BatchInput`. This allows one call of a function to process many items.
   *
   * This requires the `standard` or `express` mode. Set `maxItemsPerBatch`,
   * `maxInputBytesPerBatch` or both. If you set both, a batch ends at the smaller one.
   * Learn more about [`ItemBatcher`](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-itembatcher.html).
   *
   * @example
   *
   * ```ts
   * {
   *   itemBatcher: {
   *     maxItemsPerBatch: 10,
   *     batchInput: {
   *       runId: "{% $states.input.runId %}"
   *     }
   *   }
   * }
   * ```
   */
  itemBatcher?: {
    /**
     * The maximum number of items in a batch.
     * Takes an integer or a JSONata expression that evaluates to an integer.
     */
    maxItemsPerBatch?: Input<JSONata | number>;
    /**
     * The maximum size of a batch in bytes, up to `262144` (256 KiB), which is also the
     * size a batch can have when only `maxItemsPerBatch` is set.
     * Takes an integer or a JSONata expression that evaluates to an integer.
     */
    maxInputBytesPerBatch?: Input<JSONata | number>;
    /**
     * An object to pass on with every batch, as `BatchInput`. It can have JSONata
     * expressions in it, or be one.
     */
    batchInput?: Input<JSONata | Record<string, any>>;
  };
  /**
   * Write the results of the iterations to objects in Amazon S3, instead of returning
   * them in the output of the `Map` state. This allows the results to go over the 256 KB
   * limit of a state's output.
   *
   * This requires the `standard` or `express` mode. The state's output is then the
   * location of the results, as `ResultWriterDetails`. Learn more about
   * [`ResultWriter`](https://docs.aws.amazon.com/step-functions/latest/dg/input-output-resultwriter.html).
   *
   * The bucket must be in the same AWS account and Region as the state machine. The
   * permissions to write to it are added to the role of the state machine. If the bucket is
   * encrypted with a KMS key that you manage, the role also needs access to the key.
   *
   * @example
   *
   * ```ts
   * {
   *   resultWriter: {
   *     bucket: bucket.name,
   *     prefix: "results/read",
   *     transformation: "flatten",
   *     outputType: "jsonl"
   *   }
   * }
   * ```
   */
  resultWriter?: {
    /**
     * The name of the S3 bucket. This is a bucket name and not a JSONata expression, as the
     * permissions of the state machine are scoped to it.
     */
    bucket: Input<string>;
    /**
     * The prefix of the keys the results are written under, such as `results/read`. The
     * results are written to `<prefix>/<id of the run>/`. It can't be empty or only slashes. Takes a prefix or
     * a JSONata expression that evaluates to one. When it's an expression, the state
     * machine can write to any object in the `bucket`.
     */
    prefix: Input<JSONata | string>;
    /**
     * How the output of the iterations is combined.
     *
     * - `none` keeps the output of each iteration with the details of its execution.
     * - `compact` keeps only the output of each iteration.
     * - `flatten` keeps only the output of each iteration, and if it's an array, adds its
     *   items one by one.
     *
     * @default `"none"`
     */
    transformation?: "none" | "compact" | "flatten";
    /**
     * The format of the result objects. `json` is a JSON array, and `jsonl` has one
     * JSON value per line.
     *
     * @default `"json"`
     */
    outputType?: "json" | "jsonl";
  };
  /**
   * The percentage of failed iterations the `Map` state tolerates before it fails, from
   * `0` to `100`. Takes a number or a JSONata expression that evaluates to one.
   *
   * This requires the `standard` or `express` mode. If you also set
   * `toleratedFailureCount`, the state fails when either is exceeded. A value of `100`
   * means the state doesn't fail, even if every iteration fails.
   *
   * @default If neither this nor `toleratedFailureCount` is set, the state fails when one iteration fails
   * @example
   * ```ts
   * {
   *   toleratedFailurePercentage: 5
   * }
   * ```
   */
  toleratedFailurePercentage?: Input<JSONata | number>;
  /**
   * The number of failed iterations the `Map` state tolerates before it fails. Takes an
   * integer or a JSONata expression that evaluates to an integer.
   *
   * This requires the `standard` or `express` mode. If you also set
   * `toleratedFailurePercentage`, the state fails when either is exceeded.
   *
   * @default If neither this nor `toleratedFailurePercentage` is set, the state fails when one iteration fails
   * @example
   * ```ts
   * {
   *   toleratedFailureCount: 10
   * }
   * ```
   */
  toleratedFailureCount?: Input<JSONata | number>;
  /**
   * The state to execute for each item in the array.
   *
   * @example
   *
   * For example, to iterate over an array of items and execute a Lambda function
   * for each item.
   *
   * ```ts title="sst.config.ts"
   * const processor = sst.aws.StepFunctions.lambdaInvoke({
   *   name: "Processor",
   *   function: "src/processor.handler"
   * });
   *
   * sst.aws.StepFunctions.map({
   *   processor,
   *   name: "Map",
   *   items: "{% $states.input.items %}"
   * });
   * ```
   */
  processor: State;
}

// These only exist in the Distributed `Map`, that is the `standard` and `express` modes.
const DISTRIBUTED_ARGS = [
  "itemReader",
  "itemBatcher",
  "resultWriter",
  "toleratedFailurePercentage",
  "toleratedFailureCount",
] as const;

const READER_RESOURCE = {
  objects: "arn:aws:states:::s3:listObjectsV2",
  json: "arn:aws:states:::s3:getObject",
  jsonl: "arn:aws:states:::s3:getObject",
  csv: "arn:aws:states:::s3:getObject",
};

// In an IAM resource, `*`, `?` and `${...}` mean something. A key that has any of them
// should only match itself.
function escapeIam(value: string) {
  return value
    .replace(/\$/g, "${$}")
    .replace(/\*/g, "${*}")
    .replace(/\?/g, "${?}");
}

function bucketName(bucket: Input<string>) {
  const assertName = (bucket: string) => {
    if (isJSONata(bucket))
      throw new Error(
        `The bucket "${bucket}" must be a bucket name, not a JSONata expression. The permissions of the state machine are scoped to the bucket.`,
      );
    return bucket;
  };
  return typeof bucket === "string"
    ? assertName(bucket)
    : output(bucket).apply(assertName);
}

function resultPrefix(name: string, prefix: Input<string>) {
  const assertPrefix = (prefix: string) => {
    if (!isJSONata(prefix) && !prefix.replace(/\/+$/, ""))
      throw new Error(
        `The resultWriter of the "${name}" Map state needs a "prefix", which can't be empty or only slashes.`,
      );
    return prefix;
  };
  return typeof prefix === "string"
    ? assertPrefix(prefix)
    : output(prefix).apply(assertPrefix);
}

function bucketArn(bucket: Input<string>, opts?: ComponentResourceOptions) {
  const partition = getPartitionOutput({}, opts).partition;
  const name = output(bucketName(bucket)).apply(escapeIam);
  return interpolate`arn:${partition}:s3:::${name}`;
}

/**
 * The ARN of the objects a key, or a prefix with `wildcard`, stands for. A JSONata
 * expression is only known when the state runs, so it stands for any object.
 */
function objectArn(
  bucket: Input<string>,
  path: Input<string | undefined>,
  opts?: ComponentResourceOptions,
  wildcard = "",
) {
  const key = output(path).apply((path) =>
    path === undefined || isJSONata(path) ? "*" : escapeIam(path) + wildcard,
  );
  return interpolate`${bucketArn(bucket, opts)}/${key}`;
}

/**
 * The `Map` state is internally used by the `StepFunctions` component to add a [Map
 * workflow state](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html)
 * to a state machine.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `map` method of the `StepFunctions` component.
 */
export class Map extends State implements Nextable, Failable {
  private processor: State;

  constructor(protected args: MapArgs) {
    super(args);
    this.processor = args.processor.getHead();
    this.addChildGraph(this.processor);
  }

  /**
   * Add a next state to the `Map` state. If the state completes successfully,
   * continue execution to the given `state`.
   *
   * @param state The state to transition to.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * sst.aws.StepFunctions.map({
   *   // ...
   * })
   * .next(state);
   * ```
   */
  public next<T extends State>(state: T): T {
    return this.addNext(state);
  }

  /**
   * Add a retry behavior to the `Map` state. If the state fails with any of the
   * specified errors, retry the execution.
   *
   * @param args Properties to define the retry behavior.
   *
   * @example
   *
   * This defaults to.
   *
   * ```ts title="sst.config.ts" {5-8}
   * sst.aws.StepFunctions.map({
   *   // ...
   * })
   * .retry({
   *   errors: ["States.ALL"],
   *   interval: "1 second",
   *   maxAttempts: 3,
   *   backoffRate: 2
   * });
   * ```
   */
  public retry(args?: RetryArgs) {
    return this.addRetry(args);
  }

  /**
   * Add a catch behavior to the `Map` state. So if the state fails with any of the
   * specified errors, it'll continue execution to the given `state`.
   *
   * @param state The state to transition to on error.
   * @param args Properties to customize error handling.
   *
   * @example
   *
   * This defaults to.
   *
   * ```ts title="sst.config.ts" {5}
   * sst.aws.StepFunctions.map({
   *   // ...
   * })
   * .catch({
   *   errors: ["States.ALL"]
   * });
   * ```
   */
  public catch(state: State, args: CatchArgs = {}) {
    return this.addCatch(state, args);
  }

  /**
   * Check the args that are known when the state is defined, so that an invalid state
   * adds neither a permission nor a definition.
   */
  private check() {
    if (this.args.items !== undefined && this.args.itemReader)
      throw new Error(
        `The "${this.name}" Map state has both "items" and "itemReader". Items come from one or the other.`,
      );

    this.checkedItemReader();
    this.checkedItemBatcher();
    this.checkedResultWriter();

    const mode = this.args.mode ?? "inline";
    if (typeof mode === "string") this.assertMode(mode);
  }

  /**
   * @internal
   */
  public getPermissions(opts?: ComponentResourceOptions) {
    this.check();
    return [
      ...this.processor.getPermissions(opts),
      ...this.getItemReaderPermissions(opts),
      ...this.getResultWriterPermissions(opts),
      ...super.getPermissions(opts),
    ];
  }

  private getItemReaderPermissions(
    opts?: ComponentResourceOptions,
  ): FunctionPermissionArgs[] {
    const reader = this.checkedItemReader();
    if (!reader) return [];

    if (reader.type !== "objects") {
      return [
        {
          actions: ["s3:GetObject"],
          resources: [objectArn(reader.bucket, reader.key, opts)],
        },
      ];
    }

    return [
      {
        actions: ["s3:ListBucket"],
        resources: [bucketArn(reader.bucket, opts)],
        conditions: output(reader.prefix).apply((prefix) =>
          prefix === undefined || isJSONata(prefix)
            ? []
            : [
                {
                  test: "StringLike",
                  variable: "s3:prefix",
                  values: [escapeIam(prefix) + "*"],
                },
              ],
        ),
      },
      {
        actions: ["s3:GetObject"],
        resources: [objectArn(reader.bucket, reader.prefix ?? "", opts, "*")],
      },
    ];
  }

  private getResultWriterPermissions(
    opts?: ComponentResourceOptions,
  ): FunctionPermissionArgs[] {
    const writer = this.checkedResultWriter();
    if (!writer) return [];

    return [
      {
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListMultipartUploadParts",
          "s3:AbortMultipartUpload",
        ],
        resources: [
          objectArn(
            writer.bucket,
            // the results go under `<prefix>/`, however many slashes the prefix ends with
            output(writer.prefix).apply((prefix) =>
              isJSONata(prefix) ? prefix : prefix.replace(/\/+$/, "") + "/",
            ),
            opts,
            "*",
          ),
        ],
      },
    ];
  }

  // the options that only the distributed modes have
  private assertMode(mode: "inline" | "standard" | "express") {
    if (mode !== "inline") return;

    const used = DISTRIBUTED_ARGS.filter((arg) => this.args[arg] !== undefined);
    if (used.length)
      throw new Error(
        `The "${this.name}" Map state uses ${used
          .map((arg) => `"${arg}"`)
          .join(", ")}, which ${
          used.length > 1 ? "need" : "needs"
        } the "standard" or "express" mode.`,
      );
  }

  private processorConfig() {
    const config = (mode: "inline" | "standard" | "express") => {
      this.assertMode(mode);
      return mode === "inline"
        ? { Mode: "INLINE" }
        : { Mode: "DISTRIBUTED", ExecutionType: mode.toUpperCase() };
    };

    // an output is only known later, but a mode is usually written in the config
    const mode = this.args.mode ?? "inline";
    return typeof mode === "string" ? config(mode) : output(mode).apply(config);
  }

  /**
   * The itemReader, once it's known to make sense, or nothing without one.
   */
  private checkedItemReader() {
    const reader = this.args.itemReader;
    if (!reader) return undefined;

    const { type, key, prefix, csvHeaders } = reader;
    const where = `The itemReader of the "${this.name}" Map state`;
    if (!Object.hasOwn(READER_RESOURCE, type))
      throw new Error(
        `${where} has the type "${type}". The types are ${Object.keys(
          READER_RESOURCE,
        )
          .map((type) => `"${type}"`)
          .join(", ")}.`,
      );
    if (type === "objects") {
      if (key !== undefined)
        throw new Error(
          `${where} has the "objects" type, which lists objects under a "prefix". Use "prefix" and not "key".`,
        );
    } else {
      if (key === undefined)
        throw new Error(
          `${where} has the "${type}" type, which reads one object. Set its "key".`,
        );
      if (prefix !== undefined)
        throw new Error(
          `${where} has the "${type}" type, which reads one object. Use "key" and not "prefix".`,
        );
    }
    if (csvHeaders !== undefined && type !== "csv")
      throw new Error(
        `${where} has "csvHeaders", which only apply to the "csv" type.`,
      );
    if (csvHeaders?.length === 0)
      throw new Error(
        `${where} has no "csvHeaders". Leave them out to use the first row of the file.`,
      );
    return reader;
  }

  private serializeItemReader() {
    const reader = this.checkedItemReader();
    if (!reader) return undefined;

    const { type, bucket, key, prefix, maxItems, csvHeaders } = reader;
    return {
      Resource: READER_RESOURCE[type],
      Arguments:
        type === "objects"
          ? { Bucket: bucketName(bucket), Prefix: prefix }
          : { Bucket: bucketName(bucket), Key: key },
      ReaderConfig:
        type === "objects" && maxItems === undefined
          ? undefined
          : {
              ...(type !== "objects" && { InputType: type.toUpperCase() }),
              ...(type === "csv" && {
                CSVHeaderLocation: csvHeaders ? "GIVEN" : "FIRST_ROW",
                CSVHeaders: csvHeaders,
              }),
              MaxItems: maxItems,
            },
    };
  }

  private checkedItemBatcher() {
    const batcher = this.args.itemBatcher;
    if (!batcher) return undefined;

    if (
      batcher.maxItemsPerBatch === undefined &&
      batcher.maxInputBytesPerBatch === undefined
    )
      throw new Error(
        `The itemBatcher of the "${this.name}" Map state needs "maxItemsPerBatch", "maxInputBytesPerBatch" or both.`,
      );
    return batcher;
  }

  private serializeItemBatcher() {
    const batcher = this.checkedItemBatcher();
    if (!batcher) return undefined;

    return {
      MaxItemsPerBatch: batcher.maxItemsPerBatch,
      MaxInputBytesPerBatch: batcher.maxInputBytesPerBatch,
      BatchInput: batcher.batchInput,
    };
  }

  /**
   * The resultWriter, once it's known to make sense, or nothing without one.
   */
  private checkedResultWriter() {
    const writer = this.args.resultWriter;
    if (!writer) return undefined;

    return { ...writer, prefix: resultPrefix(this.name, writer.prefix) };
  }

  private serializeResultWriter() {
    const writer = this.checkedResultWriter();
    if (!writer) return undefined;

    return {
      Resource: "arn:aws:states:::s3:putObject",
      Arguments: { Bucket: bucketName(writer.bucket), Prefix: writer.prefix },
      ...((writer.transformation || writer.outputType) && {
        WriterConfig: {
          Transformation: (writer.transformation ?? "none").toUpperCase(),
          OutputType: (writer.outputType ?? "json").toUpperCase(),
        },
      }),
    };
  }

  /**
   * Serialize the state into JSON state definition.
   */
  protected toJSON() {
    this.check();

    return {
      Type: "Map",
      Items: this.args.items,
      ItemReader: this.serializeItemReader(),
      ItemBatcher: this.serializeItemBatcher(),
      ItemSelector: this.args.itemSelector,
      ItemProcessor: {
        ProcessorConfig: this.processorConfig(),
        StartAt: this.processor.name,
        States: this.processor.serialize(),
      },
      MaxConcurrency: this.args.maxConcurrency,
      ToleratedFailurePercentage: this.args.toleratedFailurePercentage,
      ToleratedFailureCount: this.args.toleratedFailureCount,
      ResultWriter: this.serializeResultWriter(),
      ...super.toJSON(),
    };
  }
}
