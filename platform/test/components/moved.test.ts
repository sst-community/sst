import { beforeEach, describe, expect, it } from "vitest";
import { mock } from "../../src/testing";
import { Component } from "../../src/components/component";
import { leaveMarker } from "../../src/components/move";
import { newRun } from "../../src/util/lazy";

const app = await mock({ app: "acme", stage: "dev" });
const cli = (globalThis as any).$cli;

// The stage as the core reads it from the state
function stage(state: {
  moved?: boolean;
  components?: string[];
  types?: string[];
  empty?: boolean;
  move?: boolean;
}) {
  cli.state = {
    version: {},
    moved: state.moved,
    components: state.components ?? [],
    types: state.types ?? [],
    empty: state.empty,
  };
  cli.move = state.move === true;
}

const Bucket = "sst:aws:Bucket";
const Nextjs = "sst:aws:Nextjs";

describe("the marker of a stage on SST 5's components", () => {
  beforeEach(() => {
    app.reset();
    newRun();
    stage({});
  });

  it("starts a new stage with every component that has a 5.0 form", () => {
    stage({ empty: true });
    const listed = leaveMarker("before")!;
    expect(listed).toContain(Bucket);
    expect(listed).toContain(Nextjs);
  });

  it("is left before the program on a stage that has moved", () => {
    // So a deploy that fails partway still has it
    stage({ moved: true, components: [Bucket], types: [Bucket] });
    expect(leaveMarker("before")).toContain(Bucket);
    expect(leaveMarker("after")).toBeUndefined();
  });

  it("is left after the program when the stage moves, with all but what it kept", () => {
    stage({ move: true, types: [Bucket, Nextjs] });
    expect(leaveMarker("before")).toBeUndefined();
    new sst.aws.Bucket("Uploads");
    const listed = leaveMarker("after")!;
    expect(listed).toContain(Nextjs);
    expect(listed).not.toContain(Bucket);
  });

  it("isn't left by a diff of a stage that hasn't moved", () => {
    // The core refuses to deploy one; its diff shows nothing new
    stage({ types: [Bucket] });
    expect(leaveMarker("before")).toBeUndefined();
    new sst.aws.Bucket("Uploads");
    expect(leaveMarker("after")).toBeUndefined();
  });

  it("is in the state with what it lists", async () => {
    stage({ empty: true });
    leaveMarker("before");
    await app.settle();
    const marker = app.resources.find((r) => r.type === "sst:sst:Moved");
    expect(marker?.name).toBe("Moved");
  });

  describe("and SST 4's form of a component that has a 5.0 form", () => {
    it("is refused on a stage that moved to the 5.0 form", () => {
      stage({ moved: true, components: [Bucket], types: [Bucket] });
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket, and this stage has moved to its 5.0 form. Use the 5.0 form: a stage doesn't go back to SST 4's components by a deploy.",
      );
      expect(() => new sst.aws.v5.Bucket("Files")).not.toThrow();
    });

    it("is refused on a new stage", () => {
      stage({ empty: true });
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket. A new stage starts on SST 5's components: use its 5.0 form.",
      );
    });

    it("runs on a stage that hasn't moved", () => {
      // Its diff, and its move
      stage({ types: [Bucket] });
      expect(() => new sst.aws.Bucket("Uploads")).not.toThrow();
    });

    it("runs on a stage that moved before it had a 5.0 form, until a move switches it", () => {
      // The marker doesn't list it, and the stage has it
      stage({ moved: true, components: [Nextjs], types: [Bucket, Nextjs] });
      expect(() => new sst.aws.Bucket("Uploads")).not.toThrow();
      expect(leaveMarker("after")).toBeUndefined();
      expect(() => new sst.aws.v5.Bucket("Files")).toThrow(
        "\"Files\" is SST 5's sst.aws.Bucket, and this stage still has SST 4's sst.aws.Bucket. Switching to it is a move: `sst migrate --check` shows what it does, and `sst migrate` makes it.",
      );
    });

    it("counts as moved on a stage that has none of it", () => {
      stage({ moved: true, components: [Nextjs], types: [Nextjs] });
      expect(() => new sst.aws.v5.Bucket("Files")).not.toThrow();
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(/has moved/);
    });

    it("is refused when a move creates it after it left the marker", () => {
      // As inside an `apply` the program didn't wait for
      stage({ move: true, types: [Bucket] });
      leaveMarker("after");
      expect(() => new sst.aws.Bucket("Uploads")).toThrow(/has moved/);
    });

    it("moves with the component of SST's it's in", () => {
      stage({ moved: true, components: [Bucket], types: [Bucket] });
      // Like the functions SST 4's sites create
      const site = new Component("sst:aws:Site", "Web");
      expect(
        () => new sst.aws.Bucket("WebAssets", {}, { parent: site }),
      ).not.toThrow();
      newRun();
      stage({ move: true, types: [Bucket] });
      new sst.aws.Bucket("WebFiles", {}, { parent: site });
      expect(leaveMarker("after")).toContain(Bucket);
    });

    it("counts inside an app's or a package's own component", () => {
      stage({ move: true, types: [Bucket] });
      const wrapper = new Component("acme:index:Wrapper", "Wrapper");
      new sst.aws.Bucket("WrapperFiles", {}, { parent: wrapper });
      expect(leaveMarker("after")).not.toContain(Bucket);
    });

    it("isn't a component with no 5.0 form", () => {
      stage({ moved: true, components: [Bucket], types: [Bucket] });
      expect(
        () => new sst.Linkable("Settings", { properties: { mode: "a" } }),
      ).not.toThrow();
    });
  });
});
