/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS Step Functions distributed map
 *
 * Use a Distributed Map state to process a large file in S3 in batches, with a
 * function. The items are read from a JSON Lines file, so they aren't limited by the
 * size of a state's payload. The results are written to S3, and the state tolerates
 * some failed batches.
 */
export default $config({
  app(input) {
    return {
      name: "aws-step-functions-distributed-map",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // Create a bucket for the items and for the results
    const bucket = new sst.aws.Bucket("MyBucket");

    // Upload a file with 100 items, one JSON object per line
    new aws.s3.BucketObjectv2("Items", {
      bucket: bucket.name,
      key: "items.jsonl",
      content: Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ id: i + 1, value: (i + 1) * 10 })
      ).join("\n"),
    });

    // Create a function that processes a batch of items
    const processor = sst.aws.StepFunctions.lambdaInvoke({
      name: "Processor",
      function: "index.handler",
      payload: "{% $states.input %}",
    });

    // Read the items from the file, 10 at a time, and write the results to S3
    const map = sst.aws.StepFunctions.map({
      name: "ProcessItems",
      mode: "standard",
      itemReader: {
        type: "jsonl",
        bucket: bucket.name,
        key: "items.jsonl",
      },
      itemBatcher: {
        maxItemsPerBatch: 10,
        batchInput: { source: "items.jsonl" },
      },
      resultWriter: {
        bucket: bucket.name,
        prefix: "results",
        transformation: "flatten",
        outputType: "jsonl",
      },
      // The batch with item 13 fails, which is 10 of the 100 items
      toleratedFailurePercentage: 10,
      processor,
    });

    // Create the state machine
    const stateMachine = new sst.aws.StepFunctions("MyStateMachine", {
      definition: map,
    });

    return {
      stateMachine: stateMachine.arn,
      bucket: bucket.name,
    };
  },
});
