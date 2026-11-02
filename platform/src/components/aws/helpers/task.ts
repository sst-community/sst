import type { Task as OriginalTask } from "../task";
import type { Task } from "../v5/task";

/**
 * A `Task` component: the 4.x one or the V5 one. Each gives its task
 * definition and roles in `nodes`, and the cluster, containers and network
 * it runs with.
 */
export type AnyTask = OriginalTask | Task;
