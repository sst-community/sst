import { takeover } from "../../takeover";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { QueueV5 } from "../queue-v5";
import { childOf } from "./helpers";

// `Queue` keeps a subscription in a component of its own, next to the queue
// and named after the queue's ARN. `QueueV5` keeps it inside the queue.
const SUBSCRIBER = "sst:aws:QueueLambdaSubscriber";
const subscriber = (queue: QueueV5, name: string) =>
  queue.arn.apply(
    (arn) => `${name}Subscriber${logicalName(hashStringToPrettyString(arn, 6))}`,
  );

takeover(QueueV5, {
  from: "sst:aws:Queue",
  moved: {
    subscriber: (queue, { name }) =>
      childOf(SUBSCRIBER, subscriber(queue, name), "Function"),
    eventSourceMapping: (queue, { name }) =>
      childOf(SUBSCRIBER, subscriber(queue, name), "EventSourceMapping"),
  },
});
