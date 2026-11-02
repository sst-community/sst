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
  }
}
