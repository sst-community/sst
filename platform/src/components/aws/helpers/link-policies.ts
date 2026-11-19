import { VisibleError } from "../../error";
import { Link } from "../../link";
import type { Permission } from "../permission";

/**
 * What `linkPermissions.managed` takes out of a function's links: the grants
 * of each group, and the links in no group, whose grants stay inline.
 *
 * @param links The function's `link`.
 * @param groups `linkPermissions.managed`, resolved.
 * @param owner The function, as `the "MyFunction" function`.
 */
export function linkGroups(
  links: any[],
  groups: Record<string, any[]>,
  owner: string,
) {
  const grouped = new Set<any>();
  const permissions: Record<string, Permission[]> = {};
  for (const [group, members] of Object.entries(groups)) {
    permissions[group] = [];
    for (const member of members) {
      // A linkable that's a plain object is copied as Pulumi resolves each
      // input, so it's found again by its URN. The grants are always read
      // from what's in `link`.
      const linked = links.find(
        (link) =>
          link === member ||
          (typeof member?.urn === "string" && link?.urn === member.urn),
      );
      if (!linked || !Link.isLinkable(linked))
        throw new VisibleError(
          `The "${group}" group in the "linkPermissions.managed" of ${owner} has something that isn't in its "link". Put the resources it links in a group.`,
        );
      if (grouped.has(linked))
        throw new VisibleError(
          `A resource is in more than one group in the "linkPermissions.managed" of ${owner}, the last in "${group}". Put each in one group.`,
        );
      grouped.add(linked);
      permissions[group].push(
        ...((linked.getSSTLink().include ?? []).filter(
          (item) => item.type === "aws.permission",
        ) as Permission[]),
      );
    }
    if (!permissions[group].length)
      throw new VisibleError(
        `The "${group}" group in the "linkPermissions.managed" of ${owner} grants nothing. Leave what a function only reads the properties of out of the groups.`,
      );
  }
  return {
    permissions,
    ungrouped: links.filter((link) => !grouped.has(link)),
  };
}

/**
 * The names of the groups in `linkPermissions.managed`, checked, in the order
 * their policies are created.
 *
 * @param groups `linkPermissions.managed`.
 * @param owner The function, as `the "MyFunction" function`.
 */
export function linkGroupNames(groups: object, owner: string) {
  const names = Object.keys(groups).sort();
  if (!names.length)
    throw new VisibleError(
      `The "linkPermissions.managed" of ${owner} has no groups. Name at least one, or leave "linkPermissions" out.`,
    );
  for (const name of names)
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name))
      throw new VisibleError(
        `The "${name}" group in the "linkPermissions.managed" of ${owner} needs a name that starts with a letter and has only letters and numbers.`,
      );
  return names;
}

/**
 * A group's policy document, checked against IAM's limit for a managed
 * policy. Its ARNs may only be known once the deploy runs, so it's checked
 * then.
 *
 * @param group The group's name.
 * @param json The document.
 * @param owner The function, as `the "MyFunction" function`.
 */
export function linkPolicyDocument(group: string, json: string, owner: string) {
  const document = JSON.stringify(JSON.parse(json));
  if (document.length > 6144)
    throw new VisibleError(
      `The "${group}" group in the "linkPermissions.managed" of ${owner} grants ${document.length} characters, and IAM takes 6,144 in a managed policy. Split it into smaller groups.`,
    );
  return document;
}

/**
 * The managed policies a role is given, each once, checked against IAM's
 * most for a role.
 *
 * @param arns The policies' ARNs.
 * @param owner The function, as `the "MyFunction" function`.
 */
export function linkPolicyAttachments(arns: string[], owner: string) {
  const unique = [...new Set(arns)];
  if (unique.length > 25)
    throw new VisibleError(
      `The role of ${owner} would have ${unique.length} managed policies, and IAM takes 25 at most. Put the links in fewer groups, or give it fewer "policies".`,
    );
  return unique;
}
