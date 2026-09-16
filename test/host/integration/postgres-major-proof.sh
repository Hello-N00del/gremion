#!/usr/bin/env bash
#
# INTEGRATION (Docker) — B37: the pinned Postgres major is what actually RUNS.
#
# A green `make lint` proves the TAG in a file. This proves the BINARY: the
# rendered compose image is pulled, the server reports its major, and the
# pg_dump / pg_restore / psql clients the backup path execs
# (infra/host/bin/gremion-backup:414-415, scripts/restore.sh:109,122) report the
# same one. There is no dedicated backup image at f7ac826 — the client major
# FOLLOWS the server pin through `docker compose exec`, and this proof is what
# establishes that. Post-conditions on real output, never an exit code: every
# check reads a value back and compares it, and an empty reading FAILS.
#
# The pinned major is read from scripts/check-postgres-major.mjs, so this script
# never restates it and cannot drift from docs/ops/postgres-major.md.
#
# Usage: test/host/integration/postgres-major-proof.sh
# Exit:  0 proof green · 1 a proof failed · 2 missing precondition
set -euo pipefail

# Docker Desktop under Git Bash mangles container-side paths of -v arguments.
case "${OSTYPE:-}" in msys*|cygwin*) export MSYS_NO_PATHCONV=1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
command -v docker >/dev/null || { echo "precondition: docker not on PATH"; exit 2; }
command -v node >/dev/null || { echo "precondition: node not on PATH"; exit 2; }

MAJOR="$(cd "$ROOT" && node -e \
    "import('./scripts/check-postgres-major.mjs').then((m) => console.log(m.POSTGRES_MAJOR))")"
[ -n "$MAJOR" ] || { echo "precondition: could not read POSTGRES_MAJOR"; exit 2; }
WANT="postgres:${MAJOR}-alpine"

# `docker compose config` refuses to render without the git-ignored
# legal/legal.env that the legal service's `env_file:` names — the same
# precondition .github/workflows/ci.yml satisfies with
# `mkdir -p legal && touch legal/legal.env`. Create it only if it is absent,
# and take it away again on the way out so the tree is left as it was found.
LEGAL_ENV="${ROOT}/legal/legal.env"
CREATED_LEGAL_ENV=false
if [ ! -f "$LEGAL_ENV" ]; then
    mkdir -p "${ROOT}/legal"
    : >"$LEGAL_ENV"
    CREATED_LEGAL_ENV=true
fi
cleanup() {
    if [ "$CREATED_LEGAL_ENV" = true ]; then rm -f "$LEGAL_ENV"; fi
}
trap cleanup EXIT

# major_of "psql (PostgreSQL) 18.6" -> 18
major_of() {
    printf '%s\n' "$1" | sed -n 's/.*(PostgreSQL) \([0-9][0-9]*\).*/\1/p' | head -1
}

# 1. the RENDERED compose, not the source line
CFG="$(cd "$ROOT" && docker compose -f docker-compose.yml config 2>/dev/null)" \
    || { echo "precondition: docker compose config did not render"; exit 2; }
IMG="$(printf '%s\n' "$CFG" \
    | sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:.*\)$/\1/p' | head -1)"
[ -n "$IMG" ] \
    || { echo "FAIL: the rendered compose declares no postgres: image at all"; exit 1; }
[ "$IMG" = "$WANT" ] \
    || { echo "FAIL: rendered compose image is '${IMG}', expected ${WANT}"; exit 1; }
echo "  ok  rendered compose: ${IMG}"

# 2. the SERVER binary inside that image
SRV="$(docker run --rm "$IMG" postgres --version)"
[ "$(major_of "$SRV")" = "$MAJOR" ] \
    || { echo "FAIL: server reports '${SRV}', expected major ${MAJOR}"; exit 1; }
echo "  ok  server: ${SRV}"

# 3. the CLIENTS the backup/restore path execs INSIDE that same image
for bin in pg_dump pg_restore psql; do
    V="$(docker run --rm "$IMG" "$bin" --version)"
    [ "$(major_of "$V")" = "$MAJOR" ] \
        || { echo "FAIL: ${bin} reports '${V}', expected major ${MAJOR}"; exit 1; }
    echo "  ok  ${bin}: ${V}"
done

# 4. the ONE standalone backup-client image in the tree (k8s production overlay)
K8S="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\).*$/\1/p' \
    "${ROOT}/k8s/overlays/production/patches/backup-cronjob.yaml" | head -1)"
[ "$K8S" = "$WANT" ] \
    || { echo "FAIL: backup cronjob client image is '${K8S}', expected ${WANT}"; exit 1; }
echo "  ok  k8s backup cronjob client: ${K8S}"

# 5. the host backup and restore paths take their client from the SERVER
#    container, so the pin covers them. Assert that contract on the real text.
BACKUP="${ROOT}/infra/host/bin/gremion-backup"
# The single quotes are the point: these are the LITERAL variable names the
# backup path writes, matched as fixed strings, not values to expand here.
# shellcheck disable=SC2016
if ! grep -qF 'docker compose --env-file "$STATE_ENV" exec -T "$1"' "$BACKUP"; then
    echo "FAIL: gremion-backup no longer execs its client inside a compose service"
    exit 1
fi
# shellcheck disable=SC2016
if ! grep -qF 'pg_dump -U "$POSTGRES_USER" "$2"' "$BACKUP"; then
    echo "FAIL: gremion-backup no longer execs pg_dump inside the pinned Postgres service"
    exit 1
fi
if ! grep -qF 'docker compose exec -T postgres psql' "${ROOT}/scripts/restore.sh"; then
    echo "FAIL: scripts/restore.sh no longer execs psql inside the pinned Postgres service"
    exit 1
fi
echo "  ok  host backup/restore clients run inside the pinned server image"

echo "postgres-major proof GREEN — major ${MAJOR}, server and clients agree"
