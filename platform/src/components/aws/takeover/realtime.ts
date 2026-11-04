import { takeover } from "../../takeover";
import { Realtime } from "../v5/realtime";
import { childOf } from "./helpers";

// The 4.x `Realtime` keeps each subscriber in a component of its own, at the
// top of the app, named after the realtime server and a hash of the
// subscriber's filter and handler. The V5 one keeps the subscriber's
// resources inside the server, by that same hash. One given a `name` is new:
// 4.x had none.
const SUBSCRIBER = "sst:aws:RealtimeLambdaSubscriber";
const subscriber = (
  server: Realtime,
  name: string,
  id: string | undefined,
  child: string,
) =>
  server.subscriberIsNamed(id!)
    ? undefined
    : childOf(SUBSCRIBER, `${name}Subscriber${id}`, child);

takeover(Realtime, {
  moved: {
    subscriber: (server, { name, id }) =>
      subscriber(server, name, id, "Handler"),
    subscriberPermission: (server, { name, id }) =>
      subscriber(server, name, id, "Permission"),
    topicRule: (server, { name, id }) => subscriber(server, name, id, "Rule"),
  },
});
