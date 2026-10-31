# Managed permissions for linked resources

`Reader` links a bucket and three sets of distinct object-path grants. The grants together exceed IAM's 10,240-character aggregate inline-policy limit. `linkPermissions.managed` places them in three named managed policies while retaining every `Resource` binding. The bucket's normal SST grants allow the handler to list its contents.

```ts
link: [bucket, records, jobs],
linkPermissions: {
  managed: { Storage: [bucket, records], Jobs: [jobs] }
}
```

Each group must contain the same resource objects passed in `link`, and a resource may belong to only one group. Unselected links and explicit `permissions` stay inline. Group names give the managed policies stable identities, including previews where resource ARNs are unknown. Policies are owned per function; they are not automatically shared across roles.

When the inline policy would otherwise become empty, SST retains one exact statement from the first group inline. This deliberate duplicate is bounded by the group's 6,144-character limit and adds no permissions. It avoids a provider state bug that can delete restored inline grants during rollback after an empty inline policy. Explicit, unselected and dev grants take precedence over this fallback.

Run `sst deploy --stage <stage>` and request the returned URLs. `Reader` lists its bucket and returns both `Resource.Files.name` and `Resource.One.bucket`. Inspect its role with `aws iam list-role-policies` and `aws iam list-attached-role-policies`.

Each group must fit a 6,144-character managed policy. Oversized groups fail with a diagnostic telling you to split them; the implementation never widens ARNs or actions to shrink a document. Choose group boundaries explicitly so unknown ARN lengths cannot change policy counts during preview. An oversized individual link can be split into multiple `Linkable` definitions with narrower include lists. IAM's attachment quota applies to generated, supplied and SST-required policies together (20 by default, adjustable up to 25). The account-wide customer-managed policy quota also applies.

The deploy role needs permission to create, read, version, tag and delete IAM managed policies and attach/detach them from roles, in addition to the existing Lambda deployment permissions. This option cannot manage an externally supplied function `role`; manage that role's policies directly.

## Migration and rollback

`Migration` is a small function whose grants fit inline, so it can exercise the three phases:

1. `PERMISSIONS_PHASE=inline sst deploy --stage <stage>`: the existing inline behavior.
2. `PERMISSIONS_PHASE=both sst deploy --stage <stage>`: set `retainInline: true` to attach managed policies without removing inline grants.
3. `PERMISSIONS_PHASE=managed sst deploy --stage <stage>`: remove the redundant inline grants, except for the single compatibility statement when needed.

Request `migrationUrl` after each phase. For rollback, go from `managed` to `both`, then `inline`. Restore inline grants before removing policies and ensure they fit the inline quota. To rename or reorganize managed groups, first restore inline grants, deploy the new groups, then remove inline grants again. For a role whose grants no longer fit inline, plan a separate overlapping migration rather than dropping an attached policy in one step.

`Reader` always uses managed groups; the environment variable affects only `Migration`. `sst dev --mode=basic` keeps live-dev bridge permissions inline while preserving the managed grants and runtime links. Retain test resources until you explicitly choose to remove them.

To verify actual responses, run `node verify.mjs`. To run the migration/rollback regression, first deploy the `inline` phase, then run `SST_STAGE=<stage> SST_BIN=<sst binary> node verify.mjs --migration`. It checks both URLs, policy attachments and continuous requests across eight deployments, records results in `.sst/migration-requests.json`, and leaves the resources deployed.

The default role's existing behavior when every permission is removed is unchanged. Disabling this option and removing every link is not a supported complete-revocation procedure: an empty inline-policy list can relinquish management rather than delete an existing policy. Use explicit role management for that case and verify the resulting AWS policies. Managed groups must be nonempty.
