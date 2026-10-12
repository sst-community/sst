import { Cluster } from "ioredis";
import { Resource } from "sst";

const client = new Cluster(
  [
    {
      host: Resource.MyRedis.host,
      port: Resource.MyRedis.port,
    },
  ],
  {
    redisOptions: {
      tls: {
        checkServerIdentity: () => undefined,
      },
    },
  }
);

export async function handler() {
  await client.set("foo", `bar-serverless-${Date.now()}`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      foo: await client.get("foo"),
    }),
  };
}
