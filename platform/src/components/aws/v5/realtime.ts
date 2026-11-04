import {
  ComponentResourceOptions,
  interpolate,
  Output,
  output,
} from "@pulumi/pulumi";
import { iot, lambda } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
  named,
} from "../../parts-component";
import { plain } from "../../args";
import { VisibleError } from "../../error";
import type { Input } from "../../input";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { permission } from "../permission";
import {
  type FunctionInput,
  functionPart,
  plainFunction,
} from "../helpers/function-part";
import { invokePermissionArgs } from "../helpers/function-permission";
import { Function, type FunctionArgs } from "./function";

const parts = () => ({
  /**
   * The AWS Lambda function that authorizes clients when they connect. An output, as
   * it's created once its args are known.
   */
  authHandler: named(deferred(Function), "AuthorizerHandler"),
  /**
   * The IoT authorizer.
   */
  authorizer: iot.Authorizer,
  /**
   * The permission for IoT to invoke the authorizer function.
   */
  permission: lambda.Permission,
  /**
   * Each subscriber's function, by the subscriber's name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The permission for IoT to invoke each subscriber, by the subscriber's name.
   */
  subscriberPermission: many(lambda.Permission),
  /**
   * The IoT topic rule that sends each subscriber its messages, by the subscriber's
   * name.
   */
  topicRule: many(iot.TopicRule),
});

export interface RealtimeArgs extends ComponentArgs<typeof parts> {
  /**
   * The Lambda function that'll be used to authorize the client on connection.
   *
   * A handler or the function's args have to be plain values, not outputs; what's in
   * the args can be an output.
   *
   * @example
   * ```js
   * {
   *   authorizer: "src/authorizer.handler"
   * }
   * ```
   */
  authorizer: string | FunctionArgs;
}

export interface RealtimeSubscriberArgs {
  /**
   * Filter the topics that'll be processed by the subscriber.
   *
   * :::tip
   * Learn more about [topic filters](https://docs.aws.amazon.com/iot/latest/developerguide/topics.html#topicfilters).
   * :::
   *
   * A subscriber without a `name` is named after its filter and its handler, so its filter
   * has to be a plain value, not an output.
   *
   * @example
   * Subscribe to a specific topic.
   * ```js
   * {
   *   filter: `${$app.name}/${$app.stage}/chat/room1`
   * }
   * ```
   *
   * Subscribe to all topics under a prefix.
   * ```js
   * {
   *   filter: `${$app.name}/${$app.stage}/chat/#`
   * }
   * ```
   */
  filter: Input<string>;
  /**
   * The name of the subscriber. Its function, permission and topic rule are named after
   * it, and it's how the server's `transform` and `nodes` know it.
   *
   * Without one, a subscriber is named after a hash of its filter and its handler, so
   * changing either replaces it. A subscriber that's a function you have, or an output,
   * has no handler to be named after: give it a name.
   *
   * Must be unique across the server's subscribers. A plain value, not an output.
   *
   * @example
   * ```js
   * {
   *   name: "ChatLogger"
   * }
   * ```
   */
  name?: string;
}

/**
 * The `Realtime` component lets you publish and subscribe to messages in realtime.
 *
 * It offers a **topic-based** messaging network using [AWS IoT](https://docs.aws.amazon.com/iot/latest/developerguide/what-is-aws-iot.html). Letting you publish and subscribe to messages using
 * a WebSocket in the browser and your server.
 *
 * Also, provides an [SDK](#sdk) to authorize clients, grant permissions to subscribe, and
 * publish to topics.
 *
 * :::note
 * IoT is shared across all apps and stages in your AWS account. So you need to prefix the
 * topics by the app and stage name.
 * :::
 *
 * There is **only 1 IoT endpoint** per region per AWS account. Messages from all apps and
 * stages are published to the same IoT endpoint. Make sure to prefix the topics by the
 * app and stage name.
 *
 * @example
 *
 * #### Create a realtime endpoint
 *
 * ```ts title="sst.config.ts"
 * const server = new sst.aws.v5.Realtime("MyServer", {
 *   authorizer: "src/authorizer.handler"
 * });
 * ```
 *
 * #### Authorize the client
 *
 * ```ts title="src/authorizer.ts" "realtime.authorizer"
 * import { Resource } from "sst/aws";
 * import { realtime } from "sst/aws/realtime";
 *
 * export const handler = realtime.authorizer(async (token) => {
 *   // Validate the token
 *
 *   // Return the topics to subscribe and publish
 *   return {
 *     subscribe: [`${Resource.App.name}/${Resource.App.stage}/chat/room1`],
 *     publish: [`${Resource.App.name}/${Resource.App.stage}/chat/room1`],
 *   };
 * });
 * ```
 *
 * #### Publish and receive messages in your frontend
 *
 * ```ts title="app/page.tsx"
 * import { Resource } from "sst/aws";
 *
 * const client = new mqtt.MqttClient();
 * // Configure with
 * // - Resource.Realtime.endpoint
 * // - Resource.Realtime.authorizer
 * const connection = client.new_connection(config);
 *
 * // Subscribe messages
 * connection.on("message", (topic, payload) => {
 *   // Handle the message
 * });
 *
 * // Publish messages
 * connection.publish(topic, payload, mqtt.QoS.AtLeastOnce);
 * ```
 *
 * #### Subscribe messages in your backend
 *
 * ```ts title="sst.config.ts"
 * server.subscribe("src/subscriber.handler", {
 *   filter: `${$app.name}/${$app.stage}/chat/room1`
 * });
 * ```
 *
 * #### Publish message from your backend
 *
 * ```ts title="src/lambda.ts"
 * import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
 * const data = new IoTDataPlaneClient();
 * await data.send(
 *   new PublishCommand({
 *     payload: Buffer.from(
 *       JSON.stringify({ message: "Hello world" })
 *     ),
 *     topic: `${Resource.App.name}/${Resource.App.stage}/chat/room1`,
 *   })
 * );
 * ```
 *
 * #### Switch from `sst.aws.Realtime`
 *
 * Change `sst.aws.Realtime` to `sst.aws.v5.Realtime` and keep the name. The authorizer, its
 * function and permission, and every subscriber's function, permission and topic rule are
 * kept. A few things are written differently:
 *
 * - The subscribers are inside the component, where `sst.aws.Realtime` kept each in a
 *   component of its own at the top of the app. Each subscriber's function is
 *   `nodes.subscriber`, by its name, the hash `sst.aws.Realtime` named it with.
 * - A subscriber can be given a `name`, which its resources are named after, and can be a
 *   function you have, as well as a handler, the function's args or an ARN. A function
 *   you have needs a name. A subscriber you've deployed keeps its place without one: given
 *   a name, it's a new subscriber, and the deployed one is removed, its function's log
 *   group with it.
 * - A subscriber's `transform.topicRule` is the component's `transform.topicRule`, which
 *   applies to every subscriber and is given the subscriber's name in a function. A
 *   subscriber's own `transform` is refused.
 * - `subscribe` returns the component, not the subscriber.
 * - The authorizer's handler or args have to be plain values, not outputs. So do a
 *   subscriber's, and its `filter`, when it has no `name`: it's named after them. A
 *   subscriber that was given as an output, like a function's `arn`, is kept when it's
 *   given its ARN as a string.
 * - A function's args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s; args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check. Inside them, what it's built from, like `handler`, `runtime` or `bundle`,
 *   and what decides what's created, like `url` or `logging`, are plain values, as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function) takes them.
 * - `nodes.authHandler` is an output, as it was, and `nodes` has the authorizer's
 *   permission too.
 * - A subscriber is created with the provider the server has. `sst.aws.Realtime` gave it
 *   only a `provider` passed to the server itself, so if your server takes its provider
 *   from a parent component or from `providers`, the switch gives its subscribers that
 *   provider and keeps them, with the provider's default tags.
 */
export class Realtime extends component("sst:aws:Realtime", parts) {
  private readonly iotEndpoint: Output<string>;
  private readonly namedSubscribers = new Set<string>();

  constructor(
    name: string,
    args: RealtimeArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    const authHandler = functionPart(this, "authHandler", authorizerOf(), {});
    const authorizer = this.part("authorizer", {
      signingDisabled: true,
      authorizerFunctionArn: authHandler.arn,
    });
    this.part("permission", {
      action: "lambda:InvokeFunction",
      function: authHandler.arn,
      principal: "iot.amazonaws.com",
      sourceArn: authorizer.arn,
    });

    this.iotEndpoint = iot.getEndpointOutput(
      { endpointType: "iot:Data-ATS" },
      { parent: this },
    ).endpointAddress;

    // The authorizer's function, as SST 4 wrote it: its own description, and
    // what it may do on IoT after the user's permissions
    function authorizerOf(): string | FunctionArgs {
      const given = plain(
        args.authorizer,
        `The "authorizer" of the "${name}" realtime server`,
      );
      const description = `Authorizer for ${name}`;
      const iotAccess = { actions: ["iot:*"], resources: ["*"] };
      if (typeof given === "string")
        return { handler: given, description, permissions: [iotAccess] };
      return {
        ...given,
        description,
        permissions: output(given.permissions).apply((permissions) => [
          ...(permissions ?? []),
          iotAccess,
        ]),
      };
    }
  }

  /**
   * The IoT endpoint.
   */
  public get endpoint() {
    return this.iotEndpoint;
  }

  /**
   * The name of the IoT authorizer.
   */
  public get authorizer() {
    return this.nodes.authorizer.name;
  }

  /**
   * Subscribe to this Realtime server.
   *
   * @param subscriber The function that'll be notified: the handler of one to create, its
   * args, a function you have, or the ARN of one. Only a function you have, or its ARN,
   * can be an output, and only for a subscriber with a `name`.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * server.subscribe("src/subscriber.handler", {
   *   filter: `${$app.name}/${$app.stage}/chat/room1`
   * });
   * ```
   *
   * Give the subscriber a name. Its resources are named after it, and the server's
   * `transform` and `nodes` know it by it.
   *
   * ```js title="sst.config.ts"
   * server.subscribe("src/subscriber.handler", {
   *   filter: `${$app.name}/${$app.stage}/chat/room1`,
   *   name: "ChatLogger"
   * });
   * ```
   *
   * Subscribe a function you have. It needs a name.
   *
   * ```js title="sst.config.ts"
   * const logger = new sst.aws.v5.Function("Logger", {
   *   handler: "src/logger.handler"
   * });
   *
   * server.subscribe(logger, {
   *   filter: `${$app.name}/${$app.stage}/chat/#`,
   *   name: "Logger"
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * server.subscribe(
   *   {
   *     handler: "src/subscriber.handler",
   *     timeout: "60 seconds"
   *   },
   *   {
   *     filter: `${$app.name}/${$app.stage}/chat/room1`
   *   }
   * );
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * server.subscribe("arn:aws:lambda:us-east-1:123456789012:function:my-function", {
   *   filter: `${$app.name}/${$app.stage}/chat/room1`
   * });
   * ```
   */
  public subscribe(subscriber: FunctionInput, args: RealtimeSubscriberArgs) {
    const name = this.componentName;
    const owner = `the "${name}" realtime server`;
    const subscriberName = plain(
      args.name,
      `The "name" of a subscriber of ${owner}`,
      "The subscriber is named after it.",
    );
    let id: string;
    if (subscriberName !== undefined) id = subscriberName;
    else {
      // Named after its filter and its handler, as SST 4 named it
      const given = plain(
        subscriber,
        `A subscriber of ${owner}`,
        `It's named after its handler. Give it a "name" to subscribe a function, or its ARN, given as an output.`,
      );
      const filter = plain(
        args.filter,
        `The "filter" of a subscriber of ${owner}`,
        `The subscriber is named after it. Give it a "name" to subscribe it to a filter that's an output.`,
      );
      // A function you have, rather than a handler or a function's args
      if (typeof given !== "string" && !isArgs(given))
        throw new VisibleError(
          `A subscriber of ${owner} without a "name" is named after its handler, and a function you have has none to read. Give it a name: subscribe(fn, { filter: "${filter}", name: "MySubscriber" }).`,
        );
      id = logicalName(
        hashStringToPrettyString(
          [filter, typeof given === "string" ? given : given.handler].join(""),
          6,
        ),
      );
      if (this.hasSubscriber(id))
        throw new VisibleError(
          `The "${name}" realtime server already has a subscriber with the filter "${filter}" and this handler. Subscribe each handler to a filter once.`,
        );
    }
    this.assertNew("subscriber", "subscriber", id, args, [
      "subscriber",
      "subscriberPermission",
      "topicRule",
    ]);
    if (subscriberName !== undefined) this.namedSubscribers.add(id);

    const filter = args.filter;
    const fn = functionPart(
      this,
      "subscriber",
      id,
      plainFunction(
        subscriber,
        subscriberName === undefined
          ? `A subscriber of ${owner}`
          : `The subscriber "${subscriberName}" of ${owner}`,
      ),
      {
        description:
          typeof filter === "string"
            ? `Subscribed to ${name} on ${filter}`
            : interpolate`Subscribed to ${name} on ${filter}`,
      },
    );
    const rule = this.part("topicRule", id, {
      sqlVersion: "2016-03-23",
      sql: interpolate`SELECT * FROM '${filter}'`,
      enabled: true,
      lambdas: [{ functionArn: fn.targetArn }],
    });
    this.part(
      "subscriberPermission",
      id,
      invokePermissionArgs(fn, "iot.amazonaws.com", rule.arn),
    );
    return this;
  }

  private hasSubscriber(id: string) {
    return this.nodes.topicRule[id] !== undefined;
  }

  /**
   * Whether the subscriber kept under `id` was given a `name`, rather than
   * kept under the hash of its filter and handler.
   * @internal
   */
  public subscriberIsNamed(id: string) {
    return this.namedSubscribers.has(id);
  }

  link() {
    return {
      properties: {
        endpoint: this.endpoint,
        authorizer: this.authorizer,
      },
      include: [
        permission({
          actions: ["iot:Publish"],
          resources: ["*"],
        }),
      ],
    };
  }
}

// A function's args, as a plain object, rather than a function component
function isArgs(value: unknown): value is FunctionArgs {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
