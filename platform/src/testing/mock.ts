import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as pulumi from "@pulumi/pulumi";
import { rpc } from "../components/rpc/rpc";
import { contractVersion } from "../components/contract";
import { checkResource } from "../components/check";
import type { MovedPart } from "../components/move";
import { newRun } from "../util/lazy";
import {
  ARCHIVE,
  ASSET,
  SECRET,
  SIG,
  type StateExport,
  asChecked,
  asStateHas,
  buildHashes,
  comparable,
  hiddenInPlainText,
  policyDocument,
  replayer,
  revealedPaths,
  withHashes,
} from "./state";

/**
 * A resource a component registered, with what decides whether a deployed
 * app would see a change: its inputs, its parent, and options like aliases,
 * `ignoreChanges` and `retainOnDelete`.
 *
 * A difference between two of these is a difference `sst diff` would show on
 * a deployed stage.
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
  /**
   * What the CLI was given to build a function's code from: its handler,
   * runtime and links. The links go into the code, so they aren't in any
   * resource's inputs.
   */
  build?: Record<string, any>;
  /**
   * Read from a stage's state (`stateGraph()`), which doesn't hold everything
   * a registration does. What it doesn't hold isn't compared.
   */
  fromState?: boolean;
}

// Suppress Pulumi "Trace events are unavailable" errors in test environment
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

export interface MockInput {
  /** The app's name. Defaults to "app". */
  app?: string;
  /** The stage. Defaults to "test". */
  stage?: string;
  /** The root of the app, which paths like a function's handler are relative to. */
  root?: string;
  /**
   * For the platform's own takeover tests: the components a 4.x component
   * wraps things in, which go when its V5 component takes over.
   */
  wrappers?: RegExp;
  /** Extra state for a resource, on top of its inputs. */
  state?: (args: pulumi.runtime.MockResourceArgs) => Record<string, any>;
  /** The result of a provider function call, like a data source lookup. */
  call?: (args: pulumi.runtime.MockCallArgs) => Record<string, any> | undefined;
  /** The source maps the build of a function writes, by the function's name. */
  sourcemaps?: (functionID: string) => string[];
  /**
   * Run as a preview, the way `sst diff` runs the program, rather than as a
   * deploy.
   */
  preview?: boolean;
  /**
   * In a preview, whether a resource's id isn't known yet, as for one a
   * deploy creates: what's given its id gets an output that isn't known.
   * Otherwise a resource's id is made from its name.
   */
  unknownId?: (args: pulumi.runtime.MockResourceArgs) => boolean;
  /**
   * Run as the stage moves to new components, the way `sst migrate` runs the
   * program: each component reports what its state map says about its parts,
   * which `moved()` returns. With `preview`, it's `sst migrate --check`.
   */
  move?: boolean;
  /**
   * For the platform's own takeover tests: a stage's state, as `sst state
   * export` writes it, to run against. A resource at an address the state
   * has, or that answers to one through an alias, comes back with the id and
   * outputs deployed there, as the engine reads them from the state. A
   * secret the state has comes back as `[secret]`.
   *
   * The outputs are the state's whatever the resource is given now, as in a
   * preview. So where a resource's inputs differ from the state's, it's
   * listed as changed, and what reads its outputs isn't.
   */
  recorded?: StateExport;
  /**
   * What the CLI answers, in place of the mock's stand-ins: for a recorded
   * state, what it answered when the stage was deployed, like the bucket its
   * code went to. Undefined leaves the stand-in's answer.
   */
  cli?: (method: string, args: any) => any;
}

// The outputs 4.x's components name for the core, and what each is in a
// report of the program contract
const legacyOutputs: Record<string, string> = {
  _metadata: "function",
  _dev: "dev",
  _task: "task",
  _tunnel: "tunnel",
  _hint: "hint",
};

/**
 * A component's outputs as the core reads them (`pkg/project/report.go`): what
 * it reported, and the rest of its outputs. A report is its record (`_sst`)
 * when it has one, and otherwise what it named with 4.x's output names. So a
 * V5 component that reports what a 4.x one named is the same to the core, and
 * one that writes a record and an old name too isn't.
 */
function asTheCoreReads(outputs: Record<string, any>) {
  const { _sst, ...rest } = outputs;
  if (_sst) {
    const { contract, ...record } = _sst;
    // An item that came out empty isn't read, so a record of nothing but
    // its version is no report
    const report = Object.fromEntries(
      Object.entries(record).filter(([, item]) => item != null),
    );
    return Object.keys(report).length ? { ...rest, report } : rest;
  }
  const report: Record<string, any> = {};
  for (const [name, item] of Object.entries(legacyOutputs)) {
    if (!(name in rest)) continue;
    const value = rest[name];
    delete rest[name];
    const object = typeof value === "object" && value !== null;
    if (item === "hint" ? typeof value === "string" : object)
      if (item !== "function" || typeof value.handler === "string")
        report[item] = value;
  }
  return Object.keys(report).length ? { ...rest, report } : rest;
}

/**
 * Stands in for the Pulumi engine and for the CLI, and records what's
 * registered. Nothing is deployed: a resource comes back with the inputs it
 * was given, and an id and ARN made from its name.
 *
 * This is the part of `mock()` that needs nothing loaded. It sets the
 * globals the components read, and not the ones a config has, like `sst`.
 */
export function mockPulumi(input?: MockInput) {
  const resources: RecordedResource[] = [];
  // Counts what's sent to the engine, to tell when a deploy has gone quiet
  let activity = 0;

  // Generated names end in random characters. A deployed resource keeps the
  // name it has, so give every run the same ones.
  (crypto as any).randomBytes = (size: number) => Buffer.alloc(size, 7);

  // Building a function calls the CLI, which isn't running here. Stand in
  // for it with an empty bundle, so a function is created in full, and so is
  // whatever waits for it.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sst-test-"));
  const bundle = path.join(work, "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(
    path.join(bundle, "bundle.mjs"),
    "export const handler = async () => {};\n",
  );
  // In `sst dev` a stub is deployed in place of a function's code. The CLI
  // ships it; here it's a file.
  const platform = path.join(work, "platform");
  for (const stub of ["bridge", "nodejs-bridge"]) {
    fs.mkdirSync(path.join(platform, "dist", stub), { recursive: true });
    fs.writeFileSync(path.join(platform, "dist", stub, "bootstrap"), stub);
  }
  // What a component reads from the platform's own files, like the Lambda
  // handler a site wraps its server build in: those of the platform this
  // file is in, when it has them. A junction, which Windows makes without
  // admin rights; other systems make a symlink.
  const functions = fileURLToPath(new URL("../../functions", import.meta.url));
  if (fs.existsSync(functions))
    fs.symlinkSync(functions, path.join(platform, "functions"), "junction");
  // What the CLI builds each function from, by the function's name. The
  // name, the app's key and the mode are left out: they aren't the
  // function's own.
  const builds = new Map<string, Record<string, any>>();
  const built = ({ functionID, encryptionKey, dev, logGroup, ...build }: any) =>
    builds.set(functionID, build);
  const buildOf = (r: RecordedResource) =>
    !r.custom && r.type === "sst:aws:Function" ? builds.get(r.name) : undefined;
  // What components reported while the stage moves
  const moved: MovedPart[] = [];
  rpc.call = (async (method: string, args: any) => {
    if (method === "Runtime.Build" || method === "Runtime.AddTarget")
      built(args);
    if (method === "Move.Part") moved.push(args);
    const answer = input?.cli?.(method, args);
    if (answer !== undefined) return answer;
    if (method === "Move.Part") return {};
    // As the CLI builds a Node.js function: one file, named `bundle`, with
    // the handler's export
    if (method === "Runtime.Build")
      return {
        handler: "bundle" + (args.handler ? path.extname(args.handler) : ""),
        out: bundle,
        errors: [],
        sourcemaps: input?.sourcemaps?.(args.functionID) ?? [],
      };
    if (method === "Runtime.AddTarget") return {};
    // The account's shared Event API, as `sst dev` uses by default
    if (method === "Provider.Aws.Appsync")
      return {
        http: "appsync.example.com",
        realtime: "appsync-realtime.example.com",
        arn: "arn:aws:appsync:us-east-1:123456789012:apis/sst",
        shared: true,
      };
    // What the stub is deployed with: the shared Event API's, as `sst dev`
    // uses by default
    if (method === "Dev.Stub")
      return {
        environment: {
          SST_APPSYNC_HTTP: "appsync.example.com",
          SST_APPSYNC_REALTIME: "appsync-realtime.example.com",
        },
        permissions: [{ actions: ["appsync:*"], resources: ["*"] }],
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
  global.$app = {
    name: input?.app ?? "app",
    stage: input?.stage ?? "test",
    home: "aws",
  };
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
  global.$cli = {
    contract: contractVersion,
    command: input?.preview ? "diff" : "deploy",
    move: input?.move === true,
    state: { version: {} },
    paths: { root: input?.root ?? "/", work, platform },
  };

  // What a recorded state answers for a resource registered or read. The
  // engine's mock is told only its type and name, and asks for it as soon as
  // the request is sent, so the answer is handed over then (`send()`).
  const replay = input?.recorded ? replayer(input.recorded) : undefined;
  let reply:
    | { type: string; name: string; found?: { id: string; outputs: any } }
    | undefined;
  const send = (
    to: (req: any, callback: any) => unknown,
    req: any,
    callback: any,
    addresses: Iterable<string>,
  ) => {
    if (!replay) return to(req, callback);
    reply = {
      type: req.getType(),
      name: req.getName(),
      found: replay.find(addresses),
    };
    try {
      return to(req, callback);
    } finally {
      const unasked = reply;
      reply = undefined;
      if (unasked)
        throw new Error(
          `The engine's mock didn't ask for ${unasked.name} when it was sent`,
        );
    }
  };

  // What a lookup gives with a recorded state: as the provider answered when
  // the stage was deployed, where the state says
  const replayed = (args: pulumi.runtime.MockCallArgs) => {
    if (args.token === "aws:index/getRegion:getRegion") {
      const region = replay!.region(args.provider);
      return region ? { name: region, region, id: region } : undefined;
    }
    if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
      return policyDocument(args.inputs);
    if (args.token === "sst:aws:getHostedZone") {
      const zoneId = replay!.hostedZone(args.inputs.domain);
      return zoneId ? { zoneId } : undefined;
    }
  };

  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        if (reply && (reply.type !== args.type || reply.name !== args.name))
          throw new Error(
            `The engine's mock asked for ${args.name} while ${reply.name} was sent`,
          );
        const recorded = reply?.found;
        reply = undefined;
        if (recorded) return { id: recorded.id, state: recorded.outputs };
        return {
          // No id is one that isn't known, to the engine in a preview
          id:
            input?.preview && input.unknownId?.(args)
              ? ""
              : // SST 4's Cloudflare zone lookup is given the zone's id as its own
                args.name.endsWith(".sst.cloudflare.ZoneLookup")
                ? zoneOf(args.inputs.domain).id
                : `${args.name}_id`,
          state: {
            ...args.inputs,
            arn: `arn:aws:mock:us-east-1:123456789012:${args.name}`,
            url: `https://mock.example.com/123456789012/${args.name}`,
            ...given(args),
            ...input?.state?.(args),
          },
        };
      },
      call(args: pulumi.runtime.MockCallArgs) {
        return (
          input?.call?.(args) ??
          (replay && replayed(args)) ??
          lookups[args.token]?.(args.inputs) ??
          args.inputs
        );
      },
    },
    "project",
    "stack",
    input?.preview ?? false,
  );
  // The app's region, which the CLI sets for the AWS provider: the one a
  // recorded stage was deployed in, or the one the lookups give
  pulumi.runtime.setConfig(
    "aws:region",
    replay?.region(undefined) ?? "us-east-1",
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
  const findings: string[] = [];
  // A deploy here has its preview first, so the program's checks turn on
  process.env.SST_PREVIEW_FIRST = "1";
  // Every address each resource registered answers to, by its own
  const addresses = new Map<string, Set<string>>();
  monitor.registerResource = (req: any, callback: any) => {
    activity++;
    const r: RecordedResource = {
      kind: "register",
      type: req.getType(),
      name: req.getName(),
      parent: req.getParent(),
      custom: req.getCustom(),
      // What a file asset holds is read now: what's registered later can
      // write the file again
      inputs: withHashes(req.getObject()?.toJavaScript() ?? {}),
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
    };
    resources.push(r);
    const own = urn(r.type, r.name, r.parent);
    addresses.set(own, answersTo(r, addresses.get(r.parent)));
    // A component isn't in the engine's mock's state, and gets no answer
    const register = () =>
      send(
        registerResource,
        req,
        callback,
        r.custom ? addresses.get(own)! : [],
      );
    // The program's checks look at a resource before it's registered, as
    // they do in a deploy. What they find is kept in `findings`, for a test
    // to read, and the resource is registered anyway.
    if (!req.getCustom()) return register();
    checkResource(
      req.getType(),
      req.getName(),
      req.getObject()?.toJavaScript() ?? {},
    ).then(register, (error: any) => {
      findings.push(String(error?.message ?? error));
      register();
    });
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
    return send(readResource, req, callback, [
      urn(req.getType(), req.getName(), req.getParent()),
    ]);
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
    /**
     * What the program's checks found in resources, from `sst.check()`, each
     * as the message a deploy stops with. A component's checks throw when
     * it's created, as in a deploy.
     */
    findings,
    /** What the mock was created with. */
    input,
    /** What a deploy leaves in the state, of a `graph()`. */
    deployed,
    /**
     * What components reported while the stage moves, with `move` set: each
     * part their state maps list as new, replaced, or in the place of what's
     * released. The core reads these in `sst migrate --check`.
     */
    moved() {
      return [...moved];
    },
    /**
     * Empties the list, so each test sees only its own resources, and starts
     * a new run of the program: what an app creates once, like the key links
     * are encrypted with, is created again.
     */
    reset() {
      newRun();
      resources.length = 0;
      findings.length = 0;
      moved.length = 0;
      registered.clear();
      builds.clear();
      addresses.clear();
    },
    /** The outputs a component registered, by the component's name. */
    outputsOf(name: string) {
      const component = resources.find((r) => r.name === name && !r.custom);
      return component
        ? registered.get(urn(component.type, component.name, component.parent))
        : undefined;
    },
    /**
     * What a component reported to the core through the program contract, by
     * the component's name: the record the core reads from its outputs.
     */
    reportOf(name: string): Record<string, any> | undefined {
      return this.outputsOf(name)?._sst;
    },
    /**
     * Lets pending `.apply()` chains and registrations finish: waits until
     * nothing new has been registered for a few rounds, resources or a
     * component's outputs, nothing is being read or written on disk, and no
     * command is running.
     */
    async settle() {
      // A function's code is zipped on disk, and a site is built by a command,
      // which take real time, and more of it when other test files run
      // alongside. What's registered after them would otherwise be missed.
      const busy = () =>
        process
          .getActiveResourcesInfo()
          .some((resource) =>
            /^(FSReq|FileHandle|Zlib|ProcessWrap)/i.test(resource),
          );
      for (let quiet = 0, seen = -1; quiet < 3; ) {
        for (let i = 0; i < 50; i++)
          await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 2));
        quiet = activity === seen && !busy() ? quiet + 1 : 0;
        seen = activity;
      }
    },
    /** The value of an output, or of anything holding outputs. */
    resolve<T>(value: T) {
      return new Promise<any>((done) =>
        pulumi.all([value]).apply(([v]) => done(v)),
      );
    },
    /**
     * Whether a resource depends on another, directly or through what it
     * depends on. A deploy removes resources in the reverse of that order,
     * so it's also whether the first is removed before the second.
     *
     * @param from The name of the resource.
     * @param to The name of what it should depend on, or a pattern for it.
     */
    dependsOn(from: string, to: string | RegExp) {
      const start = resources.find((r) => r.name === from);
      if (!start) throw new Error(`Nothing named "${from}" was created`);
      const seen = new Set<string>();
      const reaches = (r: RecordedResource | undefined): boolean =>
        ((r?.options.dependencies ?? []) as string[]).some((dependency) => {
          if (seen.has(dependency)) return false;
          seen.add(dependency);
          const name = nameOf(dependency);
          return (
            (typeof to === "string" ? name === to : to.test(name)) ||
            reaches(
              resources.find(
                (r) => urn(r.type, r.name, r.parent) === dependency,
              ),
            )
          );
        });
      return reaches(start);
    },
    /** The recorded graph in a stable order, ready to compare. */
    graph() {
      return resources
        .map((r) => ({
          ...r,
          inputs: stable(r.inputs),
          ...(r.custom ? {} : { outputs: outputsOf(r) }),
          ...(buildOf(r) ? { build: buildOf(r) } : {}),
        }))
        .sort((a, b) =>
          `${a.type}::${a.name}`.localeCompare(`${b.type}::${b.name}`),
        );
    },
    /**
     * Deploys a component, then what replaces it, and checks the second
     * against the first with `takeover()`: a V5 component against the one it
     * takes over from, or a component against how it was before a change.
     *
     * @param original Creates the component that's deployed.
     * @param v5 Creates the same thing with what replaces it.
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
     * Checks that what's registered now takes over from an original graph:
     * each original resource has to be claimed by one resource registered
     * now, under the same address or through an alias, and with the same
     * inputs.
     *
     * A resource claimed this way is kept on deploy. One that isn't claimed
     * is deleted, and one whose inputs changed is updated or replaced.
     * `unordered` lists what the original removed in order and this doesn't:
     * "MyService before MyNamespace". `revealed` lists where a value the
     * original kept secret is in plain text now, in a resource's inputs or a
     * component's outputs: "MyParameter.value". A deploy updates nothing for
     * it, but the state holds the value in plain text from then on.
     *
     * A secret is compared by its value, and a file asset or archive by what
     * was in the file when the resource was registered.
     *
     * @param original The `graph()` of what's deployed: taken a moment ago,
     * or saved to a file and read back.
     */
    takeover(original: RecordedResource[]) {
      const { unclaimed, changed, unordered, revealed } =
        this.compare(original);
      return { unclaimed, changed, unordered, revealed };
    },
    /**
     * What `takeover()` checks, and more:
     *
     * - `hidden`: where a value that was plain is kept secret now, which
     *   changes nothing in AWS.
     * - `created`: what's registered now that takes the place of nothing in
     *   the original, which a deploy creates.
     * - `pairs`: each original resource, with what claims it now.
     *
     * Run against a recorded state, `revealed` also lists where a value
     * holds a secret the state has (`[secret]`) in plain text, in anything
     * registered now.
     */
    compare(original: RecordedResource[]) {
      const claims = new Map<string, Set<string>>();
      for (const r of resources)
        claims.set(
          urn(r.type, r.name, r.parent),
          answersTo(r, claims.get(r.parent)),
        );

      // What a part releases, as its component told the core while the stage
      // moved: the resource leaves the state without its delete, and the
      // part takes its place
      const releasedTo = new Map<string, string>();
      for (const part of moved)
        for (const address of part.releases ?? [])
          releasedTo.set(address, part.urn);
      const releases: [RecordedResource, RecordedResource][] = [];

      const unclaimed: string[] = [];
      const pairs: [RecordedResource, RecordedResource][] = [];
      const claimed = new Set<RecordedResource>();
      for (const before of original) {
        const address = urn(before.type, before.name, before.parent);
        const claimants = resources.filter((r) =>
          claims.get(urn(r.type, r.name, r.parent))!.has(address),
        );
        if (claimants.length > 1)
          throw new Error(
            `${before.name} is claimed by ${claimants
              .map((r) => r.name)
              .join(" and ")}`,
          );
        const releasedBy = resources.find(
          (r) => urn(r.type, r.name, r.parent) === releasedTo.get(address),
        );
        if (claimants.length === 0 && releasedBy) {
          releases.push([before, releasedBy]);
          claimed.add(releasedBy);
        } else if (claimants.length === 0 && isLookup(before)) {
          // One of SST 4's lookups, which 5.0 makes with a function of SST's
          // provider: a move releases it, as nothing in the cloud is behind
          // it (pkg/move)
        } else if (claimants.length === 0)
          unclaimed.push(`${before.type}::${before.name}`);
        else {
          pairs.push([before, claimants[0]]);
          claimed.add(claimants[0]);
        }
      }
      const created = deployed(resources)
        .filter((r) => !claimed.has(r))
        .map((r) => `${r.type}::${r.name}`)
        .sort();

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
            typeof now === "string" &&
            typeof before === "string" &&
            now !== before,
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
            keptValues.reduce(
              (v, [now, before]) => v.split(now).join(before),
              value,
            ),
          );
      // An input the resource ignores changes to, like a generated name,
      // keeps its deployed value.
      const kept = (r: RecordedResource, ignore: string[]) =>
        Object.fromEntries(
          Object.entries(r.inputs).filter(([key]) => !ignore.includes(key)),
        );
      // The hashes of what the mock built, which a state has the CLI's for
      const built = original.some((r) => r.fromState)
        ? buildHashes(resources)
        : new Set<string>();
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
          // A stage's state holds less than a registration: it's compared
          // with what it holds. Otherwise what's compared is what the
          // provider is given. Either way, whether a value is kept secret is
          // said apart.
          const state = before.fromState === true;
          const original = (values: Record<string, any>) =>
            state ? comparable(values) : withoutSecrets(values);
          const current = (
            values: Record<string, any>,
            was: Record<string, any>,
          ) =>
            state ? asStateHas(was, values, built) : withoutSecrets(values);
          // Run against a state, what's registered was given what the state
          // has, so nothing needs writing as it was
          const rename = state || replay ? undefined : asOriginal(now.name);
          const outputs = asTheCoreReads(before.outputs ?? {});
          // What a function's code is built from ends up in the code
          const builds = !state && (before.build || buildOf(now));
          return {
            name: before.name,
            original: {
              ...stable(original(kept(before, ignore))),
              ...deployOptions(before, state),
              ...(registers ? { outputs: stable(original(outputs)) } : {}),
              ...(builds ? { build: stable(before.build ?? {}) } : {}),
            },
            now: {
              ...stable(
                current(
                  state
                    ? asChecked(now.type, kept(now, ignore))
                    : kept(now, ignore),
                  before.inputs,
                ),
                rename,
              ),
              ...deployOptions(now, state),
              ...(registers
                ? {
                    outputs: stable(
                      current(asTheCoreReads(outputsOf(now)), outputs),
                      rename,
                    ),
                  }
                : {}),
              ...(builds ? { build: stable(buildOf(now) ?? {}, rename) } : {}),
            },
          };
        })
        .filter(
          (pair) => JSON.stringify(pair.original) !== JSON.stringify(pair.now),
        )
        // Which inputs differ, to say what a deploy would update
        .map((pair) => ({
          ...pair,
          fields: Object.keys({ ...pair.original, ...pair.now }).filter(
            (key) =>
              JSON.stringify((pair.original as any)[key]) !==
              JSON.stringify((pair.now as any)[key]),
          ),
        }));

      // What takes a released resource's place has to write the same thing
      // again: it's given what that was, but for the code a dynamic resource
      // keeps of its provider
      for (const [before, now] of releases) {
        const { __provider, ...was } = before.inputs;
        const state = before.fromState === true;
        const pair = {
          name: before.name,
          original: stable(state ? comparable(was) : withoutSecrets(was)),
          now: stable(
            state
              ? asStateHas(was, now.inputs, built)
              : withoutSecrets(now.inputs),
            state || replay ? undefined : asOriginal(now.name),
          ),
        };
        const fields = Object.keys({ ...pair.original, ...pair.now }).filter(
          (key) =>
            JSON.stringify(pair.original[key]) !==
            JSON.stringify(pair.now[key]),
        );
        if (fields.length) changed.push({ ...pair, fields } as any);
      }

      // A deploy removes resources in the reverse of the order they depend
      // on each other, so a dependency is also a promise about teardown:
      // what depends on a resource is removed before it. Each one the
      // original graph had has to be there now, directly or through
      // something in between. Without it the two are removed in any order,
      // and AWS refuses to delete what's still in use.
      const dependsOn = (graph: RecordedResource[]) => {
        const byUrn = new Map(
          graph.map((r) => [urn(r.type, r.name, r.parent), r] as const),
        );
        return (from: RecordedResource, to: RecordedResource) => {
          const target = urn(to.type, to.name, to.parent);
          const seen = new Set<RecordedResource>();
          const reaches = (r: RecordedResource | undefined): boolean => {
            if (!r || seen.has(r)) return false;
            seen.add(r);
            return ((r.options.dependencies ?? []) as string[]).some(
              (dependency) =>
                dependency === target || reaches(byUrn.get(dependency)),
            );
          };
          return reaches(from);
        };
      };
      const before = new Map(
        pairs.map(([before, now]) => [
          urn(before.type, before.name, before.parent),
          now,
        ]),
      );
      const ordered = dependsOn(resources);
      const unordered = pairs.flatMap(([original, now]) =>
        ((original.options.dependencies ?? []) as string[])
          .map((dependency) => before.get(dependency))
          .filter(
            (dependency): dependency is RecordedResource =>
              !!dependency && dependency !== now && !ordered(now, dependency),
          )
          .map((dependency) => `${now.name} before ${dependency.name}`),
      );

      // Where a value is kept secret in one and not the other: a resource's
      // inputs, and what a component registers as its outputs. A deploy
      // updates nothing for it, but the state keeps the value in plain text
      // from then on, or encrypted. A state can have a secret on the
      // property that holds it, where the program put it deeper.
      const secrets = (r: RecordedResource, outputs: Record<string, any>) => {
        const { __provider, ...inputs } = r.inputs;
        return r.custom ? inputs : { ...inputs, outputs };
      };
      const revealed: string[] = [];
      const hidden: string[] = [];
      for (const [before, now] of pairs) {
        if (before.kind === "read" || now.kind === "read") continue;
        const widened = before.fromState === true;
        const was = secrets(before, before.outputs ?? {});
        // A state holds what the provider's check made of the inputs
        const is = secrets(
          widened ? { ...now, inputs: asChecked(now.type, now.inputs) } : now,
          outputsOf(now),
        );
        for (const path of revealedPaths(was, is, widened))
          revealed.push(`${before.name}.${path}`);
        for (const path of revealedPaths(is, was, widened))
          hidden.push(`${before.name}.${path}`);
      }
      // A secret the state has is given as `[secret]`, so where that's in
      // plain text, a secret's value is written in plain text
      if (replay)
        for (const r of resources) {
          const paired = pairs.find(([, now]) => now === r);
          for (const path of hiddenInPlainText(secrets(r, outputsOf(r))))
            revealed.push(`${(paired?.[0] ?? r).name}.${path}`);
        }

      return {
        unclaimed,
        changed,
        unordered,
        revealed: [...new Set(revealed)].sort(),
        hidden: hidden.sort(),
        created,
        pairs,
        /** Each resource released, and the part that takes its place. */
        releases,
      };
    },
  };
}

// Inputs as the provider is given them: a secret's value, no value for a
// secret with none, and an asset or archive by what was in its file when it
// was registered, as Pulumi compares them, not where it was written
function withoutSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  if (value[SIG] === SECRET)
    return value.value == null ? undefined : withoutSecrets(value.value);
  if ((value[SIG] === ASSET || value[SIG] === ARCHIVE) && value.hash)
    return { [SIG]: value[SIG], hash: value.hash };
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, v]) => [key, withoutSecrets(v)])
      .filter(([, v]) => v !== undefined),
  );
}

// Every address a resource answers to: its own, its aliases, and the ones it
// inherits from its parent's aliases, as Pulumi works them out. Under each
// address its parent had, a resource answers to its own name and type, and to
// the name and type of each of its aliases.
function answersTo(r: RecordedResource, parent: Set<string> | undefined) {
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
  const inherited: string[] = [];
  const parentName = nameOf(r.parent);
  for (const parentAlias of parent ?? []) {
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
  return new Set([own, ...aliases, ...inherited]);
}

// The options that change what a deploy does to a resource that's already
// there, as `options.<name>` next to its inputs. Losing `ignoreChanges` on a
// database's engine version, or `retainOnDelete` on a bucket, is as much a
// change as a different input.
//
// A stage's state doesn't hold `deleteBeforeReplace`, so it isn't compared
// with one.
function deployOptions(r: RecordedResource, againstState = false) {
  const options = [
    "protect",
    "retainOnDelete",
    ...(againstState ? [] : ["deleteBeforeReplace"]),
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

// SST 4's lookups, made with resources, by the kind each adds to its name.
// 5.0 makes them with functions, and a move releases them.
const LOOKUPS = [".sst.aws.HostedZoneLookup", ".sst.cloudflare.ZoneLookup"];

function isLookup(r: RecordedResource) {
  return (
    r.type === "pulumi-nodejs:dynamic:Resource" &&
    LOOKUPS.some((kind) => r.name.endsWith(kind))
  );
}

// What AWS gives back that a component reads, as AWS gives it: an ACM
// certificate's validation records, one for each domain, which a domain and
// its wildcard share
// The zone a domain is in: the one named after its last two labels, as SST's
// lookups and the zone functions all find it
function zoneOf(domain: string) {
  const name = domain.replace(/\.$/, "").split(".").slice(-2).join(".");
  return { id: `${name.replace(".", "-")}-zone`, name };
}

function given(args: pulumi.runtime.MockResourceArgs): Record<string, any> {
  if (args.name.endsWith(".sst.aws.HostedZoneLookup"))
    return { zoneId: zoneOf(args.inputs.domain).id };
  if (args.name.endsWith(".sst.cloudflare.ZoneLookup")) {
    const zone = zoneOf(args.inputs.domain);
    return { zoneId: zone.id, zoneName: zone.name };
  }
  if (args.type === "aws:acm/certificate:Certificate") {
    const domains: string[] = [
      args.inputs.domainName,
      ...(args.inputs.subjectAlternativeNames ?? []),
    ].filter((domain) => typeof domain === "string");
    return {
      domainValidationOptions: domains.map((domain) => {
        const validated = domain.replace(/^\*\./, "");
        return {
          domainName: domain,
          resourceRecordType: "CNAME",
          resourceRecordName: `_abc.${validated}.`,
          resourceRecordValue: `_def.${validated}.acm-validations.aws.`,
        };
      }),
    };
  }
  return {};
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
  // A zone for each domain of two labels, like `example.com`
  "cloudflare:index/getZones:getZones": (inputs) => ({
    results: inputs.name?.split(".").length === 2 ? [zoneOf(inputs.name)] : [],
  }),
  "sst:aws:getHostedZone": (inputs) => ({ zoneId: zoneOf(inputs.domain).id }),
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
