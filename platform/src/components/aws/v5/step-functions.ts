import {
  all,
  ComponentResourceOptions,
  interpolate,
  Output,
  output,
} from "@pulumi/pulumi";
import { cloudwatch, iam, sfn } from "@pulumi/aws";
import { type ComponentArgs, component, optional } from "../../parts-component";
import { notAnExistingPart, plain } from "../../args";
import type { Input } from "../../input";
import { VisibleError } from "../../error";
import { physicalName } from "../../naming";
import { permission } from "../permission";
import { RETENTION } from "../logging";
import { State } from "../step-functions/state";
import { Choice, ChoiceArgs } from "../step-functions/choice";
import { Fail, FailArgs } from "../step-functions/fail";
import { Map, MapArgs } from "../step-functions/map";
import { Parallel, ParallelArgs } from "../step-functions/parallel";
import { Pass, PassArgs } from "../step-functions/pass";
import { Succeed, SucceedArgs } from "../step-functions/succeed";
import { Task, TaskArgs, TaskBaseArgs } from "../step-functions/task";
import { Wait, WaitArgs } from "../step-functions/wait";
import { JSONata } from "../step-functions/state";
import { Function, FunctionArgs } from "./function";
import {
  type AnyFunction,
  type FunctionInput,
  plainFunction,
} from "../helpers/function-part";
import type { AnyBus } from "../helpers/bus";
import type { AnyQueue } from "../helpers/queue";
import type { AnySnsTopic } from "../helpers/sns-topic";
import type { AnyTask } from "../helpers/task";

const parts = () => ({
  /**
   * The CloudWatch log group the state machine writes its execution logs to, unless
   * `logging` is `false`. One you pass in `existing` is used the way it is, so `logging`
   * doesn't set its `retention`.
   */
  logGroup: optional(cloudwatch.LogGroup),
  /**
   * The IAM role the state machine runs as, with the permissions its states need.
   */
  role: iam.Role,
  /**
   * The Step Functions state machine.
   */
  stateMachine: sfn.StateMachine,
});

export interface StepFunctionsArgs extends ComponentArgs<typeof parts> {
  /**
   * The type of state machine workflow to create.
   *
   * :::caution
   * Changing the type of the state machine workflow will cause the state machine
   * to be destroyed and recreated.
   * :::
   *
   * The `standard` workflow is the default and is meant for long running workflows.
   * The `express` workflow is meant for workflows shorter than 5 minutes.
   *
   * This is because the `express` workflow is run in a single Lambda function. As a
   * result, it's faster and cheaper to run. So if your workflow are short, the
   * `express` workflow is recommended.
   *
   * @default `"standard"`
   * @example
   * ```js
   * {
   *   type: "express"
   * }
   * ```
   */
  type?: Input<"standard" | "express">;
  /**
   * The definition of the state machine. It takes a chain of `State` objects.
   *
   * @example
   *
   * ```ts title="sst.config.ts"
   * const foo = sst.aws.v5.StepFunctions.pass({ name: "Foo" });
   * const bar = sst.aws.v5.StepFunctions.succeed({ name: "Bar" });
   *
   * new sst.aws.v5.StepFunctions("MyStateMachine", {
   *   definition: foo.next(bar)
   * });
   * ```
   */
  definition: State;
  /**
   * Configure the execution logs in CloudWatch. Or pass in `false` to disable writing logs.
   *
   * Whether there are logs decides whether the log group is created, so `logging`
   * itself has to be a plain value, not an output. What's in it can be an output.
   *
   * @default `{retention: "1 month", level: "error", includeData: false}`
   * @example
   * ```js
   * {
   *   logging: false
   * }
   * ```
   */
  logging?:
    | false
    | {
        /**
         * The duration the logs are kept in CloudWatch.
         *
         * @default `1 month`
         * @example
         * ```js
         * {
         *   logging: {
         *     retention: "forever"
         *   }
         * }
         * ```
         */
        retention?: Input<keyof typeof RETENTION>;
        /**
         * Specify whether execution data is included in the logs.
         *
         * @default `false`
         * @example
         * ```js
         * {
         *   logging: {
         *     includeData: true
         *   }
         * }
         * ```
         */
        includeData?: Input<boolean>;
        /**
         * Specify the type of execution events that are logged. Read more about the
         * [Step Functions log level](https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html#cloudwatch-log-level).
         *
         * @default `"error"`
         * @example
         * ```js
         * {
         *   logging: {
         *     level: "all"
         *   }
         * }
         * ```
         */
        level?: Input<"all" | "error" | "fatal">;
      };
}

export interface LambdaInvokeArgs extends TaskBaseArgs {
  /**
   * The function to invoke: the handler of one to create, its args, a `Function`
   * component, or the ARN of an existing Lambda function.
   *
   * A function created from a handler or its args is named after the state, with
   * `Function` added: `InvokeMyFunctionFunction` for the state `InvokeMyFunction`. A
   * handler or the args have to be plain values, since whether a function is created is
   * decided from them. A function you have, or its ARN, can be an output.
   */
  function: Input<string> | FunctionArgs | Input<AnyFunction>;
  /**
   * The payload to send to the Lambda function. Values can include outputs from
   * other resources and JSONata expressions.
   * @example
   *
   * ```ts
   * {
   *   payload: {
   *     env: "{% $states.input.foo %}",
   *     url: api.url,
   *     key: 1
   *   }
   * }
   * ```
   *
   * Or, you can pass in a JSONata expression that evaluates to the full payload.
   *
   * ```ts
   * {
   *   payload: "{% $states.input %}"
   * }
   * ```
   */
  payload?: Input<JSONata | Record<string, Input<unknown>>>;
}

export interface SnsPublishArgs extends TaskBaseArgs {
  /**
   * The `SnsTopic` component to publish the message to.
   */
  topic: AnySnsTopic;
  /**
   * The message to send to the SNS topic.
   */
  message: Input<string>;
  /**
   * The message attributes to send to the SNS topic. Values can include outputs
   * from other resources and JSONata expressions.
   * @example
   *
   * ```ts
   * {
   *   messageAttributes: {
   *     env: "{% $states.input.foo %}",
   *     url: api.url,
   *     key: 1
   *   }
   * }
   * ```
   */
  messageAttributes?: Input<Record<string, Input<string>>>;
  /**
   * The message deduplication ID to send to the SNS topic. This applies to FIFO
   * topics only.
   *
   * This is a string that's used to deduplicate messages sent within the minimum
   * 5 minute interval.
   */
  messageDeduplicationId?: Input<string>;
  /**
   * The message group ID to send to the SNS topic. This only applies to FIFO
   * topics.
   */
  messageGroupId?: Input<string>;
  /**
   * An optional subject line when the message is delivered to email endpoints.
   */
  subject?: Input<string>;
}

export interface SqsSendMessageArgs extends TaskBaseArgs {
  /**
   * The `Queue` component to send the message to.
   */
  queue: AnyQueue;
  /**
   * The message body to send to the SQS queue. The maximum size is 256KB.
   */
  messageBody: Input<string | Record<string, Input<unknown>>>;
  /**
   * The message attributes to send to the SQS queue. Values can include outputs
   * from other resources and JSONata expressions.
   * @example
   *
   * ```ts
   * {
   *   messageAttributes: {
   *     env: "{% $states.input.foo %}",
   *     url: api.url,
   *     key: 1
   *   }
   * }
   * ```
   */
  messageAttributes?: Input<Record<string, Input<string>>>;
  /**
   * The message deduplication ID to send to the SQS queue. This applies to FIFO
   * queues only.
   *
   * This is a string that's used to deduplicate messages sent within the minimum
   * 5 minute interval.
   */
  messageDeduplicationId?: Input<string>;
  /**
   * The message group ID to send to the SQS queue. This only applies to FIFO
   * queues.
   */
  messageGroupId?: Input<string>;
}

export interface EcsRunTaskArgs extends TaskBaseArgs {
  /**
   * The ECS `Task` to run.
   *
   * ```ts title="sst.config.ts" {6}
   * const myCluster = new sst.aws.v5.Cluster("MyCluster");
   * const myTask = new sst.aws.v5.Task("MyTask", { cluster: myCluster });
   *
   * sst.aws.v5.StepFunctions.ecsRunTask({
   *   name: "RunTask",
   *   task: myTask
   * });
   * ```
   */
  task: AnyTask;
  /**
   * The environment variables to apply to the ECS task. Values can include outputs
   * from other resources and JSONata expressions.
   * @example
   *
   * ```ts
   * {
   *   environment: {
   *     MY_ENV: "{% $states.input.foo %}",
   *     MY_URL: api.url,
   *     MY_KEY: 1
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
}

export interface EventBridgePutEventsArgs extends TaskBaseArgs {
  /**
   * A list of events to send to the EventBridge.
   *
   * @example
   * ```ts
   * {
   *   events: [
   *     {
   *       bus: myBus,
   *       source: "my-application",
   *       detailType: "order-created",
   *       detail: {
   *         orderId: "{% $states.input.orderId %}",
   *         customerId: "{% $states.input.customer.id %}",
   *         items: "{% $states.input.items %}"
   *       }
   *     }
   *   ]
   * }
   * ```
   */
  events: {
    /**
     * The `Bus` component to send the event to.
     */
    bus: AnyBus;
    /**
     * The source of the event. This string or JSONata expression identifies the
     * service or component that generated it.
     */
    source?: Input<string>;
    /**
     * The detail type of the event. This helps subscribers filter and route events.
     * This can be a string or JSONata expression.
     */
    detailType?: Input<string>;
    /**
     * The event payload containing the event details as a JSON object.
     * Values can also include a JSONata expression.
     *
     * @example
     * ```ts
     * {
     *   detail: {
     *     type: "order",
     *     message: "{% $states.input.message %}"
     *   }
     * }
     * ```
     */
    detail?: Input<Record<string, Input<unknown>>>;
  }[];
}

/**
 * The `StepFunctions` component lets you add state machines to your app
 * using [AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html).
 *
 * :::note
 * This component is currently in beta. Please [report any issues](https://github.com/sst-community/sst/issues) you find.
 * :::
 *
 * You define your state machine using a collection of states. Where each state
 * needs a unique name. It uses [JSONata](https://jsonata.org) for transforming
 * data between states.
 *
 * @example
 * #### Minimal example
 *
 * The state machine definition is compiled into JSON and passed to AWS.
 *
 * ```ts title="sst.config.ts"
 * const foo = sst.aws.v5.StepFunctions.pass({ name: "Foo" });
 * const bar = sst.aws.v5.StepFunctions.succeed({ name: "Bar" });
 *
 * const definition = foo.next(bar);
 *
 * new sst.aws.v5.StepFunctions("MyStateMachine", {
 *   definition
 * });
 * ```
 *
 * #### Invoking a Lambda function
 *
 * Create a function and invoke it from a state machine.
 *
 * ```ts title="sst.config.ts" {5-8,12}
 * const myFunction = new sst.aws.v5.Function("MyFunction", {
 *   handler: "src/index.handler"
 * });
 *
 * const invoke = sst.aws.v5.StepFunctions.lambdaInvoke({
 *   name: "InvokeMyFunction",
 *   function: myFunction
 * });
 * const done = sst.aws.v5.StepFunctions.succeed({ name: "Done" });
 *
 * new sst.aws.v5.StepFunctions("MyStateMachine", {
 *   definition: invoke.next(done)
 * });
 * ```
 *
 * #### Use the express workflow
 *
 * ```ts title="sst.config.ts" {5}
 * const foo = sst.aws.v5.StepFunctions.pass({ name: "Foo" });
 * const bar = sst.aws.v5.StepFunctions.succeed({ name: "Bar" });
 *
 * new sst.aws.v5.StepFunctions("MyStateMachine", {
 *   type: "express",
 *   definition: foo.next(bar)
 * });
 * ```
 *
 * #### Switch from `sst.aws.StepFunctions`
 *
 * Change `sst.aws.StepFunctions` to `sst.aws.v5.StepFunctions`, its static methods too, and
 * keep the name. The state machine, its role and its log group are kept. A few things are
 * written differently:
 *
 * - `logging` has to be a plain value, not an output: it decides whether the log group is
 *   created. What's in it can still be an output.
 * - `lambdaInvoke` creates a V5 `Function` from a handler or the function's args, with the
 *   name `sst.aws.StepFunctions` gave its function. Switch from `sst.aws.Function` the
 *   same way as that function: its own "Switch from" says what changes. A handler or the
 *   args have to be plain values; a function you have, or its ARN, can be an output.
 * - `snsPublish`, `sqsSendMessage`, `ecsRunTask` and `eventBridgePutEvents` take the V5
 *   `SnsTopic`, `Queue`, `Task` and `Bus`, as well as the 4.x ones.
 * - `nodes` has the role and the log group too.
 * - With `logging: false`, the state machine deploys. `sst.aws.StepFunctions` gave it a log
 *   destination of `undefined:*`, which AWS turns down.
 */
export class StepFunctions extends component("sst:aws:StepFunctions", parts) {
  constructor(
    name: string,
    args: StepFunctionsArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(name, args, opts);
    const self = this;

    const logging = loggingOf();
    const logGroup = logging
      ? this.part(
          "logGroup",
          {
            name: interpolate`/aws/states/${physicalName(
              64,
              `${name}StateMachine`,
            )}`,
            retentionInDays: output(logging.retention).apply(
              (retention) => RETENTION[retention],
            ),
          },
          { ignoreChanges: ["name"] },
        )
      : undefined;

    const root = args.definition.getRoot();
    root.assertStateNameUnique();
    root.assertStateNotReused();

    const role = this.part("role", {
      assumeRolePolicy: iam.assumeRolePolicyForPrincipal({
        Service: "states.amazonaws.com",
      }),
      inlinePolicies: [
        {
          name: "inline",
          policy: iam.getPolicyDocumentOutput({
            statements: [
              {
                actions: ["events:*"],
                resources: ["*"],
              },
              {
                actions: [
                  "logs:CreateLogDelivery",
                  "logs:CreateLogStream",
                  "logs:GetLogDelivery",
                  "logs:UpdateLogDelivery",
                  "logs:DeleteLogDelivery",
                  "logs:ListLogDeliveries",
                  "logs:PutLogEvents",
                  "logs:PutResourcePolicy",
                  "logs:DescribeResourcePolicies",
                  "logs:DescribeLogGroups",
                ],
                resources: ["*"],
              },
              {
                actions: ["states:StartExecution", "states:DescribeExecution"],
                resources: ["*"],
              },
              // A lookup a state makes for its permissions, like a map's
              // bucket's partition, uses the component's provider
              ...root.getPermissions({ parent: self }),
            ],
          }).json,
        },
      ],
    });

    this.part("stateMachine", {
      type: output(args.type ?? "standard").apply((type) => type.toUpperCase()),
      definition: $jsonStringify({
        StartAt: root.name,
        States: root.serialize(),
      }),
      roleArn: role.arn,
      loggingConfiguration: {
        includeExecutionData: output(logging?.includeData ?? false),
        level: output(logging?.level ?? "off").apply((level) =>
          level.toUpperCase(),
        ),
        // Left out without logs. SST 4 wrote `undefined:*`, which AWS turns
        // down, so no state machine of its had it.
        logDestination: logGroup && interpolate`${logGroup.arn}:*`,
      },
    });

    function loggingOf() {
      const owner = `the "${name}" state machine`;
      const logging = plain(args.logging, `The "logging" of ${owner}`);
      if (logging === false) {
        notAnExistingPart(
          args.existing,
          "logGroup",
          owner,
          `Its logs go to a log group only with "logging": remove "logging: false".`,
        );
        return;
      }
      // A log group that's there already keeps its retention
      if (args.existing?.logGroup !== undefined && logging?.retention)
        throw new VisibleError(
          `The "${name}" state machine is given an existing "logGroup", which it uses the way it is. Remove "retention" from its "logging".`,
        );
      return {
        retention: logging?.retention ?? "1 month",
        level: logging?.level ?? "error",
        includeData: logging?.includeData ?? false,
      };
    }
  }

  /**
   * The State Machine ARN.
   */
  public get arn() {
    return this.nodes.stateMachine.arn;
  }

  /**
   * A `Choice` state is used to conditionally continue to different states based
   * on the matched condition.
   *
   * @example
   * ```ts title="sst.config.ts"
   * const processPayment = sst.aws.v5.StepFunctions.choice({ name: "ProcessPayment" });
   *
   * const makePayment = sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "MakePayment",
   *   function: "src/pay.handler"
   * });
   * const sendReceipt = sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "SendReceipt",
   *   function: "src/receipt.handler"
   * });
   * const failure = sst.aws.v5.StepFunctions.fail({ name: "Failure" });
   *
   * processPayment.when("{% $states.input.status === 'unpaid' %}", makePayment);
   * processPayment.when("{% $states.input.status === 'paid' %}", sendReceipt);
   * processPayment.otherwise(failure);
   * ```
   */
  public static choice(args: ChoiceArgs) {
    return new Choice(args);
  }

  /**
   * A `Fail` state is used to fail the execution of a state machine.
   *
   * @example
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.fail({ name: "Failure" });
   * ```
   */
  public static fail(args: FailArgs) {
    return new Fail(args);
  }

  /**
   * A `Map` state is used to iterate over a list of items and execute a task for
   * each item.
   *
   * @example
   * ```ts title="sst.config.ts"
   * const processor = sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "Processor",
   *   function: "src/processor.handler"
   * });
   *
   * sst.aws.v5.StepFunctions.map({
   *   processor,
   *   name: "Map",
   *   items: "{% $states.input.items %}"
   * });
   * ```
   */
  public static map(args: MapArgs) {
    return new Map(args);
  }

  /**
   * A `Parallel` state is used to execute multiple branches of a state in parallel.
   *
   * @example
   * ```ts title="sst.config.ts"
   * const processorA = sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "ProcessorA",
   *   function: "src/processorA.handler"
   * });
   *
   * const processorB = sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "ProcessorB",
   *   function: "src/processorB.handler"
   * });
   *
   * const parallel = sst.aws.v5.StepFunctions.parallel({ name: "Parallel" });
   *
   * parallel.branch(processorA);
   * parallel.branch(processorB);
   * ```
   */
  public static parallel(args: ParallelArgs) {
    return new Parallel(args);
  }

  /**
   * A `Pass` state is used to pass the input to the next state. It's useful for
   * transforming the input before passing it along.
   *
   * @example
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.pass({
   *   name: "Pass",
   *   output: "{% $states.input.message %}"
   * });
   * ```
   */
  public static pass(args: PassArgs) {
    return new Pass(args);
  }

  /**
   * A `Succeed` state is used to indicate that the execution of a state machine
   * has succeeded.
   *
   * @example
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.succeed({ name: "Succeed" });
   * ```
   */
  public static succeed(args: SucceedArgs) {
    return new Succeed(args);
  }

  /**
   * A `Wait` state is used to wait for a specific amount of time before continuing
   * to the next state.
   *
   * @example
   *
   * For example, wait for 10 seconds before continuing to the next state.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.wait({
   *   name: "Wait",
   *   time: 10
   * });
   * ```
   *
   * Alternatively, you can wait until a specific timestamp.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.wait({
   *   name: "Wait",
   *   timestamp: "2026-01-01T00:00:00Z"
   * });
   * ```
   */
  public static wait(args: WaitArgs) {
    return new Wait(args);
  }

  /**
   * A `Task` state can be used to make calls to AWS resources. We created a few
   * convenience methods for common tasks like:
   *
   * - `sst.aws.v5.StepFunctions.lambdaInvoke` to invoke a Lambda function.
   * - `sst.aws.v5.StepFunctions.ecsRunTask` to run an ECS task.
   * - `sst.aws.v5.StepFunctions.eventBridgePutEvents` to send custom events to
   *   EventBridge.
   *
   * For everything else, you can use the `Task` state.
   *
   * @example
   *
   * For example, to start an AWS CodeBuild build.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.task({
   *   name: "Task",
   *   resource: "arn:aws:states:::codebuild:startBuild",
   *   arguments: {
   *     projectName: "my-codebuild-project"
   *   },
   *   permissions: [
   *     {
   *       actions: ["codebuild:StartBuild"],
   *       resources: ["*"]
   *     }
   *   ]
   * });
   * ```
   */
  public static task(args: TaskArgs) {
    return new Task(args);
  }

  /**
   * Create a `Task` state that invokes a Lambda function. [Learn more](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html).
   *
   * @example
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "LambdaInvoke",
   *   function: "src/index.handler"
   * });
   * ```
   *
   * Customize the function.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "LambdaInvoke",
   *   function: {
   *     handler: "src/index.handler",
   *     timeout: "60 seconds"
   *   }
   * });
   * ```
   *
   * Pass in an existing `Function` component.
   *
   * ```ts title="sst.config.ts"
   * const myLambda = new sst.aws.v5.Function("MyLambda", {
   *   handler: "src/index.handler"
   * });
   *
   * sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "LambdaInvoke",
   *   function: myLambda
   * });
   * ```
   *
   * Or pass in the ARN of an existing Lambda function.
   *
   * ```ts title="sst.config.ts"
   * sst.aws.v5.StepFunctions.lambdaInvoke({
   *   name: "LambdaInvoke",
   *   function: "arn:aws:lambda:us-east-1:123456789012:function:my-function"
   * });
   * ```
   */
  public static lambdaInvoke(args: LambdaInvokeArgs) {
    const target = invokedArn(args.name, args.function);
    return new Task({
      ...args,
      resource: "arn:aws:states:::lambda:invoke",
      arguments: {
        FunctionName: target,
        Payload: args.payload,
      },
      permissions: [
        {
          actions: ["lambda:InvokeFunction"],
          resources: [target],
        },
      ],
    });
  }

  /**
   * Create a `Task` state that publishes a message to an SNS topic. [Learn more](https://docs.aws.amazon.com/sns/latest/api/API_Publish.html).
   *
   * @example
   * ```ts title="sst.config.ts"
   * const myTopic = new sst.aws.v5.SnsTopic("MyTopic");
   *
   * sst.aws.v5.StepFunctions.snsPublish({
   *   name: "SnsPublish",
   *   topic: myTopic,
   *   message: "Hello, world!"
   * });
   * ```
   */
  public static snsPublish(args: SnsPublishArgs) {
    return new Task({
      ...args,
      resource: "arn:aws:states:::sns:publish",
      arguments: {
        TopicArn: args.topic.arn,
        Message: args.message,
        MessageAttributes: args.messageAttributes,
        MessageDeduplicationId: args.messageDeduplicationId,
        MessageGroupId: args.messageGroupId,
        Subject: args.subject,
      },
      permissions: [
        {
          actions: ["sns:Publish"],
          resources: [args.topic.arn],
        },
      ],
    });
  }

  /**
   * Create a `Task` state that sends a message to an SQS queue. [Learn more](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html).
   *
   * @example
   * ```ts title="sst.config.ts"
   * const myQueue = new sst.aws.v5.Queue("MyQueue");
   *
   * sst.aws.v5.StepFunctions.sqsSendMessage({
   *   name: "SqsSendMessage",
   *   queue: myQueue,
   *   messageBody: "Hello, world!"
   * });
   * ```
   */
  public static sqsSendMessage(args: SqsSendMessageArgs) {
    return new Task({
      ...args,
      resource: "arn:aws:states:::sqs:sendMessage",
      arguments: {
        QueueUrl: args.queue.url,
        MessageBody: args.messageBody,
        MessageAttributes: args.messageAttributes,
        MessageDeduplicationId: args.messageDeduplicationId,
        MessageGroupId: args.messageGroupId,
      },
      permissions: [
        {
          actions: ["sqs:SendMessage"],
          resources: [args.queue.arn],
        },
      ],
    });
  }

  /**
   * Create a `Task` state that runs an ECS task using the [`Task`](/docs/component/aws/v5/task) component. [Learn more](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html).
   *
   * @example
   * ```ts title="sst.config.ts"
   * const myCluster = new sst.aws.v5.Cluster("MyCluster");
   * const myTask = new sst.aws.v5.Task("MyTask", { cluster: myCluster });
   *
   * sst.aws.v5.StepFunctions.ecsRunTask({
   *   name: "RunTask",
   *   task: myTask
   * });
   * ```
   */
  public static ecsRunTask(args: EcsRunTaskArgs) {
    const task = args.task;
    return new Task({
      ...args,
      resource: "arn:aws:states:::ecs:runTask",
      arguments: {
        Cluster: task.cluster,
        TaskDefinition: task.taskDefinition,
        LaunchType: "FARGATE",
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: task.subnets,
            SecurityGroups: task.securityGroups,
            AssignPublicIp: output(task.assignPublicIp).apply((v) =>
              v ? "ENABLED" : "DISABLED",
            ),
          },
        },
        Overrides:
          args.environment &&
          all([
            args.environment,
            output(task.containers as Input<string[]>),
          ]).apply(([environment, containers]) => ({
            ContainerOverrides: containers.map((name: string) => ({
              Name: name,
              Environment: Object.entries(environment).map(([name, value]) => ({
                Name: name,
                Value: value,
              })),
            })),
          })),
      },
      permissions: [
        {
          actions: ["ecs:RunTask"],
          resources: [task.nodes.taskDefinition.arn],
        },
        {
          actions: ["iam:PassRole"],
          resources: [task.nodes.executionRole.arn, task.nodes.taskRole.arn],
        },
      ],
    });
  }

  /**
   * Create a `Task` state that sends custom events to one or more EventBridge buses
   * using the [`Bus`](/docs/component/aws/v5/bus) component. [Learn more](https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html).
   *
   * @example
   * ```ts title="sst.config.ts"
   * const myBus = new sst.aws.v5.Bus("MyBus");
   *
   * sst.aws.v5.StepFunctions.eventBridgePutEvents({
   *   name: "EventBridgePutEvents",
   *   events: [
   *     {
   *       bus: myBus,
   *       source: "my-source"
   *     }
   *   ]
   * });
   * ```
   */
  public static eventBridgePutEvents(args: EventBridgePutEventsArgs) {
    const busArns = output(args.events).apply((events) =>
      all(events.map((event) => event.bus.arn)).apply((arns) =>
        arns.filter((arn, index, self) => self.indexOf(arn) === index),
      ),
    );

    return new Task({
      ...args,
      resource: "arn:aws:states:::events:putEvents",
      arguments: {
        Entries: output(args.events).apply((events) =>
          events.map((event) => ({
            EventBusName: event.bus.name,
            Source: event.source,
            DetailType: event.detailType,
            Detail: event.detail,
          })),
        ),
      },
      permissions: [
        {
          actions: ["events:PutEvents"],
          resources: busArns,
        },
      ],
    });
  }

  link() {
    return {
      properties: {
        arn: this.arn,
      },
      include: [
        permission({
          actions: ["states:*"],
          resources: [
            this.arn,
            this.arn.apply(
              (arn) => `${arn.replace("stateMachine", "execution")}:*`,
            ),
          ],
        }),
        permission({
          actions: [
            "states:SendTaskSuccess",
            "states:SendTaskFailure",
            "states:SendTaskHeartbeat",
          ],
          resources: ["*"],
        }),
      ],
    };
  }
}

/**
 * The ARN a `lambdaInvoke` state invokes: of the function it's given, or of
 * one it creates at the top of the app from a handler or args, named after
 * the state as SST 4 named it.
 */
function invokedArn(
  state: string,
  fn: LambdaInvokeArgs["function"],
): Output<string> {
  const definition = plainFunction(
    fn as FunctionInput,
    `The "function" of the "${state}" state`,
  );
  if (Output.isInstance(definition))
    return (definition as Output<string | AnyFunction>).apply((value) =>
      typeof value === "string" ? value : value.targetArn,
    ) as Output<string>;
  if (typeof definition === "string")
    return definition.startsWith("arn:")
      ? output(definition)
      : new Function(`${state}Function`, { handler: definition }).targetArn;
  // A function, either kind, or the args of one to create
  if (definition instanceof Function || "targetArn" in (definition as object))
    return output((definition as AnyFunction).targetArn) as Output<string>;
  return new Function(`${state}Function`, definition as FunctionArgs).targetArn;
}
