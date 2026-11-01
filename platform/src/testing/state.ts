import crypto from "crypto";
import fs from "fs";
import type { RecordedResource } from "./mock";

/** A stage's state as `sst state export` writes it: Pulumi's deployment. */
export interface StateExport {
  version: number;
  checkpoint: {
    stack?: string;
    latest?: { resources?: StateResource[] };
  };
}

/** A resource as a stage's state holds it. */
export interface StateResource {
  urn: string;
  type: string;
  custom: boolean;
  id?: string;
  parent?: string;
  external?: boolean;
  delete?: boolean;
  provider?: string;
  inputs?: Record<string, any>;
  outputs?: Record<string, any>;
  dependencies?: string[];
  protect?: boolean;
  retainOnDelete?: boolean;
  ignoreChanges?: string[];
  replaceOnChanges?: string[];
  additionalSecretOutputs?: string[];
}

// How Pulumi marks a value that isn't plain, in a state and on the wire
export const SIG = "4dabf18193072939515e22adb298388d";
export const SECRET = "1b47061264138c4ac30d75fd1eb44270";
export const ASSET = "c44067f5952c0a294b673a41bacd8c17";
export const ARCHIVE = "0def7320c3a5731c473e5ecbe6d01bc7";

/**
 * What a secret's value is where a state has it encrypted. A program run
 * against a state is given it for each secret the state has, so a plain value
 * that holds it is a secret written in plain text.
 */
export const HIDDEN = "[secret]";

/**
 * An address as the mock has it: the same type and name, under the mock's
 * stack and project. A state's root, the stack itself, is no parent.
 */
function asMockAddress(urn: string | undefined) {
  if (!urn || urn.split("::")[2] === "pulumi:pulumi:Stack") return "";
  return urn.replace(
    /^urn:pulumi:[^:]*::[^:]*::/,
    "urn:pulumi:stack::project::",
  );
}

// A provider as a resource refers to it: its address and its id. A default
// provider is the one the engine makes, which a program doesn't name.
function asMockProvider(reference: string | undefined) {
  if (!reference) return undefined;
  const at = reference.lastIndexOf("::");
  const address = reference.substring(0, at);
  if (/^default(_\d+_\d+_\d+)?$/.test(address.split("::").at(-1)!))
    return undefined;
  return `${asMockAddress(address)}::${reference.substring(at + 2)}`;
}

/**
 * A value from a state, as the engine gives it to a program: a secret it
 * can't decrypt, as a secret whose value is hidden, and without what the
 * provider keeps for itself.
 */
function asWire(value: any): any {
  if (Array.isArray(value)) return value.map(asWire);
  if (!value || typeof value !== "object") return value;
  if (value[SIG] === SECRET)
    return {
      [SIG]: SECRET,
      value:
        "plaintext" in value ? asWire(JSON.parse(value.plaintext)) : HIDDEN,
    };
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "__pulumi_raw_state_delta")
      .map(([key, v]) => [key, asWire(v)]),
  );
}

/**
 * A resource's inputs, or a component's outputs, from a state, as they're
 * compared with what's registered now (`asStateHas()`):
 *
 * - A secret is encrypted, so it's compared only as that, where the state
 *   has it. The provider can keep it on the property that holds it rather
 *   than where the program put it, like a list, so what's registered now is
 *   hidden where the state's is.
 * - An asset or an archive is what a build made, which the mock doesn't run,
 *   so it's compared only as that.
 * - A dynamic resource's `__provider` is its provider's code as the program's
 *   bundle serializes it, and the mock's isn't the CLI's bundle.
 */
export function comparable(properties: Record<string, any>) {
  const value = (v: any): any => {
    if (Array.isArray(v)) return v.map(value);
    if (!v || typeof v !== "object") return v;
    if (v[SIG] === SECRET) return HIDDEN;
    if (v[SIG] === ASSET) return "[asset]";
    if (v[SIG] === ARCHIVE) return "[archive]";
    return Object.fromEntries(
      Object.entries(v).map(([key, inner]) => [key, value(inner)]),
    );
  };
  return value(withoutProvider(properties));
}

/**
 * What's registered now, as `comparable()` gives what the state has: hidden
 * where the state has a secret, and otherwise a secret's value, as whether
 * it's kept secret is compared apart. Where the two can only differ by how
 * the mock stands in for the CLI and the provider, it's the state's:
 *
 * - A hash of what a build made, like the one a function's code object and
 *   source maps are named after, is the state's where the two are otherwise
 *   the same: the mock's build isn't the CLI's.
 * - An object given for what the state has as a string is written as the
 *   provider writes it: JSON, with its keys in order, as Go writes a map.
 *
 * @param hashes The hashes of what the mock built, from `buildHashes()`.
 */
export function asStateHas(
  state: Record<string, any>,
  now: Record<string, any>,
  hashes: Set<string>,
): Record<string, any> {
  const pair = (was: any, v: any): any => {
    if (v && typeof v === "object" && v[SIG] === SECRET)
      return pair(was, v.value ?? undefined);
    if (v === undefined) return undefined;
    if (was && typeof was === "object" && was[SIG] === SECRET) return HIDDEN;
    if (v && typeof v === "object" && v[SIG] === ASSET) return "[asset]";
    if (v && typeof v === "object" && v[SIG] === ARCHIVE) return "[archive]";
    if (typeof v === "string" && typeof was === "string")
      return sameButBuilt(was, v, hashes) ? was : v;
    if (typeof was === "string" && v && typeof v === "object")
      return goJson(revealed(v));
    if (Array.isArray(v))
      return v.map((inner, i) =>
        pair(Array.isArray(was) ? was[i] : undefined, inner),
      );
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, inner]) => [
          key,
          pair(was && typeof was === "object" ? was[key] : undefined, inner),
        ]),
      );
    return v;
  };
  return pair(withoutProvider(state), withoutProvider(now));
}

function withoutProvider(properties: Record<string, any>) {
  const { __provider, ...rest } = properties;
  return rest;
}

// A value with each secret in it as its value
function revealed(value: any): any {
  if (Array.isArray(value)) return value.map(revealed);
  if (!value || typeof value !== "object") return value;
  if (value[SIG] === SECRET) return revealed(value.value);
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, revealed(v)]),
  );
}

/**
 * The hashes of what the mock's builds made: the archives of functions' code,
 * among the inputs of what's registered, as the mock recorded them when each
 * was registered.
 */
export function buildHashes(resources: RecordedResource[]) {
  const hashes = new Set<string>();
  const visit = (v: any) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    if (v[SIG] === ASSET || v[SIG] === ARCHIVE) {
      if (typeof v.hash === "string") hashes.add(v.hash);
      return;
    }
    Object.values(v).forEach(visit);
  };
  resources.forEach((r) => visit(r.inputs));
  return hashes;
}

/**
 * Each asset or archive in a value, with the sha256 of its file as `hash`, as
 * Pulumi's state keeps an asset's. A file can be written again by what's
 * registered later, so it's read when what holds it is registered.
 */
export function withHashes(value: any): any {
  if (Array.isArray(value)) return value.map(withHashes);
  if (!value || typeof value !== "object") return value;
  if (value[SIG] === ASSET || value[SIG] === ARCHIVE) {
    if (
      typeof value.path !== "string" ||
      !fs.existsSync(value.path) ||
      !fs.statSync(value.path).isFile()
    )
      return value;
    return {
      ...value,
      hash: crypto
        .createHash("sha256")
        .update(fs.readFileSync(value.path))
        .digest("hex"),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, withHashes(v)]),
  );
}

/**
 * Where a value that was kept secret is in plain text now, as paths like
 * `environment.variables.KEY`: each plain value now that a secret held
 * before. With `widened`, a secret that's anywhere in what held one before
 * keeps it: a state can have it on the property that holds it, where the
 * program put it deeper.
 */
export function revealedPaths(was: any, now: any, widened = false) {
  const before = secretPaths(was);
  const after = secretPaths(now);
  return plainValues(now)
    .filter(([path]) =>
      before.some(
        (secret) =>
          under(path, secret) &&
          !(widened && after.some((kept) => under(kept, secret))),
      ),
    )
    .map(([path]) => written(path));
}

/**
 * Where a value holds a plain string with a state's hidden secret in it
 * (`HIDDEN`), as paths: a secret the state has, written in plain text.
 */
export function hiddenInPlainText(value: any) {
  return plainValues(value)
    .filter(([, v]) => typeof v === "string" && v.includes(HIDDEN))
    .map(([path]) => written(path));
}

// A place in a value: the keys and indexes to it
type Path = (string | number)[];

// Whether a place is the other one, or inside it
const under = (path: Path, of: Path) =>
  of.length <= path.length && of.every((key, i) => path[i] === key);

// A place as it's written: `a.b[0].c`
const written = (path: Path) =>
  path
    .map((key, i) =>
      typeof key === "number" ? `[${key}]` : i === 0 ? key : `.${key}`,
    )
    .join("");

// Where a value holds a secret with a value
function secretPaths(value: any, path: Path = []): Path[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => secretPaths(v, [...path, i]));
  if (!value || typeof value !== "object") return [];
  if (value[SIG] === SECRET)
    return value.value != null || "ciphertext" in value ? [path] : [];
  if (SIG in value) return [];
  return Object.entries(value).flatMap(([key, v]) =>
    secretPaths(v, [...path, key]),
  );
}

// Each plain value a value holds, outside any secret, with where it is. An
// asset or an archive is one value.
function plainValues(value: any, path: Path = []): [Path, any][] {
  if (value == null) return [];
  if (Array.isArray(value))
    return value.flatMap((v, i) => plainValues(v, [...path, i]));
  if (typeof value !== "object") return [[path, value]];
  if (value[SIG] === SECRET) return [];
  if (SIG in value) return [[path, value]];
  return Object.entries(value).flatMap(([key, v]) =>
    plainValues(v, [...path, key]),
  );
}

// Whether two strings differ only where the second has the hash of something
// the mock built, and the first a hash of the same length
function sameButBuilt(was: string, now: string, hashes: Set<string>) {
  if (was === now || was.length !== now.length) return false;
  let rest = now;
  for (const hash of hashes)
    for (let at = rest.indexOf(hash); at >= 0; at = rest.indexOf(hash, at)) {
      if (!/^[0-9a-f]{64}$/.test(was.substring(at, at + 64))) return false;
      rest =
        rest.substring(0, at) +
        was.substring(at, at + 64) +
        rest.substring(at + 64);
      at += 64;
    }
  return rest === was;
}

// JSON as Go's encoder writes it: compact, a map's keys in order, and what
// HTML treats as markup escaped
function goJson(value: any) {
  const order = (v: any): any =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === "object"
        ? sorted(
            Object.fromEntries(
              Object.entries(v).map(([k, i]) => [k, order(i)]),
            ),
          )
        : v;
  return escapeHtml(JSON.stringify(order(value)));
}

function escapeHtml(json: string) {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * What the AWS provider's `getPolicyDocument` returns: the policy as JSON, in
 * the provider's own layout (terraform-provider-aws,
 * `internal/service/iam/policy_document_data_source.go` and
 * `policy_model.go`). A recorded state holds the JSON the provider made, so
 * this is what a replay is compared with.
 *
 * - The keys are in a fixed order, and a map's are sorted.
 * - Actions, resources and a principal's identifiers are sets: a set of one
 *   is a string, and a longer one is sorted in reverse.
 * - A condition's values are a list, kept in order: a list of one is a
 *   string.
 * - A principal of type `*` with the identifier `*` alone is `"*"`.
 * - `&{` is written `${`, as the provider lets a policy variable be given.
 *
 * Principals of the same type, or conditions on the same variable, are
 * joined in the order given, where the provider takes a set's order from its
 * hashes. Where that differs, the JSON differs from the state's, and the
 * resource that reads it is listed as changed.
 */
export function policyDocument(inputs: Record<string, any>) {
  for (const key of [
    "sourcePolicyDocuments",
    "overridePolicyDocuments",
    "sourceJson",
    "overrideJson",
  ])
    if (inputs[key] !== undefined)
      throw new Error(`The mock doesn't merge policy documents (${key})`);
  const set = (values: string[] | undefined) => {
    const unique = [...new Set(values ?? [])];
    if (unique.length === 0) return undefined;
    if (unique.length === 1) return unique[0];
    return unique.sort().reverse();
  };
  // Written after the set is sorted, and a principal's identifiers are
  // sorted again
  const variables = <T extends string | string[] | undefined>(value: T): T =>
    (typeof value === "string"
      ? value.replaceAll("&{", "${")
      : value?.map((v) => v.replaceAll("&{", "${"))) as T;
  const principals = (given: any[] | undefined) => {
    if (!given?.length) return undefined;
    const ids = (p: any) => {
      const ids = variables(set(p.identifiers));
      return Array.isArray(ids) ? ids.sort().reverse() : ids;
    };
    if (given.length === 1 && given[0].type === "*" && ids(given[0]) === "*")
      return "*";
    const byType: Record<string, string | string[]> = {};
    for (const p of given) {
      const had = byType[p.type];
      byType[p.type] = had === undefined ? ids(p)! : [had, ids(p)!].flat();
    }
    return sorted(byType);
  };
  const conditions = (given: any[] | undefined) => {
    if (!given?.length) return undefined;
    const byTest: Record<string, Record<string, string[]>> = {};
    // Conditions are a set: the same one twice is one
    const unique = new Map(
      given.map((c) => [JSON.stringify([c.test, c.variable, c.values]), c]),
    );
    for (const c of unique.values()) {
      byTest[c.test] ??= {};
      byTest[c.test][c.variable] = [
        ...(byTest[c.test][c.variable] ?? []),
        ...variables((c.values ?? []) as string[]),
      ];
    }
    return sorted(
      Object.fromEntries(
        Object.entries(byTest).map(([test, byVariable]) => [
          test,
          sorted(
            Object.fromEntries(
              Object.entries(byVariable).map(([variable, values]) => [
                variable,
                values.length === 1 ? values[0] : values,
              ]),
            ),
          ),
        ]),
      ),
    );
  };
  const statements = (inputs.statements ?? []) as any[];
  const doc = {
    Version: inputs.version ?? "2012-10-17",
    Id: inputs.policyId || undefined,
    Statement: statements.length
      ? statements.map((s) => ({
          Sid: s.sid || undefined,
          Effect: s.effect ?? "Allow",
          Action: set(s.actions),
          NotAction: set(s.notActions),
          Resource: variables(set(s.resources)),
          NotResource: variables(set(s.notResources)),
          Principal: principals(s.principals),
          NotPrincipal: principals(s.notPrincipals),
          Condition: conditions(s.conditions),
        }))
      : undefined,
  };
  return {
    ...inputs,
    statements: statements.length ? statements : undefined,
    json: escapeHtml(JSON.stringify(doc, null, 2)),
    minifiedJson: escapeHtml(JSON.stringify(doc)),
  };
}

// An object with its keys in order, as Go writes a map
function sorted<T>(object: Record<string, T>) {
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, object[key]]),
  );
}

// A resource's inputs as the program gave them. A state holds them after the
// provider checked them, with what it filled in: the defaults it lists in
// `__defaults`, the tags it puts on every resource (`tagsAll`), and, in the
// AWS provider since 7, the region of the provider the resource is created
// with.
function asGiven(inputs: Record<string, any>, region: string | undefined) {
  const withoutDefaults = (value: any): any => {
    if (Array.isArray(value)) return value.map(withoutDefaults);
    if (!value || typeof value !== "object" || SIG in value) return value;
    const defaults: string[] = value.__defaults ?? [];
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "__defaults" && !defaults.includes(key))
        .map(([key, v]) => [key, withoutDefaults(v)]),
    );
  };
  const { tagsAll, ...rest } = withoutDefaults(inputs);
  if (region !== undefined && rest.region === region) delete rest.region;
  return rest;
}

/**
 * The resources of a stage's state as the mock records them, to check what's
 * registered now against with `takeover()`: what was really deployed, in
 * place of a graph the mock made.
 *
 * A state doesn't hold everything a registration does: whether a resource is
 * deleted before it's replaced, or what its function was built from. Those
 * aren't compared with it.
 */
export function stateGraph(state: StateExport): RecordedResource[] {
  const resources = (state.checkpoint.latest?.resources ?? []).filter(
    (r) => !r.delete && r.type !== "pulumi:pulumi:Stack",
  );
  // The region of each provider, by how a resource refers to it
  const regions = new Map(
    resources
      .filter((r) => r.type.startsWith("pulumi:providers:"))
      .map((r) => [`${r.urn}::${r.id}`, r.inputs?.region as string]),
  );
  return resources.map((r) => ({
    kind: r.external ? "read" : "register",
    type: r.type,
    name: r.urn.substring(r.urn.lastIndexOf("::") + 2),
    parent: asMockAddress(r.parent),
    custom: r.custom,
    inputs: asGiven(r.inputs ?? {}, regions.get(r.provider ?? "")),
    options: compact({
      protect: r.protect,
      retainOnDelete: r.retainOnDelete,
      ignoreChanges: r.ignoreChanges,
      replaceOnChanges: r.replaceOnChanges,
      additionalSecretOutputs: r.additionalSecretOutputs,
      provider: asMockProvider(r.provider),
      dependencies: (r.dependencies ?? []).map(asMockAddress).sort(),
      ...(r.external ? { id: r.id } : {}),
    }),
    ...(r.custom ? {} : { outputs: r.outputs ?? {} }),
    fromState: true,
  }));
}

/**
 * Answers for what a program registers, from a stage's state: a resource at
 * an address the state has comes back with the id and outputs deployed there,
 * as the engine reads them from the state.
 */
export function replayer(state: StateExport) {
  const byAddress = new Map(
    (state.checkpoint.latest?.resources ?? [])
      .filter((r) => !r.delete && r.custom)
      .map((r) => [asMockAddress(r.urn), r] as const),
  );
  // The region of each AWS provider, by how a resource refers to it, and of
  // the one the engine makes
  const providers = (state.checkpoint.latest?.resources ?? []).filter(
    (r) => r.type === "pulumi:providers:aws",
  );
  const regions = new Map(
    providers.map((r) => [
      asMockProvider(`${r.urn}::${r.id}`) ?? "",
      r.inputs?.region as string,
    ]),
  );
  return {
    /** The region a lookup made with a provider is in. */
    region(provider: string | undefined) {
      return regions.get(provider ? provider : "");
    },
    /**
     * The id and outputs of what a resource takes the place of, by every
     * address it answers to: its own and its aliases.
     */
    find(addresses: Iterable<string>) {
      for (const address of addresses) {
        const r = byAddress.get(address);
        if (r) return { id: r.id ?? "", outputs: asWire(r.outputs ?? {}) };
      }
      return undefined;
    },
  };
}

function compact(options: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(options).filter(([, v]) =>
      Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false,
    ),
  );
}
