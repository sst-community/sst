export * as aws from "./aws/index.js";
export * as cloudflare from "./cloudflare/index.js";
export * as vercel from "./vercel/index.js";
export * from "./secret.js";
export * from "./linkable.js";
export { takeover, type Takeover, type OldAddress } from "./takeover.js";
export { Component, type NamingRule, type Transform } from "./component.js";
export {
  component,
  deferred,
  many,
  optional,
  type ComponentArgs,
  type V5Args,
  type Existing,
  type LinkDefinition,
  type ManyTransform,
  type Nodes,
  type Parts,
  type Transforms,
} from "./parts-component.js";
/**
 * experimental packages, you may be fired for using
 */
export * as x from "./experimental/index.js";

import { Link } from "./link.js";

/**
 * @deprecated
 * Use sst.Linkable.wrap instead.
 */
export const linkable = Link.linkable;
