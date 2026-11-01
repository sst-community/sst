import { takeover } from "../../takeover";
import { Bus } from "../v5/bus";
import { childOf, subscriberFunction } from "./helpers";

// The 4.x `Bus` keeps each subscription in a component of its own, at the top
// of the app. The V5 one keeps them inside the bus. The component was named
// after the bus and the subscriber: after the bus's component for one added
// with `bus.subscribe()`, and after the bus's own name for one added with the
// static `Bus.subscribe()`, which only has the bus's ARN.
const FUNCTION = "sst:aws:BusLambdaSubscriber";
const QUEUE = "sst:aws:BusQueueSubscriber";
const subscribers = (bus: Bus, name: string, id?: string) => [
  `${name}Subscriber${id}`,
  bus.name.apply((busName) => `${busName}Subscriber${id}`),
];

takeover(Bus, {
  moved: {
    subscriber: (bus, { name, id }) =>
      subscribers(bus, name, id).flatMap((subscriber) =>
        subscriberFunction(FUNCTION, subscriber),
      ),
    permission: (bus, { name, id }) =>
      subscribers(bus, name, id).map((subscriber) =>
        childOf(FUNCTION, subscriber, "Permission"),
      ),
    // A rule and a target were in either kind of subscriber
    rule: (bus, { name, id }) =>
      subscribers(bus, name, id).flatMap((subscriber) => [
        childOf(FUNCTION, subscriber, "Rule"),
        childOf(QUEUE, subscriber, "Rule"),
      ]),
    target: (bus, { name, id }) =>
      subscribers(bus, name, id).flatMap((subscriber) => [
        childOf(FUNCTION, subscriber, "Target"),
        childOf(QUEUE, subscriber, "Target"),
      ]),
    queuePolicy: (bus, { name, id }) =>
      subscribers(bus, name, id).map((subscriber) =>
        childOf(QUEUE, subscriber, "Policy"),
      ),
  },
});
