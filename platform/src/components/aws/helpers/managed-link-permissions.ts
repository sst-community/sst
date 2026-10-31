import { iam } from "@pulumi/aws";
import { all, ComponentResourceOptions, Input, output } from "@pulumi/pulumi";
import { Link } from "../../link";
import { VisibleError } from "../../error";
import type { Permission } from "../permission";
import type { FunctionArgs } from "../function";

export function selectManagedLinks(
  links: any[],
  groups: Record<string, any[]>,
) {
  const selected = new Set<any>();
  const permissions: Record<string, Permission[]> = {};
  for (const [name, members] of Object.entries(groups)) {
    permissions[name] = [];
    for (const member of members) {
      // Structural Linkables are cloned when Pulumi unwraps each input. URNs identify
      // those copies; always derive the grants from the actual linked definition.
      const original = links.find(
        (link) =>
          link === member ||
          (typeof member?.urn === "string" && link?.urn === member.urn),
      );
      if (!original || !Link.isLinkable(original))
        throw new VisibleError(
          `Managed permission group "${name}" must contain resources from this function's "link" array.`,
        );
      if (selected.has(original))
        throw new VisibleError(
          `A linked resource appears in managed permission groups more than once ("${name}").`,
        );
      selected.add(original);
      permissions[name].push(
        ...((original.getSSTLink().include ?? []).filter(
          (item) => item.type === "aws.permission",
        ) as Permission[]),
      );
    }
    if (!permissions[name].length)
      throw new VisibleError(
        `Managed permission group "${name}" has no AWS permissions. Keep property-only links outside managed groups.`,
      );
  }
  return {
    permissions,
    remaining: links.filter((link) => !selected.has(link)),
  };
}

export function managedPolicyDocument(name: string, json: string) {
  const document = JSON.stringify(JSON.parse(json));
  if (document.length > 6144)
    throw new VisibleError(
      `Managed permission group "${name}" uses ${document.length} characters; IAM allows 6,144 per policy. Split this group into smaller named groups or reduce its grants.`,
    );
  return document;
}

export function managedPolicyAttachments(name: string, arns: string[]) {
  const unique = [...new Set(arns)];
  if (unique.length > 25)
    throw new VisibleError(
      `Function "${name}" needs ${unique.length} managed policy attachments, exceeding IAM's maximum of 25 per role. Combine smaller permission groups or reduce attached policies.`,
    );
  return unique;
}

export function createManagedLinkPermissions(
  name: string,
  links: Input<any[]> | undefined,
  config: NonNullable<FunctionArgs["linkPermissions"]>,
  opts: ComponentResourceOptions,
) {
  const names = Object.keys(config.managed).sort();
  if (!names.length)
    throw new VisibleError(
      "Managed link permissions require at least one named group.",
    );
  for (const group of names) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(group))
      throw new VisibleError(
        `Managed permission group "${group}" must start with a letter and contain only letters and numbers.`,
      );
  }
  const selection = all([output(links ?? []), output(config.managed)]).apply(
    ([links, groups]) => selectManagedLinks(links, groups),
  );
  return {
    // An exact duplicate avoids the provider's unsafe empty-inline-policy transition.
    fallback: selection.apply(({ permissions }) =>
      names.length ? permissions[names[0]].slice(0, 1) : [],
    ),
    inline: config.retainInline
      ? Link.getInclude<Permission>("aws.permission", links)
      : selection.apply(({ remaining }) =>
          Link.getInclude<Permission>("aws.permission", remaining),
        ),
    // Names, not resolved document sizes, determine resource identity during preview.
    policies: names.map((group) => {
      const policy = selection.apply(({ permissions }) =>
        iam.getPolicyDocumentOutput(
          {
            statements: permissions[group].map((item) => ({
              effect: output(item.effect ?? "allow").apply(
                (effect) => effect.charAt(0).toUpperCase() + effect.slice(1),
              ),
              actions: item.actions,
              resources: item.resources,
              conditions: item.conditions,
            })),
          },
          opts,
        ),
      );
      return new iam.Policy(
        `${name}Link${group}Policy`,
        {
          policy: policy.json.apply((json) =>
            managedPolicyDocument(group, json),
          ),
        },
        opts,
      );
    }),
  };
}
