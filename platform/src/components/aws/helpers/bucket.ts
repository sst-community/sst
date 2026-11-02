import type { Bucket as OriginalBucket } from "../bucket";
import type { Bucket } from "../v5/bucket";

/**
 * A `Bucket` component: the 4.x one or the V5 one. Each gives the bucket in
 * `nodes.bucket`.
 */
export type AnyBucket = OriginalBucket | Bucket;
