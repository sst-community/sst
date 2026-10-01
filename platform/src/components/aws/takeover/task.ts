import { takeover } from "../../takeover";
import { TaskV5 } from "../task-v5";

takeover(TaskV5, {
  from: "sst:aws:Task",
  moved: {
    // `Task` calls the task definition the task
    taskDefinition: "task",
    // A container's image and log group were named after the container's
    // name as it was written
    image: (_, { name, id }) => ({ name: `${name}Image${id}` }),
    logGroup: (_, { name, id }) => ({ name: `${name}LogGroup${id}` }),
  },
});
