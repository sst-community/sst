import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import {
  type MockInput,
  type RecordedResource,
  mockPulumi as mockEngine,
} from "../../src/testing/mock";
import { stateGraph } from "../../src/testing/state";

export type { RecordedResource };

/** The ways a takeover case is run. */
export type TakeoverWay =
  | "as it is"
  | "inside another component"
  | "with another provider";

type Create<C> = (
  Component: C,
  opts?: pulumi.ComponentResourceOptions,
) => unknown;

// What's expected, the same every way a case is run, or by the way
type Expected<T> = T | ((way: TakeoverWay) => T);

export interface TakeoverCase<C> {
  /**
   * Creates the component from the class it's given: the original, then the
   * V5 one. It has to pass `opts` on to the component.
   */
  create?: Create<C>;
  /** Creates the original, when the two aren't written the same way. */
  original?: (opts?: pulumi.ComponentResourceOptions) => unknown;
  /** Creates the V5 component, when the two aren't written the same way. */
  v5?: (opts?: pulumi.ComponentResourceOptions) => unknown;
  /** What goes in this case, in place of what goes in every case. */
  unclaimed?: Expected<string[]>;
  /**
   * How many of the components the original wraps things in go. They're
   * matched by the mock's `wrappers` pattern, and counted where their names
   * aren't worth writing out. Without this, they're listed in `unclaimed`.
   */
  wrappers?: Expected<number>;
  /** What a deploy updates in this case: a resource and its fields. */
  changed?: Expected<[name: string, fields: string[]][]>;
  /**
   * What the original removed in order and the V5 component doesn't, in this
   * case: "MyService before MyNamespace". It should be nothing.
   */
  unordered?: Expected<string[]>;
  /** Anything else to check, once the V5 component is deployed. */
  check?: (way: TakeoverWay) => unknown;
}

export interface TakeoverCases<A, B> {
  /** The original component's class. A function, as it's loaded late. */
  original: () => A;
  /** The V5 component's class. */
  v5: () => B;
  /**
   * What the original created that goes on switch, in every case: things
   * with nothing in AWS behind them, like its version marker.
   */
  unclaimed?: Expected<string[]>;
  /** What a deploy updates in every case: a resource and its fields. */
  changed?: Expected<[name: string, fields: string[]][]>;
  /**
   * Orderings the original has that nothing in AWS needs, so they aren't
   * expected of the V5 component: a route's function removed before its API.
   * Say why next to it.
   */
  needlessOrder?: RegExp;
  cases: Record<string, Create<A | B> | TakeoverCase<A | B>>;
  /** Anything else to check in every case. */
  check?: (way: TakeoverWay) => unknown;
}

// A resource's address, as the mock works it out
const address = (type: string, name: string, parent: string) => {
  if (!parent) return `urn:pulumi:stack::project::${type}::${name}`;
  const [prefix, project, types] = parent.split("::");
  return `${prefix}::${project}::${types}$${type}::${name}`;
};
const nameOf = (urn: string) => urn.substring(urn.lastIndexOf("::") + 2);

/**
 * A graph as a 4.x stage has it when it was deployed before 4.x renamed one of
 * its resources, or moved one into a component from the top of the app. 4.x
 * renames with an alias that changes only the name, and moves with one that
 * says it had no parent. What's inside a renamed component was named after
 * it, so it had the old name in front, as Pulumi works it out. Only addresses
 * are changed: where a name is in what a resource is given, it can't be told
 * apart from another of the same name. Undefined when nothing was renamed or
 * moved.
 *
 * @returns The graph, and the name of each renamed resource now, as
 * `type::name`, by its name then.
 */
export function beforeRenames(graph: RecordedResource[]) {
  const byAddress = new Map(
    graph.map((r) => [address(r.type, r.name, r.parent), r] as const),
  );
  const rename = (r: RecordedResource) =>
    ((r.options.aliases ?? []) as any[]).find(
      (alias) =>
        typeof alias === "object" &&
        alias.spec?.name &&
        !alias.spec.type &&
        !alias.spec.noparent &&
        // Pulumi fills in the parent the resource has
        (!alias.spec.parenturn || alias.spec.parenturn === r.parent),
    );
  // Moved into a component, with the name it has
  const fromTop = (r: RecordedResource) =>
    ((r.options.aliases ?? []) as any[]).some(
      (alias) =>
        typeof alias === "object" &&
        alias.spec?.noparent &&
        !alias.spec.type &&
        (!alias.spec.name || alias.spec.name === r.name),
    );
  const was = new Map<string, string>();
  const before = (urn: string): string => {
    const r = byAddress.get(urn);
    if (!r) return urn;
    if (was.has(urn)) return was.get(urn)!;
    const top = fromTop(r);
    const parent = top ? "" : before(r.parent);
    const parentName = nameOf(r.parent);
    const name =
      rename(r)?.spec.name ??
      (!top && parent !== r.parent && r.name.startsWith(parentName)
        ? nameOf(parent) + r.name.substring(parentName.length)
        : r.name);
    const old = address(r.type, name, parent);
    was.set(urn, old);
    return old;
  };

  const now = new Map<string, string>();
  let moved = false;
  const old = graph.map((r) => {
    const urn = address(r.type, r.name, r.parent);
    const name = nameOf(before(urn));
    if (name !== r.name) now.set(`${r.type}::${name}`, `${r.type}::${r.name}`);
    if (before(urn) !== urn) moved = true;
    const { aliases, dependencies, ...options } = r.options;
    return {
      ...r,
      name,
      parent: fromTop(r) ? "" : before(r.parent),
      options: {
        ...options,
        ...(dependencies
          ? { dependencies: (dependencies as string[]).map(before) }
          : {}),
      },
    };
  });
  return moved ? { graph: old, now } : undefined;
}

// What a case's component is created inside, for "inside another component"
class Parent extends pulumi.ComponentResource {
  constructor(name: string) {
    super("test:Parent", name);
  }
}

/**
 * The mock every test file here starts with: what `src/testing` ships to
 * apps, plus the takeover suite for V5 components, which is written for
 * vitest.
 */
export function mockPulumi(input?: MockInput) {
  const engine = mockEngine(input);
  const { resources, deployed } = engine;

  // A stage deployed before 4.x renamed something has it at its old address,
  // and what takes over claims it there too. What each resource is given is
  // the same either way, and is checked against the graph as it is now.
  const claimsBeforeRenames = (
    before: RecordedResource[],
    result: ReturnType<typeof engine.takeover>,
  ) => {
    const earlier = beforeRenames(before);
    if (!earlier) return;
    let old: ReturnType<typeof engine.takeover>;
    try {
      old = engine.takeover(earlier.graph);
    } catch (error: any) {
      throw new Error(
        `As deployed before 4.x renamed or moved a resource: ${error.message}`,
        { cause: error },
      );
    }
    expect(
      {
        unclaimed: old.unclaimed.map((r) => earlier.now.get(r) ?? r).sort(),
        unordered: old.unordered,
      },
      "as deployed before 4.x renamed or moved a resource",
    ).toEqual({
      unclaimed: [...result.unclaimed].sort(),
      unordered: result.unordered,
    });
  };

  // Each deploy is a run of the program of its own, and starts with nothing
  // the run before it kept: what's registered, and what an app creates once,
  // like the dev stub code its functions share. The engine's reset does both.
  const newRun = async () => {
    engine.reset();
  };

  // The V5 side runs as the stage moves, so each component tells the core
  // what its state map says, and what a part releases is compared with the
  // part that takes its place
  const asMove = async (run: () => Promise<unknown>) => {
    const cli = (globalThis as any).$cli;
    const was = cli.move;
    cli.move = true;
    try {
      await run();
    } finally {
      cli.move = was;
    }
  };

  return {
    ...engine,
    /**
     * Runs a program that deployed a recorded state, then what replaces it,
     * with the mock given that state (`recorded`), and compares each with
     * what it takes over:
     *
     * - `deployed`: the first against the state. It's the proof the program
     *   is the one that deployed it: every resource claimed and nothing more
     *   created, what each is given the same as far as a state holds it, the
     *   same values kept secret, and every order the state has resources
     *   removed in.
     * - `result`: the second against the first, as `takesOver` does, with
     *   what was really deployed in place of what the mock makes up: the ids
     *   and outputs from the state. What the state can't hold, like a
     *   secret's value or what a function is built from, is compared as the
     *   first program gave it.
     *
     * @param leaveOut What of the state the first program doesn't deploy.
     */
    async takesOverState(
      original: () => unknown,
      v5: () => unknown,
      leaveOut: (r: RecordedResource) => boolean = () => false,
    ) {
      if (!input?.recorded) throw new Error("The mock has no recorded state");
      await newRun();
      original();
      await engine.settle();
      const before = deployed(engine.graph());
      const recorded = deployed(stateGraph(input.recorded)).filter(
        (r) => !leaveOut(r),
      );
      const asDeployed = engine.compare(recorded);

      await newRun();
      await asMove(async () => {
        v5();
        await engine.settle();
      });
      const result = engine.compare(before);
      claimsBeforeRenames(before, result);
      return { deployed: asDeployed, result };
    },
    /**
     * Deploys a component, then what replaces it, and checks the second
     * against the first, as the mock's own does. When the first renamed a
     * resource, the second has to claim it at its old address too.
     */
    async takesOver(original: () => unknown, v5: () => unknown) {
      await newRun();
      original();
      await engine.settle();
      const before = deployed(engine.graph());
      if (before.length === 0) throw new Error("The original created nothing");

      await newRun();
      await asMove(async () => {
        v5();
        await engine.settle();
      });
      const result = engine.takeover(before);
      claimsBeforeRenames(before, result);
      return result;
    },
    /**
     * The standard takeover tests for a V5 component. Call it inside a
     * `describe`. Each case is run three ways: as it is, inside another
     * component, and with a provider of its own. Each time the original is
     * deployed, then the V5 component, and everything the original created
     * has to be kept as it is: the same inputs, the same options, and for a
     * component the same registered outputs. What the original removed in
     * order has to be removed in order still.
     *
     * A case says what's expected to go (`unclaimed`) or be updated
     * (`changed`) when it isn't nothing.
     */
    takeoverCases<A, B>(suite: TakeoverCases<A, B>) {
      const mock = this;
      // The options each way gives the component, new for each of the two
      // deploys, and whether a resource was created with them.
      const ways: Record<
        TakeoverWay,
        () => Promise<{
          opts: () => pulumi.ComponentResourceOptions | undefined;
          given: (r: RecordedResource) => boolean;
        }>
      > = {
        "as it is": async () => ({ opts: () => undefined, given: () => true }),
        "inside another component": async () => ({
          opts: () => ({ parent: new Parent("Parent") }),
          given: (r) => r.parent.endsWith("::test:Parent::Parent"),
        }),
        "with another provider": async () => {
          const { Provider } = await import("@pulumi/aws");
          return {
            opts: () => ({
              provider: new Provider("West", { region: "us-west-2" }),
            }),
            given: (r) =>
              [r.options.provider, ...Object.values(r.options.providers ?? {})]
                .filter(Boolean)
                .some((ref: string) => ref.includes("::West::")),
          };
        },
      };

      for (const [name, given] of Object.entries(suite.cases)) {
        const test: TakeoverCase<A | B> =
          typeof given === "function" ? { create: given } : given;
        describe(name, () => {
          for (const way of Object.keys(ways) as TakeoverWay[]) {
            it(way, async () => {
              const { opts, given } = await ways[way]();
              const expected = <T>(value: Expected<T> | undefined) =>
                typeof value === "function"
                  ? (value as (way: TakeoverWay) => T)(way)
                  : value;
              const deploy = async (
                Component: A | B,
                written: TakeoverCase<A | B>["original"],
                // Whether the component itself has to be given the options
                strict: boolean,
              ) => {
                await newRun();
                // A case may be async, to import what it creates
                if (written) await written(opts());
                else if (test.create) await test.create(Component, opts());
                else throw new Error(`The "${name}" case creates nothing`);
                await mock.settle();
                // The options have to reach the V5 component itself, and
                // not something else the case creates. An original is only
                // asked to use them: some pass them to what they look up, and
                // a static method creates no component at all.
                const type = (Component as any).__pulumiType;
                const own = resources.filter((r) => r.type === type);
                if (!(strict ? own : resources).some(given))
                  throw new Error(
                    `The "${name}" case has to pass its options on to the component`,
                  );
              };

              await deploy(suite.original(), test.original, false);
              const before = deployed(mock.graph());
              if (before.length === 0)
                throw new Error("The original created nothing");

              await asMove(() => deploy(suite.v5(), test.v5, true));
              const result = mock.takeover(before);
              const wrappers = expected(test.wrappers);
              const isWrapper = (r: string) =>
                wrappers !== undefined && (input?.wrappers?.test(r) ?? false);
              expect(
                {
                  unclaimed: result.unclaimed
                    .filter((r) => !isWrapper(r))
                    .sort(),
                  wrappers: result.unclaimed.filter(isWrapper).length,
                  changed: result.changed.map((c) => [c.name, c.fields]),
                  unordered: result.unordered.filter(
                    (order) => !suite.needlessOrder?.test(order),
                  ),
                  revealed: result.revealed,
                },
                // Shown when it fails: what each changed resource had and has
                JSON.stringify(result.changed, null, 2),
              ).toEqual({
                unclaimed: [
                  ...(expected(test.unclaimed ?? suite.unclaimed) ?? []),
                ].sort(),
                wrappers: wrappers ?? 0,
                changed: expected(test.changed ?? suite.changed) ?? [],
                unordered: expected(test.unordered) ?? [],
                revealed: [],
              });
              claimsBeforeRenames(before, result);
              await suite.check?.(way);
              await test.check?.(way);
            });
          }
        });
      }
    },
  };
}
