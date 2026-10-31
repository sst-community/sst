#!/usr/bin/env bash
# Isolated integration runner. Retains its own resources unless CI=true --cleanup.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cli=${SST_TEST_CLI:-/tmp/sst-floci-dev}
cleanup=false
if [[ ${1:-} == --cleanup ]]; then
  [[ ${CI:-} == true ]] || { echo '--cleanup is restricted to CI=true' >&2; exit 1; }
  cleanup=true
elif [[ $# -gt 0 ]]; then
  echo 'Usage: SST_TEST_CLI=/path/to/linux/sst integration.sh [--cleanup]' >&2
  exit 1
fi
[[ -f "$cli" ]] || { echo "Build the Linux CLI first: $cli" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/sst-floci-integration.XXXXXX")
name="sst-floci-ci-$(date +%s)-$$"
image="$name-runner"
floci_image='floci/floci@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9'
finish() {
  result=$?
  docker logs "$name" > "$work/floci.log" 2>&1 || true
  if $cleanup; then
    # Only names allocated by this invocation; never sst-floci or spike instances.
    owned=$(docker ps -aq --filter "network=$name")
    if [[ -n "$owned" ]]; then docker rm -f $owned >/dev/null 2>&1 || true; fi
    docker rm -f "$name-tests" "$name-recovery" "$name" >/dev/null 2>&1 || true
    volumes=$(docker volume ls -q --filter "label=io.floci.owner=$name/4566")
    if [[ -n "$volumes" ]]; then docker volume rm $volumes >/dev/null 2>&1 || true; fi
    docker network rm "$name" >/dev/null 2>&1 || true
    docker image rm "$image" >/dev/null 2>&1 || true
  fi
  echo "Floci integration artifacts: $work"
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "artifacts=$work" >> "$GITHUB_OUTPUT"; fi
  exit "$result"
}
trap finish EXIT
cp "$repo/scripts/floci/integration.mjs" "$work/integration.mjs"
mkdir "$work/app"
cp "$repo/examples/aws-floci/"*.ts "$repo/examples/aws-floci/package.json" "$work/app/"
cat > "$work/Dockerfile" <<'DOCKERFILE'
FROM node:24.5.0-bookworm
RUN npm install --global bun@1.4.2
ENV SST_BUN_PATH=/usr/local/bin/bun SST_SKIP_LOCAL=true SST_TELEMETRY_DISABLED=true XDG_CONFIG_HOME=/work/config PULUMI_HOME=/work/config/sst
WORKDIR /work
DOCKERFILE
# All downloads happen before creating the network with no external route.
docker build --load --platform linux/amd64 --tag "$image" "$work"
for dependency in "$floci_image" public.ecr.aws/lambda/provided:al2023 public.ecr.aws/lambda/nodejs:22 registry:2; do
  docker pull --platform linux/amd64 "$dependency"
done
docker run --platform linux/amd64 --rm --volume "$work:/work" --volume "$repo:/repo:ro" \
  --volume "$cli:/usr/local/bin/sst:ro" "$image" node /work/integration.mjs prepare
docker network create --internal "$name"
docker volume create --label "io.floci.owner=$name/4566" "$name-data"
gateway=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$name")
floci_ip="${gateway%.*}.10"
docker run --platform linux/amd64 --detach --name "$name" --network "$name" --ip "$floci_ip" \
  --network-alias localhost.floci.io \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$name-data:/app/data" \
  --env FLOCI_STORAGE_MODE=persistent \
  --env "FLOCI_DOCKER_RESOURCE_NAMESPACE=$name" \
  --env "FLOCI_SERVICES_LAMBDA_CONTAINER_NAME_PREFIX=$name" \
  --env FLOCI_BASE_URL=http://localhost.floci.io:4566 \
  --env "FLOCI_SERVICES_DOCKER_NETWORK=$name" \
  --env "FLOCI_SERVICES_ECR_REGISTRY_CONTAINER_NAME=$name-ecr" \
  --env "FLOCI_SERVICES_ECR_DOCKER_NETWORK=$name" \
  --env "FLOCI_SERVICES_LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:$floci_ip" \
  --env FLOCI_SERVICES_LAMBDA_DOCKER_HOST_OVERRIDE=localhost.floci.io \
  "$floci_image"
# Sharing Floci's namespace gives the CLI an allowed loopback endpoint and lets
# Lambda reach its local bridge through the explicit host mapping above.
docker run --platform linux/amd64 --name "$name-tests" --network "container:$name" \
  --volume "$work:/work" --volume "$repo:/repo:ro" \
  --volume "$cli:/usr/local/bin/sst:ro" \
  --env SST_FLOCI_ENDPOINT=http://127.0.0.1:4566 \
  --env SST_SKIP_DEPENDENCY_CHECK=true \
  "$image" node /work/integration.mjs verify

# Restart the actual emulator while preserving its owned data volume. A new
# runner joins its new network namespace; no existing native instance is touched.
docker restart "$name"
docker run --platform linux/amd64 --name "$name-recovery" --network "container:$name" \
  --volume "$work:/work" --volume "$repo:/repo:ro" \
  --volume "$cli:/usr/local/bin/sst:ro" \
  --env SST_FLOCI_ENDPOINT=http://127.0.0.1:4566 \
  --env SST_SKIP_DEPENDENCY_CHECK=true \
  "$image" node /work/integration.mjs verify-restart
