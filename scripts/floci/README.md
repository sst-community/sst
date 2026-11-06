# Floci compatibility spike

This directory preserves the initial compatibility spike for #172. The production dev backend is now implemented separately; see the [Floci guide](../../www/src/content/docs/docs/floci.mdx) for `sst dev --floci` and `sst floci`. The results below describe the original spike, not the full backend verification.

The spike uses Floci **2.3.0**, pinned to Docker manifest digest `sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9`, and the AWS provider version in `platform/package.json` (**7.48.0** when tested).

## Run

Requirements: Docker, repository dependencies (`bun install`), Go, Node with `--use-env-proxy` support (tested with Node 26.7.0), and the repository's Pulumi CLI (3.267.0 when tested). The runner finds Pulumi in SST's config directory; set `SST_PULUMI_ROOT` to a directory containing `bin/pulumi` to use another installation. This overrides only the CLI binary: provider plugins must already be installed in SST's config directory (`~/Library/Application Support/sst` on macOS, `$XDG_CONFIG_HOME/sst` or `~/.config/sst` on Linux). The dead proxy intentionally prevents downloading plugins during the test.

From the repository root:

```sh
docker compose -f scripts/floci/compose.yaml up -d floci
curl --fail http://127.0.0.1:4566/_floci/init
SST_FLOCI_SPIKE=1 go test ./pkg/project/provider -run TestFloci -count=1 -v
node scripts/floci/spike.mjs
docker compose -f scripts/floci/compose.yaml run egress
```

Wait for `completed.ready: true` before running the tests. The Go bootstrap probe is intentionally restricted to `http://127.0.0.1:4566`. For the Pulumi/Compose probes, `FLOCI_SPIKE_PORT` changes both the published and container port; use the same value for both commands. State and results are under `.sst/floci-spike-<port>/`, isolated from SST stage state. Repeating the test changes the revision back to `one`, verifies stability, then updates it to `two` again.

The host HTTP callback listens on port 13579 while the test runs so Lambda containers can reach it. It is a connectivity probe, not the production SST bridge protocol. The test leaves the container, volume, resources and local state for inspection. `stop` preserves data. Only when deliberately cleaning up, run `node scripts/floci/spike.mjs destroy` for Pulumi resources; the bootstrap resources and Docker volume are separate and retained. No cleanup is automatic.

## Results (2026-10-30)

Verified on macOS arm64 with Docker 29.8.0:

- Existing SST Go bootstrap: S3 asset/state buckets, notifications, state bucket versioning, ECR repository, SSM persistence and reload through a new provider instance.
- HTTP `PutObject` succeeds after bootstrap installs the `aws:SecureTransport` deny policy, with Floci's default authentication settings. This does not establish behavior with stricter Floci auth settings.
- Pulumi creates an S3 bucket, DynamoDB table, SQS queue, IAM role/inline policy, Node.js Lambda, function URL/permission and SQS event source mapping.
- Second `up`: **11 unchanged**. Refresh followed by preview: **11 unchanged**.
- Update: tags on the bucket/table/queue and Lambda environment update successfully.
- Real Lambda execution reads `hello from S3` and `hello from Dynamo`, reports the updated revision, and reaches the host HTTP callback. The public function URL returns HTTP 200.
- Sending an SQS message invokes the subscriber and delivers its body to the host callback.
- Restarting the persistent Floci container preserves resources; the subsequent Pulumi run succeeds.
- Node's HTTPS proxy probe fails with `ECONNREFUSED`; Bun's standalone proxy probe also fails with `ConnectionRefused`. A Node process on an internal Docker network can reach Floci but cannot reach AWS STS over HTTPS.
- Repository platform build, CLI build, typecheck, CLI test suite and **291 platform tests** passed. Provider-config regression was observed failing before the fix, including a large number that would otherwise use scientific notation.

## Findings that change the draft

1. Readiness is `completed.ready`, not a top-level `ready`.
2. `FLOCI_BASE_URL=http://host.docker.internal:4566` produces function URLs ending in `.host.docker.internal`, which do not resolve on this host. Use `localhost.floci.io` for returned service URLs and give the Floci container that network alias. Reserve `host.docker.internal` for Lambda-to-host callbacks.
3. A mounted data volume alone does not persist service state: Floci defaults to memory storage. Set `FLOCI_STORAGE_MODE=persistent`.
4. Floci's Lambda Docker-flag parser accepts `--add-host host.docker.internal:host-gateway`, but rejects `--add-host=host.docker.internal:host-gateway`.
5. With multiple Docker networks, explicitly set the Lambda runtime API host override to the shared Floci hostname. Automatic network selection can choose an address outside the Lambda's network.
6. Node's proxy configuration must be applied at process startup. The spike relaunches with `--use-env-proxy` after scrubbing inherited AWS and proxy environment variables.

Configuration references: [Floci 2.3.0 Compose](https://github.com/floci-io/floci/blob/2.3.0/docker-compose.yml), [environment variables](https://github.com/floci-io/floci/blob/2.3.0/docs/configuration/environment-variables.md).

## Follow-on work identified by the original spike

- Production transport interface and actual SST bridge stream/resend tests. The HTTP callback proves connectivity only.
- SST components (rather than only raw Pulumi resources), component options, regional providers, custom resources and invokes; versioned compatibility profile and preview enforcement.
- Floci credential/endpoint configuration in every production Go/JS client; child-environment scrubbing; explicit dev-only flag and command rejection.
- Instance UUID, stage-state separation, reset/recovery and simultaneous-instance lifecycle tests. The two manually started instances in this session do not establish these guarantees.
- Full Pulumi/SST run in an egress-denied container, including negative unsupported-resource tests. The internal-network probe is deliberately narrower. Proxies do not sandbox arbitrary user code.
- Automated CRUD delete checks (not run because resources were requested to be retained), Linux testing, strict-auth policy checks, and cloud deployment regression testing. No real AWS deployment was performed.
- `sst floci` install/start/stop/status/reset commands, auto-start, documentation and CI integration. No supported compatibility matrix should be published from this spike alone.

During this session the initial exploratory container remains at port 4566 (`sst-floci-spike`, memory mode). The corrected persistent instance remains at port 4567 (`sst-floci-spike-verified`); its successful result is `.sst/floci-spike-4567/result.json`. These manually started containers are not owned by Compose. Use a fresh Docker environment for the Compose instructions, or explicitly reconcile the existing container names before running them. Neither instance is an SST stage.

## Full SST integration harness

`integration.sh` exercises the actual `sst dev --floci` command. It prepares
Node, Bun, Pulumi, plugins, app dependencies, and Docker runtime images online,
then puts Floci, the CLI, and Lambda containers on a Docker internal network.
The CLI shares Floci's network namespace, so its endpoint stays loopback. No
Floci API port is published; the ECR sidecar publishes its loopback registry port.
Existing spike or managed instances are untouched.

Build the platform and SDK first, then a Linux amd64 CLI:

```sh
bun run build:platform
bun run build:sdk
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/sst-floci-dev ./cmd/sst
SST_TEST_CLI=/tmp/sst-floci-dev scripts/floci/integration.sh
```

The harness checks external HTTPS denial; rejects unsupported components,
options, raw resources, and invokes without creating bootstrap or first-set
resources; rejects `deploy`, `diff`, and `refresh`; invokes the real live
function URL; verifies S3 and DynamoDB writes plus the SQS subscriber; and
changes API and subscriber source to verify live reload. It also checks syntax-error
correction, recovery from a killed update with an explicitly local unlock, and a real
Docker restart with persisted identity, resource inventory, S3 data, and DynamoDB data.
The killed-update fixture pauses config evaluation after the update lock is held;
it does not simulate a provider being killed halfway through creating a resource.
Logs and `result.json` go to the temporary
directory printed at exit. Every process and readiness wait has a deadline.

Resources are retained by default. CI uses `CI=true integration.sh --cleanup`
to remove only the uniquely named containers/network/image created by that
invocation, including its Lambda containers. It keeps logs for artifact upload.
`--cleanup` is refused outside CI. The GitHub Actions workflow is
`.github/workflows/floci.yml` and does not need AWS credentials or secrets.

## Opt-in round trip: Floci dev → AWS dev → AWS deploy → Floci dev

`roundtrip.mjs` tests the same copied `examples/aws-floci` application and stage through three sequential `sst dev` sessions and an AWS `sst deploy` between the AWS and final Floci dev sessions. **It creates real AWS resources and retains them.** Use a dedicated AWS test profile and a disposable stage. The runner will not start any test work unless all three required opt-ins are set:

```sh
# First build the local SDK, platform and CLI using the repository commands.
# Requirements: Node.js 24.5+, npm, AWS CLI v2, Docker, and an authenticated AWS test profile.
SST_TEST_AWS_PROFILE=my-test-account \
SST_TEST_STAGE=floci-roundtrip-myname \
SST_TEST_CLI=/absolute/path/to/built/sst \
node scripts/floci/roundtrip.mjs
```

To use an already running custom Floci instance, also set `SST_TEST_FLOCI_ENDPOINT=http://127.0.0.1:4567`. Otherwise `sst dev --floci` manages its normal local instance. Both targets use `us-east-1`. The AWS profile needs permissions for the example's S3, DynamoDB, SQS, Lambda, IAM and live-dev AppSync/bootstrap resources; authenticate it before running. The script does not choose or discover an AWS profile automatically.

The runner copies the app into a new temporary directory, points its `sst` dependency at this checkout's `sdk/js`, installs dependencies, and runs Floci dev → AWS dev → AWS deploy → Floci dev. It removes the previous `.sst/outputs.json` before each session, checks the function URL belongs to the expected target, invokes it, reads its S3 object and DynamoDB record, and waits for a fresh queue subscriber record. It changes the copied API handler and repeats these checks to verify Lambda live reload. It then changes the copied queue subscriber to prepend a unique marker, sends fresh invocations until that rebuilt subscriber processes a message, and verifies the transformed DynamoDB value. Each target starts with the original subscriber source, and successful results record both `hotReload` and `subscriberHotReload`. Before AWS deployment, the AWS dev process and its workers are stopped. The runner resets both handler sources, removes stale outputs, and waits for `sst deploy` to succeed. It checks Lambda configuration for an active, successfully updated Node.js runtime with no SST bridge/AppSync environment variables, then invokes the deployed function URL and verifies fresh S3, DynamoDB and SQS subscriber delivery without any dev process. The copied config adds only a function-name output for this inspection; all phases use that same config. Deploy results record `packagedFunction: true` and do not claim hot reload. Returning to Floci must preserve the instance UUID and all resource output identifiers from the first session. Cloud child processes receive only the explicitly selected AWS profile, with inherited Floci settings, direct credentials, endpoint overrides and proxy settings removed.

The printed temporary directory retains the copied app, logs for all four phases, S3 response snapshots, and `results.json`. Successful sessions are recorded as they finish. Only the spawned dev sessions and their local worker processes are stopped; neither AWS nor Floci resources are removed. Cleanup is a separate, deliberate action using the retained app and matching target/stage. Re-running creates a new inspection directory but uses the same explicitly selected stage.

The safety and environment tests run offline and do not need AWS or Docker:

```sh
node --test scripts/floci/roundtrip.test.mjs
```

These test missing opt-ins, credential/endpoint/proxy leakage across targets, stale-target URL detection, HTTP verification failures, sequential phase cleanup, failed-deploy short circuiting, missing or stale deployment outputs, and rejection of live bridge Lambda configuration. A passing offline suite does not establish that the real round trip or AWS deployment passed; run the opt-in command to produce that evidence.
