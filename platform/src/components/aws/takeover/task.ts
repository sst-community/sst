import { takeover } from "../../takeover";
import { Task } from "../v5/task";

takeover(Task, {
  from: "sst:aws:Task",
  moved: {
    // The 4.x `Task` calls the task definition the task
    taskDefinition: "task",
    // A container's image and log group were named after the container's
    // name as it was written
    image: (_, { name, id }) => ({ name: `${name}Image${id}` }),
    logGroup: (_, { name, id }) => ({ name: `${name}LogGroup${id}` }),
  },
});
