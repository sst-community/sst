import {
  ComponentResourceOptions,
  Output,
  jsonStringify,
  output,
} from "@pulumi/pulumi";
import { lambda, sns, sqs } from "@pulumi/aws";
import {
  type ComponentArgs,
  component,
  deferred,
  many,
} from "../../parts-component";
import { withDefault } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
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
   * The Amazon SNS Topic.
   */
  topic: sns.Topic,
  /**
   * The functions subscribed to the topic, by subscriber name.
   */
  subscriber: many(deferred(Function)),
  /**
   * The permissions that let the topic invoke each subscriber function, by subscriber name.
   */
  permission: many(lambda.Permission),
  /**
   * The topic's subscriptions, by subscriber name.
   */
  subscription: many(sns.TopicSubscription),
  /**
   * The policies that let the topic send to each subscribed queue, by subscriber name.
   */
  queuePolicy: many(sqs.QueuePolicy),
});

export interface SnsTopicArgs extends ComponentArgs<typeof parts> {
  /**
   * FIFO (First-In-First-Out) topics are designed to provide strict message ordering.
   *
   * :::caution
   * Changing a standard topic to a FIFO topic or the other way around will result in the destruction and recreation of the topic.
   * :::
   *
   * @default `false`
   * @example
   * ```js
   * {
   *   fifo: true
   * }
   * ```
   */
  fifo?: Input<boolean>;
}

export interface SnsTopicSubscriberArgs {
  /**
   * Filter the messages that'll be processed by the subscriber.
   *
   * If any single property in the filter doesn't match
   * an attribute assigned to the message, then the policy rejects the message.
   *
   * :::tip
   * Learn more about [subscription filter policies](https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html).
   * :::
   *
   * @example
   * For example, if your SNS Topic message contains this in a JSON format.
   * ```js
   * {
   *   store: "example_corp",
   *   event: "order-placed",
   *   customer_interests: [
   *      "soccer",
   *      "rugby",
   *      "hockey"
   *   ],
   *   price_usd: 210.75
   * }
   * ```
   *
   * Then this filter policy accepts the message.
   *
   * ```js
   * {
   *   filter: {
   *     store: ["example_corp"],
   *     event: [{"anything-but": "order_cancelled"}],
   *     customer_interests: [
   *        "rugby",
   *        "football",
   *        "baseball"
   *     ],
   *     price_usd: [{numeric: [">=", 100]}]
   *   }
   * }
   * ```
   */
  filter?: Input<Record<string, any>>;
}

/**
 * The `SnsTopic` component lets you add an [Amazon SNS Topic](https://docs.aws.amazon.com/sns/latest/dg/sns-create-topic.html) to your app.
 *
 * It's built from parts, so every resource it creates can be transformed, is available in
 * `nodes`, and can be swapped for one you already have.
 *
 * @example
 *
 * #### Create a topic
 *
 * ```ts title="sst.config.ts"
 * const topic = new sst.aws.v5.SnsTopic("MyTopic");
 * ```
 *
 * #### Make it a FIFO topic
 *
 * You can optionally make this a FIFO topic.
 *
 * ```ts {2} title="sst.config.ts"
 * new sst.aws.v5.SnsTopic("MyTopic", {
 *   fifo: true
 * });
 * ```
 *
 * #### Add subscribers
 *
 * Each subscriber has a name.
 *
 * ```ts title="sst.config.ts"
 * topic.subscribe("Emailer", "src/emailer.handler");
 * topic.subscribeQueue("Orders", queue);
 * ```
 *
 * #### Link the topic to a resource
 *
 * You can link the topic to other resources, like a function or your Next.js app.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.Nextjs("MyWeb", {
 *   link: [topic]
 * });
 * ```
 *
 * Once linked, you can publish messages to the topic from your function code.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
 *
 * const sns = new SNSClient({});
 *
 * await sns.send(new PublishCommand({
 *   TopicArn: Resource.MyTopic.arn,
 *   Message: "Hello from Next.js!"
 * }));
 * ```
 *
 * #### Switch from `sst.aws.SnsTopic`
 *
 * Change `sst.aws.SnsTopic` to `sst.aws.v5.SnsTopic` and keep the name. The topic and the
 * subscribers you've deployed are kept, as long as the subscribers have names.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const topic = new sst.aws.SnsTopic("MyTopic");
 * const topic = new sst.aws.v5.SnsTopic("MyTopic");
 * ```
 *
 * A few things work differently:
 *
 * - `subscribe` and `subscribeQueue` take a name first. Without one, they're refused:
 *   `sst.aws.SnsTopic` named such a subscriber after what it subscribed and its filter,
 *   so a switch can't find it. Remove the subscriber and deploy before you switch, then add it back
 *   with a name.
 * - The function `subscribe` takes is a plain value, unless it's a function you have or
 *   its ARN: whether a function is created is decided from it. Its args are typed as
 *   [`sst.aws.v5.Function`](/docs/component/aws/v5/function)'s. Args written the way
 *   `sst.aws.Function` takes them, like `role` or `live`, still work, but don't
 *   type-check.
 * - `subscribe` and `subscribeQueue` return the topic, where they returned the
 *   subscriber: what each one created is in the topic's `nodes`, by the subscriber's
 *   name, like `topic.nodes.subscription.Emailer`.
 * - The `transform` of `subscribe` and `subscribeQueue` becomes the topic's `transform`,
 *   whose function form is given the subscriber's name.
 * - `sst.aws.SnsTopic.subscribe(name, topicArn, subscriber)` becomes
 *   `sst.aws.v5.SnsTopic.get("SharedEvents", topicArn).subscribe(name, subscriber)`, and
 *   the same for `subscribeQueue`. What those created is kept, as long as you don't give
 *   `get` a `provider`: `sst.aws.SnsTopic` created them with your app's, and another one
 *   replaces them, a function's log group included.
 * - A queue subscriber is created with the topic's `provider`. `sst.aws.SnsTopic` created
 *   it with your app's provider, whatever the topic was given. If your topic has a
 *   `provider` and a queue subscribed to it, the subscription and the queue's policy are
 *   replaced on switch: remove the subscriber and deploy before you switch, then add it
 *   back.
 *
 * #### Use a topic you already have
 *
 * Pass the topic, or its ARN.
 *
 * ```ts title="sst.config.ts"
 * new sst.aws.v5.SnsTopic("MyTopic", {
 *   existing: {
 *     topic: "arn:aws:sns:us-east-1:123456789012:my-topic"
 *   }
 * });
 * ```
 */
export class SnsTopic extends component("sst:aws:SnsTopic", parts) {
  constructor(
    name: string,
    args: SnsTopicArgs = {},
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);

    this.part("topic", { fifoTopic: withDefault(args.fifo, false) });
  }

  /**
   * The ARN of the SNS Topic.
   */
  public get arn() {
    return this.nodes.topic.arn;
  }

  /**
   * The name of the SNS Topic.
   */
  public get name() {
    return this.nodes.topic.name;
  }

  /**
   * Subscribe a function to this topic.
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
   * topic.subscribe("MySubscriber", "src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * topic.subscribe("MySubscriber", "src/subscriber.handler", {
   *   filter: {
   *     price_usd: [{numeric: [">=", 100]}]
   *   }
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js title="sst.config.ts"
   * topic.subscribe("MySubscriber", {
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```js title="sst.config.ts"
   * topic.subscribe("MySubscriber", "arn:aws:lambda:us-east-1:123456789012:function:my-function");
   * ```
   *
   * To change how one subscriber is created, use the topic's `transform`. Its function form
   * is given the subscriber's name.
   *
   * ```js title="sst.config.ts"
   * new sst.aws.v5.SnsTopic("MyTopic", {
   *   transform: {
   *     subscription: (args, opts, name, subscriber) => {
   *       if (subscriber === "MySubscriber") args.rawMessageDelivery = true;
   *     }
   *   }
   * });
   * ```
   */
  public subscribe(
    name: string,
    subscriber: FunctionInput,
    args: SnsTopicSubscriberArgs = {},
  ) {
    assertNamed(this.componentName, "subscribe", name, subscriber);
    this.assertNew("subscriber", "subscription", name, args);

    const fn = functionPart(
      this,
      "subscriber",
      name,
      plainFunction(
        subscriber,
        `The subscriber "${name}" of the "${this.componentName}" topic`,
      ),
      { description: `Subscribed to ${this.componentName}` },
    );
    const permission = this.part(
      "permission",
      name,
      invokePermissionArgs(fn, "sns.amazonaws.com", this.arn),
    );
    this.part(
      "subscription",
      name,
      {
        topic: this.arn,
        protocol: "lambda",
        endpoint: fn.targetArn,
        filterPolicy: args.filter && jsonStringify(args.filter),
      },
      { dependsOn: [permission] },
    );

    return this;
  }

  /**
   * Subscribe a queue to this topic.
   *
   * @param name The name of the subscriber.
   * @param queue The queue that'll be notified, or its ARN.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js title="sst.config.ts"
   * const queue = new sst.aws.v5.Queue("MyQueue");
   *
   * topic.subscribeQueue("MySubscriber", queue);
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js title="sst.config.ts"
   * topic.subscribeQueue("MySubscriber", queue, {
   *   filter: {
   *     price_usd: [{numeric: [">=", 100]}]
   *   }
   * });
   * ```
   */
  public subscribeQueue(
    name: string,
    queue: Input<string | AnyQueue>,
    args: SnsTopicSubscriberArgs = {},
  ) {
    assertNamed(this.componentName, "subscribeQueue", name, queue);
    this.assertNew("subscriber", "subscription", name, args);

    const queueArn = output(queue).apply((queue) =>
      typeof queue === "string" ? output(queue) : queue.arn,
    );
    this.part("queuePolicy", name, sendPolicyArgs(queueArn), {
      retainOnDelete: true,
    });
    this.part("subscription", name, {
      topic: this.arn,
      protocol: "sqs",
      endpoint: queueArn,
      filterPolicy: args.filter && jsonStringify(args.filter),
    });

    return this;
  }

  /**
   * Reference an existing SNS topic with its topic ARN. This is useful when you create a
   * topic in one stage and want to share it in another stage, or to subscribe to a topic
   * that isn't in your app.
   *
   * @param name The name of the component.
   * @param topicArn The ARN of the existing SNS Topic.
   * @param opts Component resource options.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const topic = $app.stage === "frank"
   *   ? sst.aws.v5.SnsTopic.get("MyTopic", "arn:aws:sns:us-east-1:123456789012:MyTopic")
   *   : new sst.aws.v5.SnsTopic("MyTopic");
   * ```
   */
  public static get(
    name: string,
    topicArn: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new SnsTopic(name, { existing: { topic: topicArn } }, opts);
  }

  /**
   * Linking a topic gives the linked resource the topic's ARN and permission
   * to use it.
   */
  public link() {
    return {
      properties: { arn: this.arn },
      include: [permission({ actions: ["sns:*"], resources: [this.arn] })],
    };
  }
}

/**
 * `sst.aws.SnsTopic` also took a subscriber without a name, which it named
 * after the subscriber and its filter. Called that way, the arguments are
 * shifted: the subscriber is where the name goes.
 */
function assertNamed(
  topic: string,
  method: string,
  name: unknown,
  target: unknown,
) {
  const isArgs =
    typeof target === "object" &&
    target !== null &&
    !Output.isInstance(target) &&
    Object.getPrototypeOf(target) === Object.prototype &&
    !("handler" in target);
  if (typeof name === "string" && target !== undefined && !isArgs) return;
  throw new VisibleError(
    `"${method}" on the "${topic}" topic takes the subscriber's name first, like ${method}("MySubscriber", ...). A subscriber without a name isn't taken.`,
  );
}
