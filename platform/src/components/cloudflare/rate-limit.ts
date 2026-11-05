import { type ComponentResourceOptions, Output, output } from "@pulumi/pulumi";
import { component } from "../parts-component";
import { VisibleError } from "../error";
import type { Input } from "../input";
import { type DurationMinutes, toSeconds } from "../duration";
import { binding } from "./binding";

// A rate limit is a binding a Worker gets. Nothing is created in Cloudflare.
const parts = {};

export interface RateLimitArgs {
  /**
   * A positive integer that uniquely defines this rate limiting namespace within your Cloudflare account.
   *
   * @example
   * ```js
   * {
   *   namespaceId: 1001
   * }
   * ```
   */
  namespaceId: Input<number>;
  /**
   * The number of allowed requests within the specified period of time. A
   * positive integer.
   *
   * @example
   * ```js
   * {
   *   limit: 100
   * }
   * ```
   */
  limit: Input<number>;
  /**
   * The duration of the rate limit window. Must be either 10 seconds or 1 minute.
   *
   * @example
   * ```js
   * {
   *   period: "1 minute"
   * }
   * ```
   */
  period: Input<"10 seconds" | "1 minute">;
}

/**
 * The `RateLimit` component lets you add a [Cloudflare Rate Limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding to
 * your app.
 *
 * @example
 *
 * #### Minimal example
 *
 * ```ts title="sst.config.ts"
 * const rateLimit = new sst.cloudflare.RateLimit("MyRateLimit", {
 *   namespaceId: 1001,
 *   limit: 100,
 *   period: "1 minute",
 * });
 * ```
 *
 * #### Link to a worker
 *
 * You can link RateLimit to a worker.
 *
 * ```ts {4} title="sst.config.ts"
 * new sst.cloudflare.Worker("MyWorker", {
 *   handler: "./index.ts",
 *   url: true,
 *   link: [rateLimit],
 * });
 * ```
 *
 * Once linked, you can use the SDK to interact with the RateLimit binding.
 *
 * ```ts title="index.ts" {7}
 * import { Resource } from "sst/resource";
 *
 * export default {
 *   async fetch(req, env): Promise<Response> {
 *     const url = new URL(req.url);
 *
 *     const outcome = await Resource.MyRateLimit.limit({ key: url.pathname });
 *     if (!outcome.success) {
 *       return new Response(`Rate limit exceeded for ${url.pathname}`, { status: 429 });
 *     }
 *
 *     return new Response("OK", { status: 200 });
 *   }
 * }
 * ```
 *
 * #### Switch from SST 4's `sst.cloudflare.RateLimit`
 *
 * Keep the name, and `sst migrate` moves it. It creates nothing in Cloudflare, so nothing there changes.
 *
 * A few things are checked sooner:
 *
 * - `namespaceId`, `limit` and `period` are checked when the component is
 *   created, where they're plain values, and the error names it.
 *   SST 4's `RateLimit` checked `namespaceId` as it deployed, and
 *   passed the others to Cloudflare as they were.
 * - `limit` has to be a positive integer, and `period` 10 seconds or 1
 *   minute, as Cloudflare takes them.
 */
export class RateLimit extends component("sst:cloudflare:RateLimit", parts) {
  private readonly values: {
    namespaceId: Output<string>;
    limit: Output<number>;
    period: Output<number>;
  };

  constructor(
    name: string,
    args: RateLimitArgs,
    opts: ComponentResourceOptions = {},
  ) {
    super(name, args, opts);

    const owner = `the "${name}" rate limit`;
    this.values = {
      namespaceId: checked(
        args.namespaceId,
        isPositiveInteger,
        `The "namespaceId" of ${owner} has to be a positive integer.`,
      ).apply((id) => id.toString()),
      limit: checked(
        args.limit,
        isPositiveInteger,
        `The "limit" of ${owner} has to be a positive integer.`,
      ),
      period: checked(
        args.period,
        (period) => [10, 60].includes(secondsOf(period)),
        `The "period" of ${owner} has to be "10 seconds" or "1 minute".`,
      ).apply(toSeconds),
    };
  }

  /**
   * A unique identifier for the rate limit namespace.
   */
  public get namespaceId() {
    return this.values.namespaceId;
  }

  /**
   * The number of allowed requests within the specified period of time.
   */
  public get limit() {
    return this.values.limit;
  }

  /**
   * The duration of the rate limit window, in seconds.
   */
  public get period() {
    return this.values.period;
  }

  /**
   * When you link a RateLimit binding, it will be available to the worker and you can
   * interact with it using its [API methods](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
   *
   * @example
   * ```ts title="index.ts"
   * import { Resource } from "sst/resource";
   *
   * export default {
   *   async fetch(req, env): Promise<Response> {
   *     const url = new URL(req.url);
   *
   *     const outcome = await Resource.MyRateLimit.limit({ key: url.pathname });
   *     if (!outcome.success) {
   *       return new Response(`Rate limit exceeded for ${url.pathname}`, { status: 429 });
   *     }
   *
   *     return new Response("OK", { status: 200 });
   *   }
   * }
   * ```
   *
   * @internal
   */
  public link() {
    return {
      properties: {},
      include: [
        binding({
          type: "rateLimitBindings",
          properties: {
            namespaceId: this.namespaceId,
            simple: { limit: this.limit, period: this.period },
          },
        }),
      ],
    };
  }
}

// An arg that's checked: now, when it's a plain value, so the error stops the
// component being created, and once it's known, when it's an output
function checked<T>(
  value: Input<T>,
  valid: (value: T) => boolean,
  message: string,
): Output<T> {
  const check = (value: T) => {
    if (!valid(value)) throw new VisibleError(message);
    return value;
  };
  if (Output.isInstance(value) || value instanceof Promise)
    return output(value).apply((value) => check(value as T));
  return output(check(value as T)) as Output<T>;
}

function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// The seconds in a duration like "1 minute", or `NaN` for what isn't one
function secondsOf(period: unknown) {
  try {
    return toSeconds(period as DurationMinutes);
  } catch {
    return NaN;
  }
}
