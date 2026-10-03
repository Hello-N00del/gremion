#!/usr/bin/env bash
# Check the ops project's configs (compose/observability, TASK-039) with the
# same binaries that will run them, taken from the digest-pinned images, at the
# paths the running containers mount. Not part of the bats unit run: it needs
# Docker.
#
# usage: [OPS_ROOT=<rendered root>] [OPS_CHECK_DIR=<scratch dir>] \
#            test/host/integration/ops-check-configs.sh
#
# prometheus.yml names /etc/prometheus/targets/*.yml and the Stalwart
# credential absolutely, and promtool refuses a config whose credentials file
# is absent. With OPS_ROOT, the check reads a root render-ops.sh has written
# (the host's own state); without it, it renders a throwaway root first, from
# fixed placeholder values, into OPS_CHECK_DIR (default: a mktemp directory).
#
# exit 0 every check passes · 1 a check failed · 2 precondition missing
set -euo pipefail

# Git Bash rewrites any argument that looks like a POSIX path before it reaches
# docker.exe, which turns "-w /etc/prometheus" into a Windows directory.
# Harmless and unset on the Debian host; required on a Windows workstation.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OBS_DIR="$REPO_ROOT/compose/observability"
COMPOSE="$OBS_DIR/docker-compose.yml"

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

CHECK_DIR="${OPS_CHECK_DIR:-$(mktemp -d)}"
mkdir -p "$CHECK_DIR"
own_dir=0; [[ -z "${OPS_CHECK_DIR:-}" ]] && own_dir=1
cleanup() { (( own_dir )) && rm -rf "$CHECK_DIR"; return 0; }
trap cleanup EXIT

# A && B || C would run `pwd` in the ORIGINAL directory when the cd fails, and
# hand docker a mount source that exists but is the wrong tree.
winpath() (
    cd "$1" || { echo "no such directory: $1" >&2; exit 2; }
    pwd -W 2>/dev/null || pwd
)

image_of() {   # <service> -- the pinned image of a compose service
    awk -v s="  $1:" '$0 == s {f=1; next} f && /^  [a-z]/ {f=0} f && /^[[:space:]]+image:/ {print $2; exit}' "$COMPOSE"
}

ROOT_DIR="${OPS_ROOT:-}"
if [[ -z "$ROOT_DIR" ]]; then
    # A throwaway root, rendered by the real render-ops.sh.
    ROOT_DIR="$CHECK_DIR/root"
    mkdir -p "$ROOT_DIR/etc/env" "$ROOT_DIR/runtime"
    cat > "$ROOT_DIR/etc/env/ops.env" <<EOF
STACK=opscheck
GREMION_ROOT_DIR=$ROOT_DIR
OPS_BIND_IP=127.0.0.1
OPS_INGEST_BIND_IP=127.0.0.1
OPS_UID=$(id -u)
OPS_GID=$(id -g)
PROM_RETENTION_TIME=27d
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
ALERT_WEBHOOK_URL=http://127.0.0.1:9/none
ALERT_EMAIL_TO=CHANGE_ME_OPERATOR_alert_email_to
ALERT_EMAIL_FROM=alerts@example.org
ALERT_SMTP_HOST=mail.example.org
ALERT_SMTP_PORT=587
ALERT_SMTP_USER=alerts@example.org
ALERT_SMTP_PASSWORD=CHANGE_ME_GEN_alnum32_alert_smtp
STALWART_API_KEY=CHANGE_ME_GEN_hex32_stalwart_api
OTLP_INGEST_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
OPS_THIRD_PARTY_PROBES=nextcloud=https://cloud.example.org/status.php
EOF
    GREMION_ROOT="$ROOT_DIR" "$REPO_ROOT/infra/host/ops/render-ops.sh" --env-file "$ROOT_DIR/etc/env/ops.env" \
        || { echo "render-ops.sh failed on the throwaway root" >&2; exit 1; }
fi
TARGETS_DIR="$ROOT_DIR/runtime/ops/targets"
STALWART_KEY="$ROOT_DIR/etc/secrets/ops/stalwart-api-key"
for f in "$TARGETS_DIR" "$STALWART_KEY"; do
    [[ -e "$f" ]] || {
        echo "missing rendered artefact: $f" >&2
        echo "run: infra/host/ops/render-ops.sh --env-file <root>/etc/env/ops.env" >&2
        exit 2
    }
done

prom_image="$(image_of prometheus)"
loki_image="$(image_of loki)"
tempo_image="$(image_of tempo)"
alloy_image="$(image_of alloy)"
bb_image="$(image_of blackbox)"
for i in "$prom_image" "$loki_image" "$tempo_image" "$alloy_image" "$bb_image"; do
    [[ "$i" == *"@sha256:"* ]] || { echo "an ops image is not digest-pinned: '${i}'" >&2; exit 2; }
done

# One directory assembled to look exactly like the container's /etc/prometheus:
# the static configs from the repo plus the rendered targets and credential.
PROM_DIR="$CHECK_DIR/prometheus"
rm -rf "$PROM_DIR"; mkdir -p "$PROM_DIR"
cp "$OBS_DIR/prometheus/prometheus.yml" "$OBS_DIR/prometheus/rules.yml" "$OBS_DIR/prometheus/rules.test.yml" "$PROM_DIR/"
cp -r "$TARGETS_DIR" "$PROM_DIR/targets"
cp "$STALWART_KEY" "$PROM_DIR/stalwart-api-key"

prom_host_dir="$(winpath "$PROM_DIR")"
obs_host_dir="$(winpath "$OBS_DIR")"
docker_host_dir="$(winpath "$REPO_ROOT/docker")"

# Mounted at the path the running container uses, not at a neutral /work: a
# check run anywhere else fails on absolute paths that are correct in
# production, and would pass on ones that are not.
mount_prom=(-v "${prom_host_dir}:/etc/prometheus:ro" -w /etc/prometheus)

echo "== promtool check config =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" check config prometheus.yml

echo "== promtool check rules =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" check rules rules.yml

echo "== promtool test rules (healthy, blind, backup, TRD-224, broker, third party) =="
docker run --rm --entrypoint promtool "${mount_prom[@]}" "$prom_image" test rules rules.test.yml

echo "== loki -verify-config =="
docker run --rm -v "${docker_host_dir}/loki:/etc/loki:ro" "$loki_image" -config.file=/etc/loki/loki.yaml -verify-config

echo "== tempo -config.verify =="
docker run --rm -v "${docker_host_dir}/tempo:/etc/tempo:ro" "$tempo_image" -config.file=/etc/tempo/tempo.yaml -config.verify=true

echo "== alloy validate =="
docker run --rm -v "${docker_host_dir}/alloy:/etc/alloy:ro" "$alloy_image" validate /etc/alloy/config.alloy

echo "== blackbox config parse =="
docker run --rm -v "${obs_host_dir}:/work:ro" -w /work "$bb_image" --config.file=/work/blackbox.yml --config.check

echo "OPS-CHECK: config=ok rules=ok ruletests=ok loki=ok tempo=ok alloy=ok blackbox=ok"
