// The functions the component deploys when it isn't given `handlers`.
import { createHandlers } from "./runtime/handlers";

export const { api, postConfirmation, preTokenGeneration } = createHandlers();
