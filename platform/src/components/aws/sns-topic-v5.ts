import { ComponentResourceOptions, jsonStringify, output } from "@pulumi/pulumi";
import { lambda, sns, sqs } from "@pulumi/aws";
import { V5Args, component, deferred, many } from "../parts-component";
import { withDefault } from "../args";
import type { Input } from "../input";
import type { FunctionArgs, FunctionArn } from "./function";
import { FunctionV5 } from "./function-v5";
import { functionPart } from "./helpers/function-part";
import { invokePermissionArgs } from "./helpers/function-permission";
import { sendPolicyArgs } from "./helpers/queue-policy";
import { permission } from "./permission";
import type { Queue } from "./queue";
import type { QueueV5 } from "./queue-v5";
import type { SnsTopicArgs, SnsTopicSubscriberArgs } from "./sns-topic";

const parts = () => ({
  /**
   * The Amazon SNS Topic.
   */
  topic: sns.Topic,
  /**
   * The functions subscribed to the topic, by subscriber name.
   */
  subscriber: many(deferred(FunctionV5)),
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

export interface SnsTopicV5Args extends V5Args<SnsTopicArgs, typeof parts> {}

export interface SnsTopicV5SubscriberArgs
  extends Omit<SnsTopicSubscriberArgs, "transform"> {}

/**
 * The `SnsTopicV5` component lets you add an [Amazon SNS Topic](https://docs.aws.amazon.com/sns/latest/dg/sns-create-topic.html) to your app.
 *
 * It takes the same args as [`SnsTopic`](/docs/component/aws/sns-topic). It's built from
 * parts, so every resource it creates can be transformed, is available in `nodes`, and can
 * be swapped for one you already have.
 *
 * @example
 *
 * #### Create a topic
 *
 * ```ts title="sst.config.ts"
 * const topic = new sst.aws.SnsTopicV5("MyTopic");
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
 * ```ts title="sst.config.ts"
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [topic]
 * });
 * ```
 *
 * #### Switch from `SnsTopic`
 *
 * Change `SnsTopic` to `SnsTopicV5` and keep the name. The topic and the subscribers you've
 * deployed are kept, as long as the subscribers have names.
 *
 * ```ts title="sst.config.ts" del={1} ins={2}
 * const topic = new sst.aws.SnsTopic("MyTopic");
 * const topic = new sst.aws.SnsTopicV5("MyTopic");
 * ```
 */
export class SnsTopicV5 extends component("sst:aws:SnsTopicV5", parts) {
  constructor(
    name: string,
    args: SnsTopicV5Args = {},
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
   * @param subscriber The function that'll be notified.
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
   * new sst.aws.SnsTopicV5("MyTopic", {
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
    subscriber: Input<string | FunctionArgs | FunctionArn>,
    args: SnsTopicV5SubscriberArgs = {},
  ) {
    this.assertNew("subscriber", "subscription", name, args);

    const fn = functionPart(this, "subscriber", name, subscriber, {
      description: `Subscribed to ${this.componentName}`,
    });
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
   * const queue = new sst.aws.QueueV5("MyQueue");
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
    queue: Input<string | Queue | QueueV5>,
    args: SnsTopicV5SubscriberArgs = {},
  ) {
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
   *   ? sst.aws.SnsTopicV5.get("MyTopic", "arn:aws:sns:us-east-1:123456789012:MyTopic")
   *   : new sst.aws.SnsTopicV5("MyTopic");
   * ```
   */
  public static get(
    name: string,
    topicArn: Input<string>,
    opts?: ComponentResourceOptions,
  ) {
    return new SnsTopicV5(name, { existing: { topic: topicArn } }, opts);
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
