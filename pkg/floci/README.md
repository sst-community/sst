# Floci lifecycle

The managed instance uses Floci 2.3.0, pinned by manifest digest in `Image`, and
listens on `http://127.0.0.1:4566`. `sst floci` and `sst floci start` pull the
image if needed and start it. `install` pulls explicitly, `status` checks
readiness and version, and `stop` retains the named data volume.

Docker must be installed and running. The container mounts its Docker socket
for Lambda execution, uses persistent storage, and shares `localhost.floci.io`
with Lambda containers. `host.docker.internal` is reserved for host callbacks. Child containers and volumes
use the `sst-floci` resource namespace, so their Lambda and ECR resources do not
reuse another Floci instance's Docker data. SST verifies the actual published
port, not just Docker's requested binding, before accepting a managed instance.

`SST_FLOCI_ENDPOINT=http://127.0.0.1:<port>` selects an already running custom
instance. Only HTTP loopback endpoints are accepted. Custom instances must
report exactly the verified profile version. This package never starts, stops,
or wipes them. Version overrides that differ from the profile are rejected.

`sst floci reset` prompts before deleting the managed container, data volume,
and corresponding local state. `--stage` restricts **local state cleanup**;
all emulator resources are still deleted, so other stages will need recovery.
For a custom endpoint, `reset --stage <stage>` clears only local state and its
identity marker; reset the external emulator separately when needed. Stage
cleanup includes every matching app on that endpoint.

## Integration order

1. `Ensure(ctx)` starts/reuses the managed container, or checks a custom endpoint.
   It checks `/_floci/init` (`completed.ready`) and `/_floci/health` (`version`).
   It creates no AWS resources.
2. `ReadIdentity(ctx, cfg, app, stage)` reads `/sst/floci/instance` and compares
   it to the local stage marker. Missing identity on a new stage reserves a UUID and StateRoot in memory only.
   Missing/changed identity on an existing stage fails with recovery instructions.
3. Run the compatibility preflight without bootstrap or writes to the emulator.
4. `EnsureIdentity(ctx, cfg, app, stage)` persists that reserved UUID if absent and
   records the stage marker. It sets `cfg.Instance` and `cfg.StateRoot`.
5. Initialize local home at `cfg.StateRoot`, then bootstrap and run the app.

`StateRoot` is `<SST config>/floci/<instance UUID>`. Stage markers live separately
under `<SST config>/floci-stages/<endpoint hash>/`. Different endpoints and
instance identities remain isolated. Identity requests use static test
credentials, an explicit endpoint, no ambient proxy, and no HTTP redirects.

The unit tests use an HTTP server and fake Docker runner; they never alter
running containers or existing emulator resources.
