import { takeover } from "../../takeover";
import { childOf } from "../../aws/takeover/helpers";
import { Queue } from "../queue";

// The 4.x `Queue` keeps its consumer in a component of its own, a
// `QueueWorkerSubscriber` named after the queue, at the top of the app.
// SST 5's keeps the consumer and its Worker inside the queue. The Worker keeps
// its name, so its script's is still made from it.
const SUBSCRIBER = "sst:cloudflare:QueueWorkerSubscriber";

takeover(Queue, {
  moved: {
    subscriber: (_, { name }) =>
      childOf(SUBSCRIBER, `${name}Subscriber`, "Function"),
    consumer: (_, { name }) =>
      childOf(SUBSCRIBER, `${name}Subscriber`, "Consumer"),
  },
});
