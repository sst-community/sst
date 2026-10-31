/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "aws-floci",
      home: "aws",
      removal: "remove",
      providers: { aws: { version: "7.48.0", region: "us-east-1" } },
    };
  },
  async run() {
    const bucket = new sst.aws.Bucket("Files");
    const table = new sst.aws.Dynamo("Records", {
      fields: { id: "string" },
      primaryIndex: { hashKey: "id" },
    });
    const queue = new sst.aws.Queue("Jobs");
    queue.subscribe({ handler: "subscriber.handler", link: [table] });
    const fn = new sst.aws.Function("Api", {
      handler: "api.handler",
      url: true,
      link: [bucket, table, queue],
    });
    return {
      url: fn.url,
      bucket: bucket.name,
      table: table.name,
      queue: queue.url,
    };
  },
});
