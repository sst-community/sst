import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it, vi } from "vitest";
import { rpc } from "../../src/components/rpc/rpc";

/**
 * Records every resource a component registers with Pulumi, including the
 * options that decide whether an existing deployment would see a change:
 * the parent, aliases, `ignoreChanges`, `retainOnDelete` and so on.
 *
 * Porting a component to `this.part()` must leave this graph untouched. A
 * difference here is a difference `sst diff` would show on a deployed stage.
 */
export interface RecordedResource {
  kind: "register" | "read";
  type: string;
  name: string;
  parent: string;
  custom: boolean;
  inputs: Record<string, any>;
  options: Record<string, any>;
  /** What a component registered as its outputs. The CLI reads some of them. */
  outputs?: Record<string, any>;
}

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

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

export function mockPulumi(input?: {
  app?: string;
  stage?: string;
  /**
   * The components the original wraps things in, which go when the V5
   * component takes over: they have nothing in AWS behind them. A takeover
   * case says how many of them go with `wrappers`.
   */
  wrappers?: RegExp;
  /** Extra state for a resource, on top of its inputs. */
  state?: (args: pulumi.runtime.MockResourceArgs) => Record<string, any>;
  /** The result of a provider function call, like a data source lookup. */
  call?: (args: pulumi.runtime.MockCallArgs) => Record<string, any> | undefined;
  /** The source maps the build of a function writes, by the function's name. */
  sourcemaps?: (functionID: string) => string[];
}) {
  const resources: RecordedResource[] = [];
  // Counts what's sent to the engine, to tell when a deploy has gone quiet
  let activity = 0;

  // Generated names end in random characters. A deployed resource keeps the
  // name it has, so give every run the same ones.
  vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
    Buffer.alloc(size, 7)) as any);

  // Building a function calls the CLI, which isn't running here. Stand in
  // for it with an empty bundle, so a function is created in full, and so is
  // whatever waits for it.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-"));
  const bundle = path.join(work, "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(
    path.join(bundle, "index.mjs"),
    "export const handler = async () => {};\n",
  );
  // In `sst dev` a stub is deployed in place of a function's code. The CLI
  // ships it; here it's a file.
  const platform = path.join(work, "platform");
  for (const stub of ["bridge", "nodejs-bridge"]) {
    fs.mkdirSync(path.join(platform, "dist", stub), { recursive: true });
    fs.writeFileSync(path.join(platform, "dist", stub, "bootstrap"), stub);
  }
  rpc.call = (async (method: string, args: any) => {
    if (method === "Runtime.Build")
      return {
        handler: "index.handler",
        out: bundle,
        errors: [],
        sourcemaps: input?.sourcemaps?.(args.functionID) ?? [],
      };
    if (method === "Runtime.AddTarget") return {};
    if (method === "Provider.Aws.Appsync")
      return {
        http: "appsync.example.com",
        realtime: "appsync-realtime.example.com",
      };
    if (method === "Provider.Aws.Bootstrap")
      return {
        asset: "sst-asset-bucket",
        assetEcrRegistryId: "123456789012",
        assetEcrUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/sst-asset",
        state: "sst-state-bucket",
        appsyncHttp: "appsync.example.com",
        appsyncRealtime: "appsync-realtime.example.com",
      };
    return new Promise(() => {});
  }) as typeof rpc.call;

  // @ts-ignore
  global.$app = { name: input?.app ?? "app", stage: input?.stage ?? "test" };
  // @ts-ignore
  global.$util = pulumi;
  // @ts-ignore
  global.$interpolate = pulumi.interpolate;
  // @ts-ignore
  global.$jsonParse = pulumi.jsonParse;
  // @ts-ignore
  global.$jsonStringify = pulumi.jsonStringify;
  // @ts-ignore
  global.$dev = false;
  // @ts-ignore
  global.$cli = { state: { version: {} }, paths: { root: "/", work, platform } };

  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        return {
          id: `${args.name}_id`,
          state: {
            ...args.inputs,
            arn: `arn:aws:mock:us-east-1:123456789012:${args.name}`,
            url: `https://mock.example.com/123456789012/${args.name}`,
            ...input?.state?.(args),
          },
        };
      },
      call(args: pulumi.runtime.MockCallArgs) {
        return input?.call?.(args) ?? lookups[args.token]?.(args.inputs) ?? args.inputs;
      },
    },
    "project",
    "stack",
    false,
  );

  // The mocks above are not told about a resource's parent or options, so
  // read them off the registration request itself.
  const monitor = (pulumi.runtime as any).getMonitor() as any;
  // Pulumi's mock makes a resource's URN from its type and its parent's. The
  // engine uses the type of every component it's inside, and so does what
  // works out old addresses here. Without this, what's inside a component
  // inside a component inside a component has a parent nothing answers to.
  monitor.newUrn = (parent: string, type: string, name: string) =>
    urn(type, name, parent);
  const registerResource = monitor.registerResource.bind(monitor);
  monitor.registerResource = (req: any, callback: any) => {
    activity++;
    resources.push({
      kind: "register",
      type: req.getType(),
      name: req.getName(),
      parent: req.getParent(),
      custom: req.getCustom(),
      inputs: req.getObject()?.toJavaScript() ?? {},
      options: compact({
        protect: req.getProtect(),
        retainOnDelete: req.getRetainondelete(),
        deleteBeforeReplace: req.getDeletebeforereplace(),
        ignoreChanges: req.getIgnorechangesList(),
        replaceOnChanges: req.getReplaceonchangesList(),
        additionalSecretOutputs: req.getAdditionalsecretoutputsList(),
        aliases: [
          ...req.getAliasurnsList(),
          ...req.getAliasesList().map((a: any) => a.toObject()),
        ],
        importId: req.getImportid(),
        deletedWith: req.getDeletedwith(),
        provider: req.getProvider(),
        // A component is given its providers by package
        providers: Object.fromEntries(req.getProvidersMap().toArray()),
        dependencies: [...req.getDependenciesList()].sort(),
      }),
    });
    return registerResource(req, callback);
  };
  const readResource = monitor.readResource.bind(monitor);
  monitor.readResource = (req: any, callback: any) => {
    activity++;
    resources.push({
      kind: "read",
      type: req.getType(),
      name: req.getName(),
      parent: req.getParent(),
      custom: true,
      inputs: req.getProperties()?.toJavaScript() ?? {},
      options: compact({ id: req.getId(), provider: req.getProvider() }),
    });
    return readResource(req, callback);
  };

  // What a component registers as its outputs, by its URN. The CLI reads
  // some of them, like the command `sst dev` runs for a task.
  const registered = new Map<string, Record<string, any>>();
  const registerResourceOutputs = monitor.registerResourceOutputs.bind(monitor);
  monitor.registerResourceOutputs = (req: any, callback: any) => {
    activity++;
    registered.set(req.getUrn(), req.getOutputs()?.toJavaScript() ?? {});
    return registerResourceOutputs(req, callback);
  };

  const outputsOf = (r: RecordedResource): Record<string, any> =>
    registered.get(urn(r.type, r.name, r.parent)) ?? {};
  // What a deploy leaves in the state. Some things are created once per app,
  // by whatever needs them first, so only the first of two deploys creates
  // them: the key functions encrypt their links with, and a provider for
  // another region.
  const deployed = (graph: RecordedResource[]) =>
    graph.filter(
      (r) =>
        r.name !== "LambdaEncryptionKey" &&
        !r.type.startsWith("pulumi:providers:"),
    );

  return {
    resources,
    /** Empties the list, so each test sees only its own resources. */
    reset() {
      resources.length = 0;
      registered.clear();
    },
    /** The outputs a component registered, by the component's name. */
    outputsOf(name: string) {
      const component = resources.find((r) => r.name === name && !r.custom);
      return component
        ? registered.get(urn(component.type, component.name, component.parent))
        : undefined;
    },
    /**
     * Lets pending `.apply()` chains and registrations finish: waits until
     * nothing new has been registered for a few rounds, resources or a
     * component's outputs, and nothing is being read or written on disk.
     */
    async settle() {
      // A function's code is zipped on disk, which takes real time, and more
      // of it when other test files run alongside. What's registered after
      // the zip would otherwise be missed.
      const onDisk = () =>
        process
          .getActiveResourcesInfo()
          .some((resource) => /^(FSReq|FileHandle|Zlib)/i.test(resource));
      for (let quiet = 0, seen = -1; quiet < 3; ) {
        for (let i = 0; i < 50; i++)
          await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 2));
        quiet = activity === seen && !onDisk() ? quiet + 1 : 0;
        seen = activity;
      }
    },
    /** The value of an output, or of anything holding outputs. */
    resolve<T>(value: T) {
      return new Promise<any>((done) =>
        pulumi.all([value]).apply(([v]) => done(v)),
      );
    },
    /** The recorded graph in a stable order, ready to compare. */
    graph() {
      return resources
        .map((r) => ({
          ...r,
          inputs: stable(r.inputs),
          ...(r.custom ? {} : { outputs: outputsOf(r) }),
        }))
        .sort((a, b) =>
          `${a.type}::${a.name}`.localeCompare(`${b.type}::${b.name}`),
        );
    },
    /**
     * Deploys an original component, then the V5 component that replaces it,
     * and checks the takeover with `takeover()`.
     *
     * @param original Creates the original component.
     * @param v5 Creates the same thing with the V5 component.
     */
    async takesOver(original: () => unknown, v5: () => unknown) {
      this.reset();
      original();
      await this.settle();
      const before = deployed(this.graph());
      if (before.length === 0) throw new Error("The original created nothing");

      this.reset();
      v5();
      await this.settle();
      return this.takeover(before);
    },
    /**
     * The standard takeover tests for a V5 component. Call it inside a
     * `describe`. Each case is run three ways: as it is, inside another
     * component, and with a provider of its own. Each time the original is
     * deployed, then the V5 component, and everything the original created
     * has to be kept as it is: the same inputs, the same options, and for a
     * component the same registered outputs.
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
                },
                // Shown when it fails: what each changed resource had and has
                JSON.stringify(result.changed, null, 2),
              ).toEqual({
                unclaimed: [
                  ...(expected(test.unclaimed ?? suite.unclaimed) ?? []),
                ].sort(),
                wrappers: wrappers ?? 0,
                changed: expected(test.changed ?? suite.changed) ?? [],
              });
              await suite.check?.(way);
              await test.check?.(way);
            });
          }
        });
      }
    },
    /**
     * Checks that what's registered now takes over from an original graph:
     * each original resource has to be claimed by one resource registered
     * now, under the same address or through an alias, and with the same
     * inputs.
     *
     * A resource claimed this way is kept on deploy. One that isn't claimed
     * is deleted, and one whose inputs changed is updated or replaced.
     *
     * @param original The `graph()` of the component being taken over from.
     */
    takeover(original: RecordedResource[]) {
      // Every address each resource answers to: its own, its aliases, and
      // the ones it inherits from its parent's aliases, as Pulumi works
      // them out.
      const claims = new Map<string, Set<string>>();
      for (const r of resources) {
        const own = urn(r.type, r.name, r.parent);
        const aliases = ((r.options.aliases ?? []) as any[]).map((alias) =>
          typeof alias === "string"
            ? alias
            : urn(
                alias.spec.type || r.type,
                alias.spec.name || r.name,
                alias.spec.noparent ? "" : alias.spec.parenturn || r.parent,
              ),
        );
        // Under each address its parent had, the resource answers to its own
        // name and type, and to the name and type of each of its aliases.
        const inherited: string[] = [];
        const parentName = nameOf(r.parent);
        for (const parentAlias of claims.get(r.parent) ?? []) {
          if (parentAlias === r.parent) continue;
          for (const [type, name] of [
            [r.type, r.name],
            ...aliases.map((alias) => [typeOf(alias), nameOf(alias)]),
          ]) {
            const aliasName = name.startsWith(parentName)
              ? nameOf(parentAlias) + name.substring(parentName.length)
              : name;
            inherited.push(urn(type, aliasName, parentAlias));
          }
        }
        claims.set(own, new Set([own, ...aliases, ...inherited]));
      }

      const unclaimed: string[] = [];
      const pairs: [RecordedResource, RecordedResource][] = [];
      for (const before of original) {
        const address = urn(before.type, before.name, before.parent);
        const claimants = resources.filter((r) =>
          claims.get(urn(r.type, r.name, r.parent))!.has(address),
        );
        if (claimants.length > 1)
          throw new Error(
            `${before.name} is claimed by ${claimants.map((r) => r.name).join(" and ")}`,
          );
        if (claimants.length === 0) unclaimed.push(`${before.type}::${before.name}`);
        else pairs.push([before, claimants[0]]);
      }

      // Mock ids and ARNs are made from resource names, so write the names
      // used now as the original ones before comparing inputs.
      const renames = pairs
        .filter(([before, now]) => before.name !== now.name)
        .map(([before, now]) => [now.name, before.name] as const)
        .sort((a, b) => b[0].length - a[0].length);
      // A resource keeps the deployed value of an input it ignores changes
      // to, like a generated name. Whatever reads that value from it gets
      // the deployed one too.
      const keptValues = pairs
        .flatMap(([before, now]) =>
          ((now.options.ignoreChanges ?? []) as string[]).map(
            (key) => [now.inputs[key], before.inputs[key]] as const,
          ),
        )
        .filter(
          ([now, before]) =>
            typeof now === "string" && typeof before === "string" && now !== before,
        )
        .sort((a, b) => b[0].length - a[0].length);
      // A resource can't read its own id or ARN, so its own name in its
      // inputs is the name SST gave it, and that one is left as it is: a
      // `Name` tag made from a new logical name is a real change.
      const asOriginal = (own: string) => (value: string) =>
        renames
          .filter(([now]) => now !== own)
          .reduce(
            (v, [now, before]) =>
              v.replace(new RegExp(`\\b${now}(?=\\b|_)`, "g"), before),
            keptValues.reduce((v, [now, before]) => v.split(now).join(before), value),
          );
      // An input the resource ignores changes to, like a generated name,
      // keeps its deployed value.
      const kept = (r: RecordedResource, ignore: string[]) =>
        Object.fromEntries(
          Object.entries(r.inputs).filter(([key]) => !ignore.includes(key)),
        );
      const changed = pairs
        .map(([before, now]) => {
          // A resource that's looked up isn't written to. What matters is
          // that the same one is looked up.
          if (before.kind === "read" || now.kind === "read")
            return {
              name: before.name,
              original: { kind: before.kind, id: before.options.id },
              now: { kind: now.kind, id: now.options.id },
            };
          const ignore: string[] = now.options.ignoreChanges ?? [];
          // What a component registers as its outputs is kept in the state
          // too, and the CLI reads it
          const registers = !before.custom || !now.custom;
          return {
            name: before.name,
            original: {
              ...stable(kept(before, ignore)),
              ...deployOptions(before),
              ...(registers ? { outputs: stable(before.outputs ?? {}) } : {}),
            },
            now: {
              ...stable(kept(now, ignore), asOriginal(now.name)),
              ...deployOptions(now),
              ...(registers
                ? { outputs: stable(outputsOf(now), asOriginal(now.name)) }
                : {}),
            },
          };
        })
        .filter((pair) => JSON.stringify(pair.original) !== JSON.stringify(pair.now))
        // Which inputs differ, to say what a deploy would update
        .map((pair) => ({
          ...pair,
          fields: Object.keys({ ...pair.original, ...pair.now }).filter(
            (key) =>
              JSON.stringify((pair.original as any)[key]) !==
              JSON.stringify((pair.now as any)[key]),
          ),
        }));

      return { unclaimed, changed };
    },
  };
}

// The options that change what a deploy does to a resource that's already
// there, as `options.<name>` next to its inputs. Losing `ignoreChanges` on a
// database's engine version, or `retainOnDelete` on a bucket, is as much a
// change as a different input.
function deployOptions(r: RecordedResource) {
  const options = [
    "protect",
    "retainOnDelete",
    "deleteBeforeReplace",
    "ignoreChanges",
    "replaceOnChanges",
    "additionalSecretOutputs",
    "provider",
  ];
  return Object.fromEntries(
    options
      .filter((option) => r.options[option] !== undefined)
      .map((option) => {
        const value = r.options[option];
        return [
          `options.${option}`,
          Array.isArray(value) ? [...value].sort() : value,
        ];
      }),
  );
}

// What the lookups nearly every component makes return. Without these a
// region is `undefined`, and an IAM policy is empty whatever it's given, so
// two policies would always compare as the same.
const lookups: Record<string, (inputs: any) => Record<string, any>> = {
  "aws:index/getRegion:getRegion": () => ({
    name: "us-east-1",
    region: "us-east-1",
  }),
  "aws:index/getPartition:getPartition": () => ({ partition: "aws" }),
  "aws:index/getCallerIdentity:getCallerIdentity": () => ({
    accountId: "123456789012",
  }),
  "aws:iam/getPolicyDocument:getPolicyDocument": (inputs) => ({
    ...inputs,
    json: JSON.stringify(inputs),
  }),
};

function urn(type: string, name: string, parent: string) {
  if (!parent) return `urn:pulumi:stack::project::${type}::${name}`;
  const [prefix, project, types] = parent.split("::");
  return `${prefix}::${project}::${types}$${type}::${name}`;
}

function nameOf(urn: string) {
  return urn.substring(urn.lastIndexOf("::") + 2);
}

// A resource's own type: the last in the chain of its parents' types
function typeOf(urn: string) {
  return urn.split("::")[2].split("$").at(-1)!;
}

function compact(options: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(options).filter(([, v]) =>
      Array.isArray(v)
        ? v.length > 0
        : v && typeof v === "object"
          ? Object.keys(v).length > 0
          : v !== "" && v !== false && v != null,
    ),
  );
}

// Sorts keys so two sets of inputs compare, whatever order they were given in.
function stable(value: any, rename: (v: string) => string = (v) => v): any {
  if (typeof value === "string") return rename(value);
  if (Array.isArray(value)) return value.map((v) => stable(v, rename));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k], rename)]),
    );
  return value;
}
