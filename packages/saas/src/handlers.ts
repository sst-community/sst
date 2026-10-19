// The functions the component deploys when it isn't given `handlers`.
import { createHandlers } from "./runtime/handlers.js";

export const { api, customMessage, postConfirmation, preTokenGeneration } =
  createHandlers();
