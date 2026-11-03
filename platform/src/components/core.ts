// What SST's components share, without the components for each provider.
// Nothing here loads a provider, so a file that imports `sst/components`
// loads only the providers of the groups it imports too, like
// `sst/components/aws`. The `sst` global is this and every group (index.ts).

export * from "./secret";
export * from "./linkable";
export { takeover, type Takeover, type OldAddress } from "./takeover";
export { Component, type NamingRule, type Transform } from "./component";
export { runtime, type Runtime, type RuntimeSettings } from "./runtime";
export type { Target } from "./target";
export {
  check,
  unknown,
  type Check,
  type Finding,
  type Found,
  type CheckedComponent,
  type CheckedResource,
  type CheckedInvoke,
} from "./check";
export {
  context,
  type Context,
  type Report,
  type FunctionReport,
  type DevReport,
  type TaskReport,
  type TunnelReport,
} from "./contract";
export {
  component,
  type ComponentClass,
  deferred,
  many,
  named,
  optional,
  type ComponentArgs,
  type DeferredPart,
  type Existing,
  type LinkDefinition,
  type ManyPart,
  type ManyTransform,
  type NamedPart,
  type Nodes,
  type OptionalPart,
  type PartTransform,
  type PartialArgs,
  type Parts,
  type Transforms,
} from "./parts-component";
/**
 * experimental packages, you may be fired for using
 */
export * as x from "./experimental/index";
