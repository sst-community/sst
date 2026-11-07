# Managed policies for linked resources

A role's inline policies share IAM's 10,240-character limit, and a function that links many resources can go over it. `linkPermissions.managed` moves the grants of the resources you choose into named customer-managed policies attached to the function's role. Each group becomes one policy of up to 6,144 characters. Other linked grants stay inline, and `Resource` works the same for every link.

```ts
new sst.aws.Function("MyFunction", {
  handler: "index.handler",
  link: [uploads, files, jobs],
  linkPermissions: {
    managed: { Storage: [uploads, files], Jobs: [jobs] },
  },
});
```

Deploy and call the URL. The handler lists both buckets and sends a message to the queue, so it returns `ok` only if both groups' policies are attached.

```sh
npx sst deploy
aws iam list-attached-role-policies --role-name <role>
```

## Switching an existing function

To keep its permissions throughout, switch in two deploys:

- **To opt in:** add `linkPermissions` with `retainInline: true` and deploy. Then remove `retainInline` and deploy.
- **To opt out:** set `retainInline: true` and deploy. Then remove `linkPermissions` and deploy.

Do the same when moving resources between groups.

If no grants are left inline, SST doesn't set an inline policy, as for a function without permissions. So after opting in, the inline policy from before stays on the role, with the same grants as the managed policies, until a grant is inline again.
