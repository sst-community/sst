# Shared Lambda handlers

This example registers 60 HTTP routes, 60 REST methods, and three WebSocket routes against one function. `addHandler` creates one API-scoped Lambda permission per API, rather than one permission per route. Reuse the returned handler; calling `addHandler` with another name creates another grant.

Run `sst deploy --stage <stage>`, then `node verify.mjs`. It checks the expected response from all 120 HTTP/REST endpoints and opens a WebSocket connection, sends a unique message, and checks the returned echo. WebSocket connect/message/disconnect invocations also log their route and connection ID.

Inspect the function's resource policy with `aws lambda get-policy --function-name <function>`. There should be three API Gateway statements. The permission remains if its routes are removed; remove the `addHandler` call when the target is no longer needed. Route order has no effect on the permission's name or owner.

For an alias or version, pass its qualified Lambda ARN. Create separate bindings for different targets or APIs. Route authentication, throttling and integrations can still be configured independently.

For existing deployments, add the shared handler and switch the routes in the same configuration change, then deploy once. To switch back, pass the function ARN to each route and remove the unused handler, then deploy once. Integration dependencies order the replacement grants before removal of the old grants.

Both policy forms must fit AWS's quota during the handover. If the policy is already full, free a redundant API-wide grant through its owning infrastructure while retaining a working grant. Do not switch back to more per-route statements than fit the policy limit.

## Reproduce migration and rollback

Use a small route count so the old per-route grants fit within the resource-policy quota:

```sh
PERMISSIONS_PHASE=legacy ROUTE_COUNT=5 sst deploy --stage <stage>
SST_STAGE=<stage> SST_BIN=<sst binary> node verify.mjs --migration
```

The script performs five deployments: consolidate, repeat, switch back to per-route grants, repeat, and consolidate again. It checks AWS statement counts and every endpoint after each deployment while continuously exercising HTTP, REST, and WebSocket connection/echo during the changes. Results go to `.sst/migration-requests.json`; resources remain deployed.

The default is `shared` with 60 routes per HTTP/REST API. Never use that count for the legacy phase, which can exceed the policy quota.
