import { afterEach, describe, expect, it, vi } from "vitest";

// Names in a program Pulumi runs on its own, whose app and stage are its
// project and stack, which Pulumi lets have characters SST's CLI doesn't

const app = { name: "shop", stage: "dev" };
vi.mock("../../src/components/context.js", () => ({
  context: () => ({ app: { ...app } }),
  underCore: () => false,
}));

const { physicalName } = await import("../../src/components/naming.js");

describe("physicalName, in a Pulumi program", () => {
  afterEach(() => {
    Object.assign(app, { name: "shop", stage: "dev" });
  });

  it("has the project and the stack in it", () => {
    expect(physicalName(64, "Files")).toMatch(/^shop-dev-Files-[a-z]{8}$/);
  });

  it("refuses a project SST's CLI wouldn't take as an app", () => {
    app.name = "my_shop";
    expect(() => physicalName(64, "Files")).toThrow(
      /the Pulumi project's name .* "my_shop" isn't one SST's CLI takes: start it with a letter, and use only letters, numbers and hyphens/,
    );
  });

  it("refuses a stack SST's CLI wouldn't take as a stage", () => {
    app.stage = "feature_x";
    expect(() => physicalName(64, "Files")).toThrow(
      /the stack's name .* "feature_x" isn't one SST's CLI takes: use only letters, numbers and hyphens/,
    );
  });
});
