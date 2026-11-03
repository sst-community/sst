import { takeover } from "../../takeover";
import { Realtime } from "../v5/realtime";
import { childOf } from "./helpers";

// The 4.x `Realtime` keeps each subscriber in a component of its own, at the
// top of the app, named after the realtime server and a hash of the
// subscriber's filter and handler. The V5 one keeps the subscriber's
// resources inside the server, by that same hash.
const SUBSCRIBER = "sst:aws:RealtimeLambdaSubscriber";
const subscriber = (name: string, id?: string) => `${name}Subscriber${id}`;

takeover(Realtime, {
  moved: {
    subscriber: (_, { name, id }) =>
      childOf(SUBSCRIBER, subscriber(name, id), "Handler"),
    subscriberPermission: (_, { name, id }) =>
      childOf(SUBSCRIBER, subscriber(name, id), "Permission"),
    topicRule: (_, { name, id }) =>
      childOf(SUBSCRIBER, subscriber(name, id), "Rule"),
  },
});
