import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { SnsTopic } from "../sns-topic";
import { parseTopicArn } from "../helpers/arn";
import { childOf, subscriberFunction } from "./helpers";

// The 4.x `SnsTopic` keeps each subscription in a component of its own, next to
// the topic and named after the subscriber. The V5 one keeps them inside the
// topic. A subscriber that was added without a name isn't carried over: its
// name was made from the topic's ARN, the filter and the handler.
const FUNCTION = "sst:aws:SnsTopicLambdaSubscriber";
const QUEUE = "sst:aws:SnsTopicQueueSubscriber";
const subscriber = (topic: string, name?: string) => `${topic}Subscriber${name}`;
// The static `SnsTopic.subscribe()` and `subscribeQueue()` only had the
// topic's ARN, and named the component after the topic's own name, at the top
// of the app. `get` and the method take their place. As in 4.x, that name can
// be another topic component's: a switch that adds a subscriber to a topic
// named `alerts`, next to a component `Alerts` with a subscriber of the same
// name, fails on the alias both give.
const subscribers = (topic: SnsTopic, name: string, id?: string) => [
  subscriber(name, id),
  topic.arn.apply((arn) =>
    subscriber(logicalName(parseTopicArn(arn).topicName), id),
  ),
];

takeover(SnsTopic, {
  moved: {
    subscriber: (topic, { name, id }) =>
      subscribers(topic, name, id).flatMap((old) =>
        subscriberFunction(FUNCTION, old),
      ),
    permission: (topic, { name, id }) =>
      subscribers(topic, name, id).map((old) =>
        childOf(FUNCTION, old, "Permission"),
      ),
    // A subscription was in either kind of subscriber
    subscription: (topic, { name, id }) =>
      subscribers(topic, name, id).flatMap((old) => [
        childOf(FUNCTION, old, "Subscription"),
        childOf(QUEUE, old, "Subscription"),
      ]),
    queuePolicy: (topic, { name, id }) =>
      subscribers(topic, name, id).map((old) => childOf(QUEUE, old, "Policy")),
  },
});
