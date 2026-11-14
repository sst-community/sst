import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as pulumiSdk from "@pulumi/pulumi";
import { mockPulumi } from "../../src/testing/mock";

// The setup of a program Pulumi runs on its own (plain.ts), loaded outside
// the stack it runs in, as an Automation API program is, and run in one
// stack after another in the same process

const pulumi = mockPulumi({ plain: true });

describe("A Pulumi program loaded outside its stack", () => {
  let Linkable: typeof import("../../src/components/linkable").Linkable;

  beforeAll(async () => {
    // Loaded where no stack runs, so nothing is set up as it loads
    await import("../../src/components/plain");
    ({ Linkable } = await import("../../src/components/linkable"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    pulumi.reset();
  });

  // Pulumi's public view of the stack the program runs in, and the stack
  // transformations registered on it. The mock has no stack, and Pulumi's
  // resources read their stack elsewhere, so they're as they are without it.
  const inStack = () => {
    const stack = { registered: [] as pulumiSdk.ResourceTransformation[] };
    vi.spyOn(pulumiSdk.runtime, "getStackResource").mockImplementation(
      () => stack as any,
    );
    vi.spyOn(
      pulumiSdk.runtime,
      "registerStackTransformation",
    ).mockImplementation(
      (transformation) => void stack.registered.push(transformation),
    );
    return stack;
  };

  const properties = { properties: { value: "x" } };

  it("is set up when its first component is created in a stack", async () => {
    const stack = inStack();
    new Linkable("First", properties);
    // Link's checks and records: a name taken by Resource.App is refused
    expect(stack.registered).toHaveLength(2);
    expect(() =>
      stack.registered[0]({
        type: "sst:sst:Linkable",
        name: "App",
        props: {},
        opts: {},
      } as any),
    ).toThrow(/conflicts with "Resource.App"/);
    // Once for the stack
    new Linkable("Second", properties);
    expect(stack.registered).toHaveLength(2);
    await pulumi.settle();
  });

  it("is set up again in the next stack", async () => {
    inStack();
    new Linkable("First", properties);
    await pulumi.settle();
    const next = inStack();
    new Linkable("First", properties);
    expect(next.registered).toHaveLength(2);
    await pulumi.settle();
  });

  it("isn't set up where no stack runs", async () => {
    const register = vi.spyOn(pulumiSdk.runtime, "registerStackTransformation");
    new Linkable("First", properties);
    expect(register).not.toHaveBeenCalled();
    await pulumi.settle();
  });
});
