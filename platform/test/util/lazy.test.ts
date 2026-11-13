import { afterEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { newRun, perRun } from "../../src/util/lazy";

describe("perRun", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes a value once in a run, and again in the next", () => {
    let made = 0;
    const value = perRun(() => ++made);
    expect(value()).toBe(1);
    expect(value()).toBe(1);
    newRun();
    expect(value()).toBe(2);
  });

  it("makes it again for each stack Pulumi runs the program in", () => {
    // As the Automation API runs an inline program again in one process
    let current: object = {};
    vi.spyOn(pulumi.runtime, "getStackResource").mockImplementation(
      () => current as any,
    );
    let made = 0;
    const value = perRun(() => ++made);
    const first = value();
    expect(value()).toBe(first);
    current = {};
    expect(value()).toBe(first + 1);
    expect(value()).toBe(first + 1);
  });
});
