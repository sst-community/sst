import { takeover } from "../../takeover";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { Queue } from "../v5/queue";
import { childOf } from "./helpers";

// The 4.x `Queue` keeps a subscription in a component of its own, next to the
// queue and named after the queue's ARN. The V5 one keeps it inside the queue.
const SUBSCRIBER = "sst:aws:QueueLambdaSubscriber";
const subscriber = (queue: Queue, name: string) =>
  queue.arn.apply(
    (arn) => `${name}Subscriber${logicalName(hashStringToPrettyString(arn, 6))}`,
  );

takeover(Queue, {
  moved: {
    subscriber: (queue, { name }) =>
      childOf(SUBSCRIBER, subscriber(queue, name), "Function"),
    eventSourceMapping: (queue, { name }) =>
      childOf(SUBSCRIBER, subscriber(queue, name), "EventSourceMapping"),
  },
});
