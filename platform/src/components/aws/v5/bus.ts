import {
  ComponentResourceOptions,
  interpolate,
  output,
} from "@pulumi/pulumi";
import { cloudwatch, lambda, sqs } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
} from "../../parts-component";
import type { Input } from "../../input";
import { Function } from "./function";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { sendPolicyArgs } from "../helpers/queue-policy";
import type { AnyQueue } from "../helpers/queue";
import { permission } from "../permission";

const parts = () => ({
  /**
   * The EventBridge event bus.
   */
  bus: cloudwatch.EventBus,
  /**
   * The functions subscribed to the bus, by subscriber name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The permission that lets EventBridge invoke each function subscriber, by
   * subscriber name.
   */
  permission: many(lambda.Permission),
  /**
   * The rule that matches the events of each subscriber, by subscriber name.
   */
  rule: many(cloudwatch.EventRule),
  /**
   * The target that sends what each rule matches to its subscriber, by
   * subscriber name.
   */
  target: many(cloudwatch.EventTarget),
  /**
   * The policy that lets EventBridge send to each queue subscriber, by
   * subscriber name.
   */
  queuePolicy: many(sqs.QueuePolicy),
});

export interface BusArgs extends ComponentArgs<typeof parts> {
  /**
   * Configure logging for the EventBus.
   *
   * @example
   *
   * ```js
   * new sst.aws.v5.Bus("MyBus", {
   *   logging: {
   *     level: "error",
   *     detail: true,
   *   },
   * });
   * ```
   */
  logging?: Input<{
    /**
     * The level of logging.
     */
    level: Input<"error" | "info" | "trace">;
    /**
     * Whether to include the event detail in the log.
     * @default `false`
     */
    detail?: Input<boolean>;
  }>;
}

export interface BusSubscriberArgs {
  /**
   * Configures whether the subscriber is enabled. When disabled, the EventBridge
   * rule is still created, but it won't receive events.
   *
   * @default true
   * @example
   * ```ts
   * {
   *   enabled: false
   * }
   * ```
   */
  enabled?: Input<boolean>;
  /**
   * Filter the messages that'll be processed by the subscriber.
   *
   * If any single property in the pattern doesn't match
   * an attribute assigned to the message, then the pattern rejects the message.
   *
   *
   * :::tip
   * Learn more about [event patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html).
   * :::
   *
   * @example
   * For example, if your EventBus message contains this in a JSON format.
   * ```js
   * {
   *   source: "my.source",
   *   detail: {
   *      price_usd: 210.75
   *   },
   *   "detail-type": "orderPlaced"
   * }
   * ```
   *
   * Then this pattern accepts the message.
   *
   * ```js
   * {
   *   pattern: {
   *     source: ["my.source", "my.source2"]
   *   }
   * }
   * ```
   */
  pattern?: Input<{
    /**
     * A list of `source` values to match against. The `source` indicates where the
     * event originated.
     *
     * @example
     *
     * ```js
     * {
     *   pattern: {
     *     source: ["my.source", "my.source2"]
     *   }
     * }
     * ```
     */
    source?: (string | any)[];
    /**
     * An object of `detail` values to match against, where the key is the name and
     * the value is the pattern to match. The `detail` contains the actual
     * data associated with the event.
     *
     * @example
     * ```js
     * {
     *   pattern: {
     *     detail: {
     *       price_usd: [{numeric: [">=", 100]}]
     *     }
     *   }
     * }
     * ```
     */
    detail?: Record<string, any>;
    /**
     * A list of `detail-type` values to match against. The `detail-type` typically
     * defines the kind of event that is emitted.
     *
     * @example
     * ```js
     * {
     *   pattern: {
     *     detailType: ["orderPlaced"]
     *   }
     * }
     * ```
     */
    detailType?: (string | any)[];
  }>;
}


/**
 * The `Bus` component lets you add an [Amazon EventBridge Event Bus](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have. That includes the resources of
 * each subscriber, which are kept inside the bus.
 *
 * @example
 *
 * #### Create a bus
 *
 * ```ts title="sst.config.ts"
 * const bus = new sst.aws.v5.Bus("MyBus");
 * ```
 *
 * #### Add a subscriber
 *
 * Each subscriber has a name.
 *
 * ```ts title="sst.config.ts"
 * bus.subscribe("MySubscriber", "src/subscriber.handler", {
 *   pattern: { detailType: ["order.created"] }
 * });
 * ```
 *
 * #### Subscribe to a bus that isn't in your app
 *
 * Reference it with `get`, by its name, then subscribe to it.
 *
 * ```ts title="sst.config.ts"
 * sst.aws.v5.Bus.get("Shared", "my-shared-bus").subscribe("MySubscriber", "src/subscriber.handler");
 * ```
 *
 * #### Switch from `sst.aws.Bus`
 *
 * Change `sst.aws.Bus` to `sst.aws.v5.Bus` and keep the name. The bus and the subscribers
 * you've deployed are kept.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const bus = new sst.aws.Bus("MyBus");
 * const bus = new sst.aws.v5.Bus("MyBus");
 * ```
 *
 * A few things work differently:
 *
 * - `sst.aws.Bus.subscribe` and `sst.aws.Bus.subscribeQueue`, which took the ARN of a bus
 *   that isn't in your app, are `get` followed by `subscribe` or `subscribeQueue`. `get`
 *   takes the bus's name. What they created is kept, as long as `get` isn't given a
 *   provider, directly, through its `parent`, or in `providers`: `sst.aws.Bus` created it
 *   with your app's, and another one replaces it, a function's log group included.
 *
 *   ```ts title="sst.config.ts" del={1} ins={2}
 *   sst.aws.Bus.subscribe("MySubscriber", busArn, "src/subscriber.handler");
 *   sst.aws.v5.Bus.get("Shared", "my-shared-bus").subscribe("MySubscriber", "src/subscriber.handler");
 *   ```
 *
 * - `subscribe` no longer takes a handler or a function's args in an output: whether a
 *   function is created is decided from them, and a preview has to know. Only a function
 *   you have, or its ARN, can be an output. The args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check.
 * - `subscribe` and `subscribeQueue` return the bus, where they returned the subscriber:
 *   what each one created is in the bus's `nodes`, by the subscriber's name, like
 *   `bus.nodes.rule.MySubscriber`.
 * - A subscriber's `transform` is the bus's: its `rule` and `target` apply to every
 *   subscriber, and a function there is given the subscriber's name.
 * - A subscriber is created with the provider the bus has. `sst.aws.Bus` gave a function
 *   subscriber only a `provider` passed to the bus itself, and a queue subscriber your
 *   app's provider, whatever the bus had. So if your bus has a `provider` and a queue
 *   subscribed to it, or takes its provider from a parent component or from `providers`,
 *   those subscribers are replaced on switch, a function's log group with it, which
 *   `sst migrate --check` refuses: remove them and deploy before you switch, then add them
 *   back.
 *
 * #### Link the bus to a resource
 *
 * You can link the bus to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [bus]
 * });
 * ```
 *
 * Once linked, you can publish messages to the bus from your app.
 *
 * ```ts title="app/page.tsx" {1,9}
 * import { Resource } from "sst";
 * import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
 *
 * const eb = new EventBridgeClient({});
 *
 * await eb.send(new PutEventsCommand({
 *   Entries: [
 *     {
 *       EventBusName: Resource.MyBus.name,
 *       Source: "my.source",
 *       Detail: JSON.stringify({ foo: "bar" })
 *     }
 *   ]
 * }));
 * ```
 */
export class Bus extends component("sst:aws:Bus", parts) {
  constructor(
    name: string,
    args: BusArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.part("bus", {
      logConfig:
        args.logging &&
        output(args.logging).apply((logging) => ({
          level: logging.level.toUpperCase(),
          includeDetail: logging.detail ? "FULL" : "NONE",
        })),
    });
  }

  /**
   * The ARN of the EventBus.
   */
  public get arn() {
    return this.nodes.bus.arn;
  }

  /**
   * The name of the EventBus.
   */
  public get name() {
    return this.nodes.bus.name;
  }

  /**
   * Subscribe to this EventBus with a function.
   *
   * @param name The name of the subscriber.
   * @param subscriber The function that'll be notified: the handler of one to create, its
   * args, a function component, or the ARN of a function you have. Only a function you
   * have, or its ARN, can be an output.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * bus.subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   *
   * Only receive some events with a pattern.
   *
   * ```js title="sst.config.ts"
   * bus.subscribe("MySubscriber", "src/subscriber.handler", {
   *   pattern: {
   *     detailType: ["order.created", "order.updated"]
   *   }
   * });
   * ```
   */
  public subscribe(
    name: string,
    subscriber: FunctionInput,
    args: BusSubscriberArgs = {},
  ) {
    this.assertNew("subscriber", "rule", name, args, ["rule", "target"]);
    const rule = this.subscriberRule(name, args);
    const fn = functionPart(
      this,
      "subscriber",
      name,
      plainFunction(
        subscriber,
        `The subscriber "${name}" of the "${this.componentName}" bus`,
      ),
      { description: interpolate`Subscribed to ${this.name}` },
    );
    const permission = this.part(
      "permission",
      name,
      invokePermissionArgs(fn, "events.amazonaws.com", rule.arn),
    );
    this.part(
      "target",
      name,
      { arn: fn.targetArn, rule: rule.name, eventBusName: this.name },
      { dependsOn: [permission] },
    );
    return this;
  }

  /**
   * Subscribe to this EventBus with an SQS Queue.
   *
   * @param name The name of the subscriber.
   * @param queue The queue that'll be notified: a queue component, or the ARN of a queue.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * const queue = new sst.aws.v5.Queue("MyQueue");
   *
   * bus.subscribeQueue("MyQueue", queue);
   * ```
   */
  public subscribeQueue(
    name: string,
    queue: Input<string | AnyQueue>,
    args: BusSubscriberArgs = {},
  ) {
    this.assertNew("subscriber", "rule", name, args, ["rule", "target"]);
    const queueArn = output(queue).apply((queue) =>
      typeof queue === "string" ? output(queue) : queue.arn,
    );
    this.part("queuePolicy", name, sendPolicyArgs(queueArn), {
      retainOnDelete: true,
    });
    const rule = this.subscriberRule(name, args);
    this.part("target", name, {
      arn: queueArn,
      rule: rule.name,
      eventBusName: this.name,
    });
    return this;
  }

  // The rule that picks a subscriber's events off the bus: all of them,
  // without a pattern
  private subscriberRule(name: string, args: BusSubscriberArgs) {
    return this.part("rule", name, {
      eventBusName: this.name,
      state: output(args.enabled ?? true).apply((enabled) =>
        enabled ? "ENABLED" : "DISABLED",
      ),
      eventPattern: args.pattern
        ? output(args.pattern).apply((pattern) =>
            JSON.stringify({
              "detail-type": pattern.detailType,
              source: pattern.source,
              detail: pattern.detail,
            }),
          )
        : JSON.stringify({ source: [{ prefix: "" }] }),
    });
  }

  /**
   * Reference an existing EventBus with its name. This is useful when you create a bus in
   * one stage and want to share it in another, or to subscribe to a bus that isn't in your
   * app. The bus is used the way it is: it isn't configured here.
   *
   * @param name The name of the component.
   * @param busName The name of the existing EventBus.
   * @param opts Component resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const bus = $app.stage === "frank"
   *   ? sst.aws.v5.Bus.get("MyBus", "app-dev-MyBus")
   *   : new sst.aws.v5.Bus("MyBus");
   * ```
   */
  public static get(
    name: string,
    busName: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new Bus(name, { existing: { bus: busName } }, opts);
  }

  /**
   * Linking a bus gives the linked resource its name and ARN, and permission
   * to use it.
   */
  public link() {
    return {
      properties: { name: this.name, arn: this.arn },
      include: [permission({ actions: ["events:*"], resources: [this.arn] })],
    };
  }
}
