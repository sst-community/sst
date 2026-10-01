import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import {
  type MockInput,
  type RecordedResource,
  mockPulumi as mockEngine,
} from "../../src/testing/mock";

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

  return {
    ...engine,
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
                mock.reset();
                if (written) written(opts());
                else if (test.create) test.create(Component, opts());
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

              await deploy(suite.v5(), test.v5, true);
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
              });
              await suite.check?.(way);
              await test.check?.(way);
            });
          }
        });
      }
    },
  };
}
