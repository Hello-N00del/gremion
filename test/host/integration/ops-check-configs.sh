#!/usr/bin/env bash
# Check the ops configs with the same binaries that will run them, taken from
# the digest-pinned images, at the same paths the running containers mount.
# Not part of the bats unit run: it needs Docker.
#
# usage: OPS_RENDERED_AM=<root>/runtime/ops/alertmanager.yml \
#            test/host/integration/ops-check-configs.sh
#
# The rendered root is derived from OPS_RENDERED_AM, because prometheus.yml
# names /etc/prometheus/targets/*.yml and /etc/prometheus/stalwart-api-key
# absolutely: promtool refuses a config whose credentials file is absent, and
# checking the static half alone would pass on a host where render-ops.sh has
# never run.
#
# exit 0 all five checks pass · 1 a check failed · 2 precondition missing
set -euo pipefail

# Git Bash rewrites any argument that looks like a POSIX path before it reaches
# docker.exe, which turns "-w /etc/prometheus" into a Windows directory.
# Harmless and unset on the Debian host; required on a Windows workstation.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPS_DIR="$REPO_ROOT/infra/host/ops"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

[[ -n "${OPS_RENDERED_AM:-}" && -f "$OPS_RENDERED_AM" ]] \
    || { echo "set OPS_RENDERED_AM to a rendered alertmanager.yml" >&2; exit 2; }
AM_DIR="$(cd "$(dirname "$OPS_RENDERED_AM")" && pwd)"
RENDERED_ROOT="$(cd "$AM_DIR/../.." && pwd)"
TARGETS_DIR="$AM_DIR/targets"
STALWART_KEY="$RENDERED_ROOT/etc/secrets/ops/stalwart-api-key"
for f in "$TARGETS_DIR" "$STALWART_KEY"; do
    [[ -e "$f" ]] || {
        echo "missing rendered artefact: $f" >&2
        echo "run: infra/host/ops/render-ops.sh --env-file <root>/etc/env/ops.env" >&2
        exit 2
    }
done

# A && B || C would run `pwd` in the ORIGINAL directory when the cd fails, and
# hand docker a mount source that exists but is the wrong tree.
winpath() (
    cd "$1" || { echo "no such directory: $1" >&2; exit 2; }
    pwd -W 2>/dev/null || pwd
)

prom_image="$(awk '/image: prom\/prometheus/ {print $2}' "$OPS_DIR/docker-compose.yml")"
am_image="$(awk '/image: prom\/alertmanager/ {print $2}' "$OPS_DIR/docker-compose.yml")"
bb_image="$(awk '/image: prom\/blackbox-exporter/ {print $2}' "$OPS_DIR/docker-compose.yml")"
[[ "$prom_image" == *"@sha256:"* ]] || { echo "prometheus image is not digest-pinned" >&2; exit 2; }

# One directory assembled to look exactly like the container's /etc/prometheus:
# the static configs from the repo plus the rendered targets and credential.
# Three separate read-only mounts cannot express this — docker cannot create
# /etc/prometheus/targets inside an already read-only mount.
CHECK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$CHECK_DIR"; }
trap cleanup EXIT
cp "$OPS_DIR/prometheus.yml" "$OPS_DIR/alerts.yml" "$OPS_DIR/alerts.test.yml" "$CHECK_DIR/"
cp -r "$TARGETS_DIR" "$CHECK_DIR/targets"
cp "$STALWART_KEY" "$CHECK_DIR/stalwart-api-key"

check_host_dir="$(winpath "$CHECK_DIR")"
ops_host_dir="$(winpath "$OPS_DIR")"
am_host_dir="$(winpath "$AM_DIR")"

# Mounted at the path the running container uses, not at a neutral /work: a
# check run anywhere else fails on absolute paths that are correct in
# production, and would pass on ones that are not.
mount_prom=(-v "${check_host_dir}:/etc/prometheus:ro" -w /etc/prometheus)
mount_bb=(-v "${ops_host_dir}:/work:ro" -w /work)

echo "== promtool check config =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" check config prometheus.yml

echo "== promtool check rules =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" check rules alerts.yml

echo "== promtool test rules (healthy + blind) =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" test rules alerts.test.yml

echo "== amtool check-config (rendered) =="
docker run --rm --entrypoint amtool \
    -v "${am_host_dir}:/am:ro" \
    "$am_image" check-config "/am/$(basename "$OPS_RENDERED_AM")"

echo "== blackbox config parse =="
docker run --rm "${mount_bb[@]}" "$bb_image" --config.file=/work/blackbox.yml --config.check

echo "OPS-CHECK: config=ok rules=ok ruletests=ok alertmanager=ok blackbox=ok"
