import { describe, expect, it } from "vitest";
import { mock } from "../../src/testing";

// A mock of its own: `patience` is set when it's made
const app = await mock({ patience: 3000 });

describe("settle() with patience", () => {
  const { ComponentResource, output } =
    require("@pulumi/pulumi") as typeof import("@pulumi/pulumi");

  it("waits that long for a component waiting on a timer", async () => {
    class Slow extends ComponentResource {
      constructor(name: string) {
        super("acme:index:Slow", name, {});
        // Longer than the half a second it waits by default
        const later = new Promise((done) => setTimeout(() => done(true), 1200));
        this.registerOutputs({ done: output(later) });
      }
    }
    new Slow("Slow");
    await app.settle();
    expect(app.outputsOf("Slow")).toEqual({ done: true });
  });
});
