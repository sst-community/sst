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
import { hashStringToPrettyString, logicalName } from "../../naming";
import { permission } from "../permission";
import { functionPart, plainFunction } from "../helpers/function-part";
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
   * The subscriber is named after its filter and its handler, so the filter has to be a
   * plain value, not an output.
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
  filter: string;
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
 * - A subscriber's `transform.topicRule` is the component's `transform.topicRule`, which
 *   applies to every subscriber and is given the subscriber's name in a function. A
 *   subscriber's own `transform` is refused.
 * - `subscribe` returns the component, not the subscriber.
 * - The authorizer's handler or args, a subscriber's, and its `filter` have to be plain
 *   values, not outputs: the subscriber is named after them. A subscriber that was given as
 *   an output, like a function's `arn`, is kept when it's given its ARN as a string.
 * - `nodes.authHandler` is an output, as it was, and `nodes` has the authorizer's
 *   permission too.
 */
export class Realtime extends component("sst:aws:Realtime", parts) {
  private readonly iotEndpoint: Output<string>;

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
   * @param subscriber The function that'll be notified.
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
  public subscribe(
    subscriber: string | FunctionArgs,
    args: RealtimeSubscriberArgs,
  ) {
    const name = this.componentName;
    const what = `A subscriber of the "${name}" realtime server`;
    const given = plain(subscriber, what, "It's named after its handler.");
    const filter = plain(
      args.filter,
      `The "filter" of a subscriber of the "${name}" realtime server`,
      "The subscriber is named after it.",
    );
    // Named after its filter and its handler, as SST 4 named it
    const id = logicalName(
      hashStringToPrettyString(
        [filter, typeof given === "string" ? given : given.handler].join(""),
        6,
      ),
    );
    if (this.hasSubscriber(id))
      throw new VisibleError(
        `"${name}" already has a subscriber with the filter "${filter}" and this handler. Subscribe each handler to a filter once.`,
      );
    this.assertNew("subscriber", "subscriber", id, args, [
      "subscriber",
      "subscriberPermission",
      "topicRule",
    ]);

    const fn = functionPart(
      this,
      "subscriber",
      id,
      plainFunction(given, what),
      { description: `Subscribed to ${name} on ${filter}` },
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
