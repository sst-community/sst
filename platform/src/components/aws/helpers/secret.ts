import type { Output, Resource } from "@pulumi/pulumi";
import { secretsmanager } from "@pulumi/aws";
import type { Input } from "../../input";
import { VisibleError } from "../../error";

// How a database or a cache that's already deployed is connected to: SST tags
// what it creates with the secret that holds its password, so a component
// given the resource alone finds it again.

/**
 * The value of one of a resource's tags, like the id of the secret that holds
 * its password.
 *
 * @param notFound The error for a resource that doesn't have the tag.
 */
export function tagOf(
  resource: { tagsAll: Output<Record<string, string>> },
  tag: string,
  notFound: string,
): Output<string> {
  return resource.tagsAll.apply((tags) => {
    if (!tags?.[tag]) throw new VisibleError(notFound);
    return tags[tag];
  });
}

/**
 * A field of the JSON a secret holds, like a database's password.
 *
 * @param parent The component that's reading it.
 */
export function secretField(
  secretId: Input<string>,
  field: string,
  parent: Resource,
): Output<string> {
  return secretsmanager
    .getSecretVersionOutput({ secretId }, { parent })
    .secretString.apply((v) => JSON.parse(v)[field] as string);
}
