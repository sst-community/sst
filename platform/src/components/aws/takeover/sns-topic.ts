import { takeover } from "../../takeover";
import { SnsTopic } from "../v5/sns-topic";
import { childOf } from "./helpers";

// The 4.x `SnsTopic` keeps each subscription in a component of its own, next to
// the topic and named after the subscriber. The V5 one keeps them inside the
// topic. A subscriber that was added without a name isn't carried over: its
// name was made from the topic's ARN, the filter and the handler.
const FUNCTION = "sst:aws:SnsTopicLambdaSubscriber";
const QUEUE = "sst:aws:SnsTopicQueueSubscriber";
const subscriber = (topic: string, name?: string) => `${topic}Subscriber${name}`;

takeover(SnsTopic, {
  from: "sst:aws:SnsTopic",
  moved: {
    subscriber: (_, { name, id }) =>
      childOf(FUNCTION, subscriber(name, id), "Function"),
    permission: (_, { name, id }) =>
      childOf(FUNCTION, subscriber(name, id), "Permission"),
    // A subscription was in either kind of subscriber
    subscription: (_, { name, id }) => [
      childOf(FUNCTION, subscriber(name, id), "Subscription"),
      childOf(QUEUE, subscriber(name, id), "Subscription"),
    ],
    queuePolicy: (_, { name, id }) =>
      childOf(QUEUE, subscriber(name, id), "Policy"),
  },
});
