import { underCore } from "./context.js";

export class VisibleError extends Error {
  constructor(...message: string[]) {
    super(message.join("\n"));
    // The message is shown as it's written. Pulumi adds the property it was
    // serializing to an error's message, once for each resource whose input it
    // fails, on the same error so that it's reported once.
    const text = this.message;
    Object.defineProperty(this, "message", {
      get: () => text,
      set: () => {},
      configurable: true,
      enumerable: false,
    });
    // SST's CLI shows a VisibleError's message without its stack trace. A
    // program Pulumi runs on its own has no CLI, and Pulumi shows the message
    // alone for an error marked as its own RunError.
    if (!underCore())
      Object.defineProperty(this, "__pulumiRunError", { value: true });
  }
}
