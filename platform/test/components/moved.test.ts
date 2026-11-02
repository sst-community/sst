import { beforeEach, describe, expect, it } from "vitest";
import { mock } from "../../src/testing";
import { Component } from "../../src/components/component";
import { leaveMarker } from "../../src/components/move";
import { newRun } from "../../src/util/lazy";

const app = await mock({ app: "acme", stage: "dev" });
const cli = (globalThis as any).$cli;

// The stage as the core reads it from the state
function stage(state: { moved?: boolean; empty?: boolean; move?: boolean }) {
  cli.state = { version: {}, moved: state.moved, empty: state.empty };
  cli.move = state.move === true;
}

// What a run leaves, before the app's program and after it
function run(program: () => void) {
  const before = leaveMarker("before");
  program();
  const after = leaveMarker("after");
  return before || after;
}

describe("the marker of a stage on SST 5's components", () => {
  beforeEach(() => {
    app.reset();
    newRun();
    stage({});
  });

  it("is left before the program on a stage that has moved, or is new", () => {
    // So a deploy that fails partway still has it
    stage({ moved: true });
    expect(leaveMarker("before")).toBe(true);
    newRun();
    stage({ empty: true });
    expect(leaveMarker("before")).toBe(true);
  });

  it("is left after the program when the stage moves", () => {
    stage({ move: true });
    expect(leaveMarker("before")).toBe(false);
    new sst.aws.v5.Bucket("Uploads");
    expect(leaveMarker("after")).toBe(true);
  });

  it("isn't left by a diff of a stage that hasn't moved", () => {
    // The core refuses to deploy one; its diff shows nothing new
    stage({});
    expect(run(() => new sst.aws.Bucket("Uploads"))).toBe(false);
  });

  it("is in the state after a run that leaves it", async () => {
    stage({ empty: true });
    run(() => new sst.aws.v5.Bucket("Uploads"));
    await app.settle();
    expect(app.resources).toContainEqual(
      expect.objectContaining({ type: "sst:sst:Moved", name: "Moved" }),
    );

    app.reset();
    newRun();
    stage({});
    run(() => new sst.aws.v5.Bucket("Uploads"));
    await app.settle();
    expect(app.resources.map((r) => r.type)).not.toContain("sst:sst:Moved");
  });

  describe("and SST 4's form of a component with a 5.0 form", () => {
    it("keeps a move from leaving it", () => {
      stage({ move: true });
      expect(run(() => new sst.aws.Bucket("Uploads"))).toBe(false);
    });

    it("is refused on a stage that has moved", () => {
      stage({ moved: true });
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket, and this stage is on SST 5's components. Use its 5.0 form. A stage that has moved doesn't go back to SST 4's components by a deploy.",
      );
      // Its 5.0 form is what the stage has
      expect(() => new sst.aws.v5.Bucket("Files")).not.toThrow();
    });

    it("is refused on a new stage", () => {
      stage({ empty: true });
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket, and this stage is on SST 5's components. Use its 5.0 form.",
      );
    });

    it("runs on a stage that hasn't moved", () => {
      // Its diff, and its move
      stage({});
      expect(() => new sst.aws.Bucket("Uploads")).not.toThrow();
    });

    it("moves with the component of SST's it's in", () => {
      stage({ moved: true });
      // Like the functions SST 4's sites create
      const site = new Component("sst:aws:Site", "Web");
      expect(
        () => new sst.aws.Bucket("WebAssets", {}, { parent: site }),
      ).not.toThrow();
      newRun();
      stage({ move: true });
      expect(
        run(() => new sst.aws.Bucket("WebFiles", {}, { parent: site })),
      ).toBe(true);
    });

    it("counts inside an app's or a package's own component", () => {
      stage({ move: true });
      const wrapper = new Component("acme:index:Wrapper", "Wrapper");
      expect(
        run(() => new sst.aws.Bucket("WrapperFiles", {}, { parent: wrapper })),
      ).toBe(false);
    });

    it("isn't a component with no 5.0 form", () => {
      stage({ moved: true });
      expect(
        () => new sst.Linkable("Settings", { properties: { mode: "a" } }),
      ).not.toThrow();
    });
  });
});
