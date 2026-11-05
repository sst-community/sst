import { beforeEach, describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import { mock } from "../../src/testing";
import { Component } from "../../src/components/component";
import { component } from "../../src/components/parts-component";
import { takeover } from "../../src/components/takeover";
import { leaveMarker, recordVersions } from "../../src/components/move";
import { newRun } from "../../src/util/lazy";
// SST 4's form of a component, frozen in the fixtures
import * as Sst4 from "../fixtures/v4/components/aws/index";

const app = await mock({ app: "acme", stage: "dev" });
const cli = (globalThis as any).$cli;

// The stage as the core reads it from the state, for a command
function stage(state: {
  moved?: boolean;
  components?: Record<string, number> | string[];
  types?: string[];
  nested?: string[];
  empty?: boolean;
  move?: boolean;
  command?: string;
}) {
  cli.state = {
    version: {},
    moved: state.moved,
    components: state.components ?? {},
    types: state.types ?? [],
    nested: state.nested ?? [],
    empty: state.empty,
  };
  cli.move = state.move === true;
  cli.command = state.command ?? (state.move ? "deploy" : "deploy");
}

const Bucket = "sst:aws:Bucket";
const Nextjs = "sst:aws:Nextjs";
const Queue = "sst:aws:Queue";

describe("the marker of a stage on SST 5's components", () => {
  beforeEach(() => {
    app.reset();
    newRun();
    stage({});
  });

  it("starts a new stage with every component that has a 5.0 form, at its version", () => {
    stage({ empty: true });
    const listed = leaveMarker("before")!;
    expect(listed.get(Bucket)).toBe(1);
    expect(listed.get(Nextjs)).toBe(1);
  });

  it("is left before the program on a stage that has moved", () => {
    // So a deploy that fails partway still has it
    stage({ moved: true, components: { [Bucket]: 1 }, types: [Bucket] });
    expect(leaveMarker("before")?.get(Bucket)).toBe(1);
    expect(leaveMarker("after")).toBeUndefined();
  });

  it("keeps the version the stage has, and lists what it has none of at its own", () => {
    // Nextjs is listed at a version the code has moved past; Bucket the stage
    // doesn't have
    stage({ moved: true, components: { [Nextjs]: 3 }, types: [Nextjs] });
    const listed = leaveMarker("before")!;
    expect(listed.get(Nextjs)).toBe(3);
    expect(listed.get(Bucket)).toBe(1);
  });

  it("reads a marker written before components had versions", () => {
    stage({ moved: true, components: [Bucket], types: [Bucket] });
    expect(leaveMarker("before")?.get(Bucket)).toBe(1);
  });

  it("is left after the program when the stage moves, with all but what it kept", () => {
    stage({ move: true, types: [Bucket, Queue] });
    expect(leaveMarker("before")).toBeUndefined();
    new Sst4.Bucket("Uploads");
    new sst.aws.Queue("Jobs");
    const listed = leaveMarker("after")!;
    expect(listed.get(Queue)).toBe(1);
    expect(listed.has(Bucket)).toBe(false);
  });

  it("waits for everything the move deploys, so one that fails is moved again", async () => {
    stage({ move: true, types: [Queue] });
    const jobs = new sst.aws.Queue("Jobs");
    leaveMarker("after");
    recordVersions();
    await app.settle();
    // Pulumi waits for a component by waiting for what's in it
    const urn = await app.resolve(jobs.nodes.queue.urn);
    for (const type of ["sst:sst:Moved", "sst:sst:Versions"])
      expect(
        app.resources.find((r) => r.type === type)?.options.dependencies,
      ).toContain(urn);
  });

  it("isn't left by a diff of a stage that hasn't moved", () => {
    // The core refuses to deploy one; its diff shows nothing new
    stage({ types: [Bucket] });
    expect(leaveMarker("before")).toBeUndefined();
    new Sst4.Bucket("Uploads");
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
      stage({ moved: true, components: { [Bucket]: 1 }, types: [Bucket] });
      expect(() => new Sst4.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket, and this stage has moved to its 5.0 form. Use the 5.0 form: a stage doesn't go back to SST 4's components by a deploy.",
      );
      expect(() => new sst.aws.Bucket("Files")).not.toThrow();
    });

    it("is refused on a new stage", () => {
      stage({ empty: true });
      expect(() => new Sst4.Bucket("Uploads")).toThrow(
        "\"Uploads\" is SST 4's sst.aws.Bucket. A new stage starts on SST 5's components: use its 5.0 form.",
      );
    });

    it("runs on a stage that hasn't moved", () => {
      // Its diff, and its move
      stage({ types: [Bucket] });
      expect(() => new Sst4.Bucket("Uploads")).not.toThrow();
    });

    it("runs on a stage that moved before it had a 5.0 form, until a move switches it", () => {
      // The marker doesn't list it, and the stage has it
      stage({ moved: true, components: { [Nextjs]: 1 }, types: [Bucket, Nextjs] });
      expect(() => new Sst4.Bucket("Uploads")).not.toThrow();
      expect(leaveMarker("after")).toBeUndefined();
      expect(() => new sst.aws.Bucket("Files")).toThrow(
        "\"Files\" is SST 5's sst.aws.Bucket, and this stage still has SST 4's sst.aws.Bucket. Switching to it is a move: `sst migrate --check` shows what it does, and `sst migrate` makes it.",
      );
    });

    it("counts as moved on a stage that has none of it", () => {
      stage({ moved: true, components: { [Nextjs]: 1 }, types: [Nextjs] });
      expect(() => new sst.aws.Bucket("Files")).not.toThrow();
      expect(() => new Sst4.Bucket("Uploads")).toThrow(/has moved/);
    });

    it("is switched all at once by a move", () => {
      stage({ move: true, types: [Bucket] });
      new sst.aws.Bucket("Files");
      expect(() => new Sst4.Bucket("Uploads")).toThrow(
        '"Uploads" is SST 4\'s sst.aws.Bucket, and this move switches others to their 5.0 form. A move switches all of a component at once: use its 5.0 form.',
      );
      newRun();
      stage({ move: true, types: [Bucket] });
      new Sst4.Bucket("Uploads");
      expect(() => new sst.aws.Bucket("Files")).toThrow(
        "\"Files\" is SST 5's sst.aws.Bucket, and this move keeps others in SST 4's form. A move switches all of a component at once: use the 5.0 form for each.",
      );
    });

    it("is refused when a move creates it after it left the marker", () => {
      // As inside an `apply` the program didn't wait for
      stage({ move: true, types: [Bucket] });
      leaveMarker("after");
      expect(() => new Sst4.Bucket("Uploads")).toThrow(/has moved/);
    });

    it("moves with the component of SST's it's in", () => {
      stage({ moved: true, components: { [Bucket]: 1 }, types: [Bucket] });
      // Like the functions SST 4's sites create
      const site = new Component("sst:aws:Site", "Web");
      expect(
        () => new Sst4.Bucket("WebAssets", {}, { parent: site }),
      ).not.toThrow();
      newRun();
      stage({ move: true, types: [Bucket] });
      new Sst4.Bucket("WebFiles", {}, { parent: site });
      expect(leaveMarker("after")?.get(Bucket)).toBe(1);
      // Nor does it keep the stage from having a 5.0 one at the top
      newRun();
      stage({ moved: true, components: {}, types: [], nested: [Bucket] });
      expect(() => new sst.aws.Bucket("Files")).not.toThrow();
    });

    it("is kept by a move at the top of the app, beside a 5.0 one inside one of SST's", () => {
      // A 5.0 site's bucket moves with the site; the app's own stays SST 4's
      stage({ move: true, types: [Bucket] });
      const site = new Component("sst:aws:Site", "Web");
      new sst.aws.Bucket("WebAssets", {}, { parent: site });
      new Sst4.Bucket("Uploads");
      expect(leaveMarker("after")?.has(Bucket)).toBe(false);
      expect(recordVersions()?.has(Bucket)).toBe(false);
      // The site's is listed apart
      expect(recordVersions()?.get(`>${Bucket}`)).toBe(1);
      // So the next deploy runs it and leaves it unlisted, and refuses a 5.0
      // one at the top
      newRun();
      stage({ moved: true, components: {}, types: [Bucket] });
      expect(leaveMarker("before")?.has(Bucket)).toBe(false);
      const docs = new Component("sst:aws:Site", "Docs");
      new sst.aws.Bucket("DocsAssets", {}, { parent: docs });
      expect(() => new Sst4.Bucket("Uploads")).not.toThrow();
      expect(recordVersions()?.has(Bucket)).toBe(false);
      expect(() => new sst.aws.Bucket("Files")).toThrow(/still has SST 4's/);
      // Until a move switches it, and lists it
      newRun();
      stage({ move: true, moved: true, components: {}, types: [Bucket] });
      new sst.aws.Bucket("Uploads");
      expect(leaveMarker("after")?.get(Bucket)).toBe(1);
    });

    it("counts inside an app's or a package's own component", () => {
      stage({ move: true, types: [Bucket] });
      const wrapper = new Component("acme:index:Wrapper", "Wrapper");
      new Sst4.Bucket("WrapperFiles", {}, { parent: wrapper });
      expect(leaveMarker("after")?.has(Bucket)).toBe(false);
    });

    it("isn't a component with no 5.0 form", () => {
      stage({ moved: true, components: { [Bucket]: 1 }, types: [Bucket] });
      expect(
        () => new sst.Linkable("Settings", { properties: { mode: "a" } }),
      ).not.toThrow();
    });
  });

  // An app's or a package's own component, which renames a part in its
  // second version: the bucket it kept as `bucket` is `files`, and in its
  // third `docs`
  describe("and a component's own versions", () => {
    const Uploads = "acme:index:Uploads";
    const define = (key: string) =>
      class extends component(Uploads, { [key]: aws.s3.Bucket }) {
        constructor(name: string, opts?: $util.ComponentResourceOptions) {
          super(name, {}, opts);
          (this as any).part(key, {});
        }
      };
    const V1 = define("bucket");
    const V2 = define("files");
    takeover(V2, { version: 2, moved: { files: "bucket" } });
    const V3 = define("docs");
    takeover(V3, { version: 2, moved: { files: "bucket" } });
    takeover(V3, { version: 3, moved: { docs: "files" } });

    // The names it answers to besides its own, but those its parent gives it
    const aliasNames = (name: string) =>
      (app.resources.find((r) => r.name === name)?.options.aliases ?? [])
        .map((alias: any) => alias.spec?.name ?? alias.name)
        .filter(Boolean);

    it("deploys at the version the stage has, with no aliases", async () => {
      stage({ moved: true, components: { [Uploads]: 2 }, types: [Uploads] });
      new V2("Docs");
      await app.settle();
      expect(aliasNames("DocsFiles")).toEqual([]);
    });

    it("is recorded at version 1 with no map, so its next version is a move", () => {
      stage({ empty: true });
      new V1("Docs");
      expect(recordVersions()?.get(Uploads)).toBe(1);
      newRun();
      stage({ moved: true, components: { [Uploads]: 1 }, types: [Uploads] });
      expect(() => new V2("Again")).toThrow(
        '"Again" is version 2 of acme.index.Uploads, and this stage has version 1. Moving it to version 2 is a move: `sst migrate --check` shows what it does, and `sst migrate` makes it.',
      );
    });

    it("is created at its own version on a stage that has none of it", async () => {
      stage({ moved: true, components: {}, types: [] });
      expect(() => new V3("Docs")).not.toThrow();
      await app.settle();
      expect(aliasNames("DocsDocs")).toEqual([]);
    });

    it("is moved by a move, through every version in between", async () => {
      stage({ move: true, moved: true, components: { [Uploads]: 1 }, types: [Uploads] });
      new V3("Docs");
      await app.settle();
      expect(aliasNames("DocsDocs")).toEqual(["DocsBucket", "DocsFiles"]);
      expect(leaveMarker("after")?.get(Uploads)).toBe(3);
    });

    it("is moved from the version the stage has, not from before", async () => {
      stage({ move: true, moved: true, components: { [Uploads]: 2 }, types: [Uploads] });
      new V3("Docs");
      await app.settle();
      expect(aliasNames("DocsDocs")).toEqual(["DocsFiles"]);
    });

    it("is refused at an earlier version than the stage has", () => {
      // As when an older branch is deployed: it would delete what the move
      // kept. Version 1 has no map, and is checked all the same.
      stage({ moved: true, components: { [Uploads]: 2 }, types: [Uploads] });
      expect(() => new V1("Old")).toThrow(
        '"Old" is version 1 of acme.index.Uploads, and this stage has version 2, from newer code.',
      );
      newRun();
      stage({ moved: true, components: { [Uploads]: 3 }, types: [Uploads] });
      expect(() => new V2("Docs")).toThrow(
        '"Docs" is version 2 of acme.index.Uploads, and this stage has version 3, from newer code. Deploy it with code that has version 3 or later: a stage doesn\'t go back to an earlier version by a deploy.',
      );
    });

    it("isn't refused by a refresh or a remove", () => {
      for (const command of ["refresh", "remove"]) {
        newRun();
        stage({ moved: true, components: { [Uploads]: 1 }, types: [Uploads], command });
        expect(() => new V3(`Docs${command}`)).not.toThrow();
      }
    });

    describe("inside one of SST's components", () => {
      // One of SST's own, as a function inside a queue
      const Nested = "sst:test:Docs";
      const N3 = class extends component(Nested, { docs: aws.s3.Bucket }) {
        constructor(name: string, args: {}, opts?: $util.ComponentResourceOptions) {
          super(name, args, opts);
          (this as any).part("docs", {});
        }
      };
      takeover(N3, { version: 2, moved: { files: "bucket" } });
      takeover(N3, { version: 3, moved: { docs: "files" } });
      // The component it's in: at version 1, and one with a form before SST 5
      const Site = "sst:aws:Site";
      const Former = "sst:test:Former";
      const F1 = class extends component(Former, { docs: N3 }) {
        constructor(name: string) {
          super(name, {});
          (this as any).part("docs", {});
        }
      };
      takeover(F1, {});

      it("is moved, at the version the stage lists apart", async () => {
        stage({
          move: true,
          moved: true,
          components: { [`>${Nested}`]: 1 },
          types: [Site],
          nested: [Nested],
        });
        const site = new Component(Site, "Web");
        new N3("WebDocs", {}, { parent: site });
        await app.settle();
        expect(aliasNames("WebDocsDocs")).toEqual(["WebDocsBucket", "WebDocsFiles"]);
        expect(recordVersions()?.get(`>${Nested}`)).toBe(3);
      });

      it("is listed apart from one of its type at the top of the app", async () => {
        // Which the stage has at another version
        stage({
          moved: true,
          components: { [Nested]: 2, [`>${Nested}`]: 3 },
          types: [Site, Nested],
        });
        const site = new Component(Site, "Web");
        expect(() => new N3("WebDocs", {}, { parent: site })).not.toThrow();
        await app.settle();
        expect(aliasNames("WebDocsDocs")).toEqual([]);
      });

      it("is in its form before SST 5 while the one it's in is", async () => {
        // As when SST 4's form of that one is switched, on a stage where
        // another of SST's components has one inside it at version 3
        stage({
          move: true,
          moved: true,
          components: { [`>${Nested}`]: 3 },
          types: [Site, Former],
          nested: [Nested],
        });
        new F1("Old");
        await app.settle();
        expect(aliasNames("OldDocsDocs")).toEqual(["OldDocsBucket", "OldDocsFiles"]);
      });

      it("reads a record that lists it under its type", async () => {
        // As one written before those inside SST's were listed apart
        stage({
          move: true,
          moved: true,
          components: { [Nested]: 1 },
          types: [Site],
          nested: [Nested],
        });
        const site = new Component(Site, "Web");
        new N3("WebDocs", {}, { parent: site });
        await app.settle();
        expect(aliasNames("WebDocsDocs")).toEqual(["WebDocsBucket", "WebDocsFiles"]);
      });

      it("has nothing to take over in one the stage has none of", async () => {
        stage({
          move: true,
          moved: true,
          components: { [`>${Nested}`]: 1 },
          types: [Site],
          nested: [Nested],
        });
        const other = new Component("sst:aws:Other", "Other");
        new N3("OtherDocs", {}, { parent: other });
        await app.settle();
        expect(aliasNames("OtherDocsDocs")).toEqual([]);
      });

      it("is refused at another version outside a move", () => {
        stage({
          moved: true,
          components: { [`>${Nested}`]: 1 },
          types: [Site],
          nested: [Nested],
        });
        const site = new Component(Site, "Web");
        expect(() => new N3("WebDocs", {}, { parent: site })).toThrow(
          '"WebDocs", inside "Web", is version 3 of sst.test.Docs, and this stage has version 1. Moving it to version 3 is a move: `sst migrate --check` shows what it does, and `sst migrate` makes it.',
        );
        newRun();
        stage({
          moved: true,
          components: { [`>${Nested}`]: 4 },
          types: [Site],
          nested: [Nested],
        });
        const docs = new Component(Site, "Docs");
        expect(() => new N3("DocsDocs", {}, { parent: docs })).toThrow(
          /"DocsDocs", inside "Docs", is version 3 of sst.test.Docs, and this stage has version 4, from newer code/,
        );
      });
    });

    it("is recorded at its version when its map is registered as the program runs", () => {
      // As from a file the config imports in `run()`, or a package
      stage({ empty: true });
      expect(leaveMarker("before")?.has("acme:index:Late")).toBe(false);
      const Late = class extends component("acme:index:Late", { bucket: aws.s3.Bucket }) {
        constructor(name: string) {
          super(name, {});
          (this as any).part("bucket", {});
        }
      };
      takeover(Late, { version: 2 });
      new Late("Docs");
      expect(recordVersions()?.get("acme:index:Late")).toBe(2);
      // The next deploy reads what the record says
      newRun();
      stage({ moved: true, components: { "acme:index:Late": 2 }, types: ["acme:index:Late"] });
      expect(() => new Late("Docs")).not.toThrow();
    });

    it("counts one no deploy that finished recorded as at the code's version", () => {
      // As when the stage's first deploy failed partway
      stage({ moved: true, components: {}, types: [Uploads] });
      expect(() => new V2("Docs")).not.toThrow();
    });

    it("isn't moved to an earlier version by a move", () => {
      stage({ move: true, moved: true, components: { [Uploads]: 3 }, types: [Uploads] });
      expect(() => new V2("Docs")).toThrow(/this stage has version 3, from newer code/);
    });

    it("takes one map for each version", () => {
      const V4 = define("other");
      takeover(V4, { version: 2 });
      expect(() => takeover(V4, { version: 2 })).toThrow(
        "acme.index.Uploads has two maps for version 2.",
      );
      expect(() => takeover(V4, { version: 3, from: "acme:index:Old" })).toThrow(
        /Only version 1 can/,
      );
      expect(() => takeover(V4, { version: 0 })).toThrow(/whole number from 1/);
    });
  });
});
