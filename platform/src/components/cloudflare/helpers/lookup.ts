import {
  CustomResource,
  type Input,
  type Output,
  all,
  output,
} from "@pulumi/pulumi";

/**
 * The id Cloudflare's provider looks a resource up by, from the id given in
 * `existing`: the resource's own id with its account in front, as the
 * provider writes it, `<account>/<id>`, and any `rest` after it, like an R2
 * bucket's jurisdiction. An id that has the account in it already keeps it,
 * and gets what it leaves out of `rest`: `<account>/<name>` is
 * `<account>/<name>/default` for a bucket.
 */
export function lookupId(
  accountId: Input<string | undefined>,
  id: Input<string>,
  ...rest: string[]
): Output<string> {
  return all([accountId, id]).apply(([accountId, id]) => {
    const given = id.split("/");
    const parts = given.length > 1 ? given : [accountId, id];
    return [...parts, ...rest.slice(parts.length - 2)].join("/");
  });
}

/**
 * Use a part given in `existing` the way it is: the resource itself, or the
 * one Cloudflare's provider looks up by the id given there, with the account
 * in front (`lookupId()`).
 *
 * `lookupPart` is the component's own, for the part. Given the resource
 * itself in `existing`, it uses that in place of a lookup, so it's called
 * with the resource's id.
 *
 * ```ts
 * const existing = args.existing?.namespace;
 * if (existing !== undefined) {
 *   useExisting(existing, accountId, (id) => this.lookupPart("namespace", id));
 *   return;
 * }
 * ```
 *
 * @param rest What Cloudflare's provider reads after the id, like an R2
 * bucket's jurisdiction, for an id that leaves it out.
 */
export function useExisting<R>(
  existing: CustomResource | Input<string>,
  accountId: Input<string | undefined>,
  lookupPart: (id: Input<string>) => R,
  ...rest: string[]
): R {
  return lookupPart(
    CustomResource.isInstance(existing)
      ? existing.id
      : lookupId(accountId, existing as Input<string>, ...rest),
  );
}

/**
 * A resource's own id, without the account a looked-up one has in front of
 * it: Cloudflare's provider gives a resource it reads the id it was read by.
 */
export function ownId(id: Input<string>): Output<string> {
  return output(id).apply((id) => (id.includes("/") ? id.split("/")[1] : id));
}
