/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS Redis serverless
 *
 * In this example, we create an [ElastiCache Serverless](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.serverless.html)
 * Redis and connect to it from a function in the same VPC. The maximum storage and ECPUs per second
 * cap how far the cache scales.
 *
 * A serverless cache has no password and always uses TLS, so the function only needs the `host`
 * and `port`.
 *
 * ```ts title="index.ts"
 * const client = new Cluster(
 *   [{ host: Resource.MyRedis.host, port: Resource.MyRedis.port }],
 *   { redisOptions: { tls: { checkServerIdentity: () => undefined } } }
 * );
 * ```
 */
export default $config({
  app(input) {
    return {
      name: "aws-redis-serverless",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // The function only talks to Redis inside the VPC, so it needs no NAT gateway.
    // SST warns about it anyway, as the function can't reach the internet.
    const vpc = new sst.aws.Vpc("MyVpc");
    const redis = new sst.aws.Redis("MyRedis", {
      vpc,
      serverless: {
        storage: { maximum: "10 GB" },
        ecpuPerSecond: { maximum: 5000 },
      },
    });
    new sst.aws.Function("MyApp", {
      handler: "index.handler",
      url: true,
      vpc,
      link: [redis],
    });
  },
});
