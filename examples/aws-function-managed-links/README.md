# Managed permissions for linked resources

`Reader` links a bucket and three sets of distinct object-path grants. The grants together exceed IAM's 10,240-character aggregate inline-policy limit. `linkPermissions.managed` places them in three named managed policies while retaining every `Resource` binding. The bucket's normal SST grants allow the handler to list its contents.

```ts
link: [bucket, records, jobs],
linkPermissions: {
  managed: { Storage: [bucket, records], Jobs: [jobs] }
}
```

Each group must contain the same resource objects passed in `link`, and a resource may belong to only one group. Unselected links and explicit `permissions` stay inline. Group names give the managed policies stable identities, including previews where resource ARNs are unknown. Policies are owned per function; they are not automatically shared across roles.

When the inline policy would otherwise become empty, SST retains one exact statement from the first group inline. This deliberate duplicate is bounded by the group's 6,144-character limit and adds no permissions. It keeps a stable, nonempty inline policy even when ARNs are unknown during preview. Explicit, unselected and dev grants take precedence over this fallback.

Run `sst deploy --stage <stage>` and request the returned URLs. `Reader` lists its bucket and returns both `Resource.Files.name` and `Resource.One.bucket`. Inspect its role with `aws iam list-role-policies` and `aws iam list-attached-role-policies`.

Each group must fit a 6,144-character managed policy. Oversized groups fail with a diagnostic telling you to split them; the implementation never widens ARNs or actions to shrink a document. Choose group boundaries explicitly so unknown ARN lengths cannot change policy counts during preview. An oversized individual link can be split into multiple `Linkable` definitions with narrower include lists. IAM's attachment quota applies to generated, supplied and SST-required policies together (20 by default, adjustable up to 25). The account-wide customer-managed policy quota also applies.

The deploy role needs permission to create, read, version, tag and delete IAM managed policies and attach/detach them from roles, in addition to the existing Lambda deployment permissions. This option cannot manage an externally supplied function `role`; manage that role's policies directly.

## Switching consolidation on or off

Set `linkPermissions` and deploy once to consolidate. Remove the option and deploy once to restore inline grants. SST attaches replacement grants before reducing the inline policy, and restores inline grants before detaching managed policies. The role and function keep their existing identities. Reverting to inline is rejected if the grants exceed the 10,240-character limit.

`Migration` demonstrates this using two different buckets. Its endpoint lists both, so it detects loss of the managed grant even while the first bucket remains covered by the compatibility statement:

```sh
PERMISSIONS_PHASE=inline sst deploy --stage <stage>
SST_STAGE=<stage> SST_BIN=<sst-binary> node verify.mjs --migration
```

The script performs five direct deployments: managed, repeated managed, inline, repeated inline, and managed again. It checks actual policy contents and both endpoints, continuously requests them through the changes, records results in `.sst/migration-requests.json`, and leaves resources deployed. `node verify.mjs` checks endpoints without deploying.

`Reader` always uses managed groups; the environment variable affects only `Migration`. `sst dev --mode=basic` keeps dev bridge permissions inline while preserving managed grants and runtime links.

Switching the option works on a feature-capable SST version in both directions; downgrading the SST binary is not a migration path. SST retains ownership metadata after the option is removed so future deployments continue managing policies correctly. Use `permissions` and `policies`, rather than changing the role's policy fields through a transform. Set custom providers on the Function so its policies use the same provider.

Regrouping existing resources is different from switching consolidation off/on. Use `retainInline: true` to establish overlap before moving resources between groups, then remove it afterwards. This requires the combined inline grants to fit; otherwise plan an overlapping managed-policy migration with sufficient quota headroom.

To revoke every grant, use statically known link and permission lists (property-only links may remain). Unknown lists that resolve to no grants are rejected rather than leaving old policies unmanaged. Test resources remain deployed until you explicitly choose to remove them.

The optional `empty` phase retains only property bindings and revokes both bucket grants. After `PERMISSIONS_PHASE=empty sst deploy --stage <stage>`, run `node verify.mjs --revoked` to check that both S3 calls are denied and no linked policies remain. Deploy `PERMISSIONS_PHASE=managed` again to restore access.
