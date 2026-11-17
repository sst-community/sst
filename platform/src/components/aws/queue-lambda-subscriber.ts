import {
  all,
  ComponentResourceOptions,
  Input,
  Output,
  output,
} from "@pulumi/pulumi";
import { Component, transform, Transform } from "../component";
import { Function, FunctionArgs } from "./function.js";
import { Workflow } from "./workflow.js";
import { VisibleError } from "../error";
import { QueueSubscriberArgs } from "./queue";
import { lambda } from "@pulumi/aws";
import { Duration, toSeconds } from "../duration";
import { FunctionBuilder, functionBuilder } from "./helpers/function-builder";

export interface Args extends QueueSubscriberArgs {
  /**
   * The queue to use.
   */
  queue: Input<{
    /**
     * The ARN of the queue.
     */
    arn: Input<string>;
  }>;
  /**
   * The subscriber function.
   */
  subscriber: Input<string | Workflow | FunctionArgs>;
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: QueueSubscriberArgs["transform"];
}

/**
 * The `QueueLambdaSubscriber` component is internally used by the `Queue` component to
 * add a consumer to [Amazon SQS](https://aws.amazon.com/sqs/).
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `subscribe` method of the `Queue` component.
 */
export class QueueLambdaSubscriber extends Component {
  private readonly fn: FunctionBuilder;
  private readonly eventSourceMapping: lambda.EventSourceMapping;

  constructor(name: string, args: Args, opts?: ComponentResourceOptions) {
    super(__pulumiType, name, args, opts);

    const self = this;
    const queue = output(args.queue);
    const fn = createFunction();
    const eventSourceMapping = createEventSourceMapping();

    this.fn = fn;
    this.eventSourceMapping = eventSourceMapping;

    function createFunction() {
      return functionBuilder(
        name,
        args.subscriber,
        {
          description: `Subscribed to ${name}`,
          permissions: [
            {
              actions: [
                "sqs:ChangeMessageVisibility",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
                "sqs:ReceiveMessage",
              ],
              resources: [queue.arn],
            },
          ],
        },
        args.transform?.function,
        { parent: self, aliases: [{ name: `${name}Function` }] },
      );
    }

    function checkWorkflowTimeout() {
      return output(args.subscriber).apply((subscriber) => {
        if (!(subscriber instanceof Workflow)) return;
        return subscriber
          .getExecutionTimeout()
          .apply((timeout) => checkQueueWorkflowTimeout(name, timeout));
      });
    }

    function createEventSourceMapping() {
      const [mappingName, mappingArgs, mappingOpts] = transform(
        args.transform?.eventSourceMapping,
        `${name}EventSourceMapping`,
        {
          functionResponseTypes: output(args.batch).apply((batch) =>
            batch?.partialResponses ? ["ReportBatchItemFailures"] : [],
          ),
          batchSize: output(args.batch).apply((batch) => batch?.size ?? 10),
          maximumBatchingWindowInSeconds: output(args.batch).apply((batch) =>
            batch?.window ? toSeconds(batch.window) : 0,
          ),
          eventSourceArn: queue.arn,
          functionName: all([fn.targetArn, checkWorkflowTimeout()]).apply(
            ([arn]) => arn,
          ),
          filterCriteria: args.filters && {
            filters: output(args.filters).apply((filters) =>
              filters.map((filter) => ({
                pattern: JSON.stringify(filter),
              })),
            ),
          },
        },
        { parent: self },
      );
      warnFewInFlight(mappingArgs);
      return new lambda.EventSourceMapping(
        mappingName,
        mappingArgs,
        mappingOpts,
      );
    }

    // Read after the transform, where a maximum concurrency is set.
    function warnFewInFlight(mappingArgs: lambda.EventSourceMappingArgs) {
      all([
        output(args.subscriber),
        mappingArgs.scalingConfig,
        mappingArgs.batchSize,
      ]).apply(([subscriber, scalingConfig, batchSize]) => {
        if (!(subscriber instanceof Workflow)) return;
        const warning = queueWorkflowInFlightWarning(
          name,
          scalingConfig?.maximumConcurrency,
          batchSize,
        );
        if (warning) console.warn(warning);
      });
    }
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    const self = this;
    return {
      /**
       * The Lambda function that'll be notified.
       */
      get function() {
        return self.fn.apply((fn) => fn.getFunction());
      },
      /**
       * The Lambda event source mapping.
       */
      eventSourceMapping: this.eventSourceMapping,
    };
  }
}

/**
 * A queue invokes a workflow synchronously, and AWS refuses to create the event
 * source mapping if the whole execution may take longer than a synchronous
 * invocation can. Say why, instead of with AWS's error.
 * @internal
 */
export function checkQueueWorkflowTimeout(name: string, timeout: Duration) {
  if (toSeconds(timeout) <= 15 * 60) return;
  throw new VisibleError(
    `The "${name}" queue subscriber is a workflow with an execution timeout of "${timeout}". A queue waits for a workflow to finish, so its "timeout.execution" can be at most "15 minutes". For a longer workflow, subscribe a function that starts it with "workflow.dispatcher()".`,
  );
}

/**
 * A subscriber has at most its maximum concurrency times its batch size in
 * messages in flight, and SQS fair queues need many in flight to take effect:
 * AWS says a tenant needs at least 30. Measured on AWS (one tenant's backlog,
 * then 5 messages from another, batch size 1, 10 s per message), the second
 * tenant's messages waited for the whole backlog at a maximum concurrency of
 * 10, 20 and 30, about half of it at 40, and about 33 s of a 165 s backlog at 50.
 * @internal
 */
export const FAIR_QUEUE_MIN_IN_FLIGHT = 50;

/**
 * A workflow subscriber capped below the messages in flight that fair queues
 * need gets no fairness between tenants. It can be what you want, if the
 * messages have no `MessageGroupId`, so it's a warning.
 * @internal
 */
export function queueWorkflowInFlightWarning(
  name: string,
  maximumConcurrency: number | undefined,
  batchSize: number | undefined,
) {
  if (maximumConcurrency === undefined) return;
  const inFlight = maximumConcurrency * (batchSize ?? 10);
  if (inFlight >= FAIR_QUEUE_MIN_IN_FLIGHT) return;
  return `The "${name}" queue subscriber is a workflow with at most ${inFlight} messages in flight (a maximum concurrency of ${maximumConcurrency} and a batch size of ${
    batchSize ?? 10
  }). If its messages have a MessageGroupId, SQS fair queues need about ${FAIR_QUEUE_MIN_IN_FLIGHT} in flight to deliver the messages of quieter tenants first.`;
}

const __pulumiType = "sst:aws:QueueLambdaSubscriber";
// @ts-expect-error
QueueLambdaSubscriber.__pulumiType = __pulumiType;
