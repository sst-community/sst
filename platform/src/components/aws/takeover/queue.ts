import { takeover } from "../../takeover";
import { hashStringToPrettyString, logicalName } from "../../naming";
import { Queue } from "../queue";
import { parseQueueArn } from "../helpers/arn";
import { childOf, subscriberFunction } from "./helpers";

// The 4.x `Queue` keeps a subscription in a component of its own, named after
// the queue's ARN. The V5 one keeps it inside the queue. 4.x created that
// component at the top of the app, or next to the queue when it was given the
// queue's parent: the 4.x `Nextjs` subscribes to its revalidation queue that way.
const SUBSCRIBER = "sst:aws:QueueLambdaSubscriber";
const subscriber = (queue: Queue, name: string) =>
  queue.arn.apply(
    (arn) => `${name}Subscriber${logicalName(hashStringToPrettyString(arn, 6))}`,
  );

// The static `Queue.subscribe()` only had the queue's ARN, and named the
// component after the queue's own name. `get` and `subscribe` take its place,
// and `get` is given the options it was: a `parent` puts the queue where the
// component was.
const staticSubscriber = (queue: Queue) =>
  queue.arn.apply(
    (arn) =>
      `${logicalName(parseQueueArn(arn).queueName)}Subscriber${logicalName(hashStringToPrettyString(arn, 6))}`,
  );

takeover(Queue, {
  moved: {
    subscriber: (queue, { name }) => [
      ...subscriberFunction(SUBSCRIBER, subscriber(queue, name)),
      ...subscriberFunction(SUBSCRIBER, subscriber(queue, name), queue),
      ...subscriberFunction(SUBSCRIBER, staticSubscriber(queue)),
      ...subscriberFunction(SUBSCRIBER, staticSubscriber(queue), queue),
    ],
    eventSourceMapping: (queue, { name }) => [
      childOf(SUBSCRIBER, subscriber(queue, name), "EventSourceMapping"),
      childOf(SUBSCRIBER, subscriber(queue, name), "EventSourceMapping", queue),
      childOf(SUBSCRIBER, staticSubscriber(queue), "EventSourceMapping"),
      childOf(SUBSCRIBER, staticSubscriber(queue), "EventSourceMapping", queue),
    ],
  },
});
