import { takeover } from "../../takeover";
import { Service } from "../v5/service";

takeover(Service, {
  moved: {
    // The 4.x `Service` calls the task definition the task
    taskDefinition: "task",
    certificate: "ssl",
    // These were named after what they're for as it was written: a
    // container's name, the "TCP_UDP" protocol
    image: (_, { name, id }) => ({ name: `${name}Image${id}` }),
    logGroup: (_, { name, id }) => ({ name: `${name}LogGroup${id}` }),
    target: (_, { name, id }) => ({ name: `${name}Target${id}` }),
    listener: (_, { name, id }) => ({ name: `${name}Listener${id}` }),
    // A rule of the service's own load balancer was named after its
    // listener, and a rule on an `Alb` after the `Alb`
    listenerRule: (_, { name, id }) => [
      { name: `${name}Listener${id}` },
      { name: `${name}AlbRule${id}` },
    ],
  },
});
