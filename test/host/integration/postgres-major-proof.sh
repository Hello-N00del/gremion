#!/usr/bin/env bash
#
# INTEGRATION (Docker) — B37: the pinned Postgres major is what actually RUNS.
#
# A green `make lint` proves the TAG in a file. This proves the SERVER: the
# kernel base compose is rendered, its postgres service is STARTED with the real
# mounts it declares, and the major is read back out of the running database —
# together with the pg_dump / pg_restore / psql clients the backup path execs
# (infra/host/bin/gremion-backup:414-415, scripts/restore.sh:109,122). There is
# no dedicated backup image at f7ac826 — the client major FOLLOWS the server pin
# through `docker compose exec`, and this proof is what establishes that.
#
# Why the server is started and not merely inspected: at major 18 the official
# image moved PGDATA to /var/lib/postgresql/<major>/docker and its entrypoint
# began refusing ANY mount at /var/lib/postgresql/data, empty or not
# (docker-library/postgres PR 1259). A tree can carry the right tag in every
# file, pass every text guard, and still crash-loop on `up`. Only a running
# server distinguishes those two states, so step 5 is the load-bearing one.
#
# ISOLATION — read this before changing the overlay. The kernel compose gives
# BOTH its volumes and its network FIXED, project-independent names
# (docker-compose.yml: `pg-data: {name: gremion_pg_data}` and
# `gremion-net: {name: gremion_net}`). A proof that only renamed the volume
# would still have joined the operator's live network and taken the `postgres`
# DNS alias on it, so every client on that network — gremion-ui, keycloak,
# pgbouncer, each leaf — would have been round-robined onto this throwaway
# cluster, which runs with a superuser password committed to this file. The
# overlay therefore scopes the NETWORK as well as the volume, and both
# overrides are ASSERTED on the rendered artefact and on the running container
# rather than assumed (steps 5.0 and 5.1).
#
# Post-conditions on real output, never an exit code: every check reads a value
# back and compares it, and an empty reading FAILS.
#
# The pinned major and the expected data mount are read from
# scripts/check-postgres-major.mjs, so this script never restates them and
# cannot drift from docs/ops/postgres-major.md.
#
# Usage: test/host/integration/postgres-major-proof.sh
# Exit:  0 proof green · 1 a proof failed · 2 missing precondition
set -euo pipefail

# Docker Desktop under Git Bash mangles container-side paths of -v arguments.
case "${OSTYPE:-}" in msys*|cygwin*) export MSYS_NO_PATHCONV=1 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
command -v docker >/dev/null || { echo "precondition: docker not on PATH"; exit 2; }
command -v node >/dev/null || { echo "precondition: node not on PATH"; exit 2; }

read_const() {   # <exported name>
    (cd "$ROOT" && node -e \
        "import('./scripts/check-postgres-major.mjs').then((m) => console.log(m.${1}))")
}
MAJOR="$(read_const POSTGRES_MAJOR)"
MOUNT="$(read_const POSTGRES_DATA_MOUNT)"
[ -n "$MAJOR" ] || { echo "precondition: could not read POSTGRES_MAJOR"; exit 2; }
[ -n "$MOUNT" ] || { echo "precondition: could not read POSTGRES_DATA_MOUNT"; exit 2; }
# TASK-019 (TRD-350): the proof pulls and runs the pinned REFERENCE — tag and
# index digest — and every rendered image must equal it byte for byte.
WANT="$(read_const POSTGRES_IMAGE_REF)"
[ -n "$WANT" ] || { echo "precondition: could not read POSTGRES_IMAGE_REF"; exit 2; }

# A project name of our own, and proof-scoped names for EVERY named resource the
# kernel compose fixes project-independently, so nothing here can touch — or be
# reached from — a running stack.
PROJECT=b37-postgres-major-proof
PROOF_VOLUME="${PROJECT}_pg_data"
PROOF_NETWORK="${PROJECT}_net"

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
WORK="$(mktemp -d)"

# `docker` is a Windows binary under Git Bash and cannot open an MSYS path such
# as /tmp/tmp.XXXX, so every path handed TO docker goes through this first.
host_path() {
    case "${OSTYPE:-}" in msys*|cygwin*) cygpath -w "$1" ;; *) echo "$1" ;; esac
}
OVERLAY="${WORK}/proof-overlay.yml"
OVERLAY_F="$(host_path "$OVERLAY")"

# Written BEFORE the cleanup trap is installed, so that every exit path — including
# a precondition failure in the middle of step 1 — can run the `down` below with
# the same overlay the `up` would have used. Image, mount, environment and the
# init script stay exactly as shipped; the ONLY things this proof changes about
# the kernel compose are the two fixed resource names.
cat >"$OVERLAY" <<OVERLAY
# Proof-scoped names for the two resources docker-compose.yml fixes
# project-independently.
#
#   pg-data     so the operator's real database is neither read nor removed.
#   gremion-net so this throwaway cluster — which runs with the superuser
#               password below — never joins the live stack's network, where it
#               would claim the "postgres" DNS alias alongside the real server
#               and silently take a share of every client's traffic.
volumes:
  pg-data:
    name: ${PROOF_VOLUME}
networks:
  gremion-net:
    name: ${PROOF_NETWORK}
OVERLAY

# Every compose call of this proof. It cd's to $ROOT and names the compose file
# RELATIVELY on purpose: $ROOT is an MSYS path under Git Bash and the Windows
# docker binary cannot open one, so an absolute -f here fails — silently, if the
# call is one whose failure is swallowed.
dc() { (cd "$ROOT" && docker compose -p "$PROJECT" -f docker-compose.yml \
        -f "$OVERLAY_F" "$@"); }

# NOTE the missing `-v` on `down`: the kernel's volumes carry FIXED names, so a
# `down -v` against a mis-rendered overlay would delete the operator's real
# database. The proof volume is removed BY NAME instead, and step 5 refuses to
# run at all unless the rendered volume and network names really were overridden.
cleanup() {
    dc down --remove-orphans >/dev/null 2>&1 || true
    docker volume rm -f "$PROOF_VOLUME" >/dev/null 2>&1 || true
    docker network rm "$PROOF_NETWORK" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    if [ "$CREATED_LEGAL_ENV" = true ]; then rm -f "$LEGAL_ENV"; fi
}
trap cleanup EXIT

# major_of "psql (PostgreSQL) 18.6" -> 18
major_of() {
    printf '%s\n' "$1" | sed -n 's/.*(PostgreSQL) \([0-9][0-9]*\).*/\1/p' | head -1
}

# json_of <json> <node expression over `cfg`>
# The node program is single-quoted on purpose: its own ${...} template literal
# must reach node intact, not be expanded by the shell first.
# shellcheck disable=SC2016
json_of() {
    printf '%s' "$1" | node -e '
let s = ""
const expr = process.argv[1]
process.stdin.on("data", (d) => { s += d }).on("end", () => {
  const cfg = JSON.parse(s)
  const fn = new Function("cfg", `return (${expr})`)
  const v = fn(cfg)
  console.log(v === undefined || v === null ? "" : v)
})' "$2"
}

# ── 1. the RENDERED compose, not the source line ───────────────────────────
# EVERY rendered postgres image is read, not the first one: a second Postgres
# service added below the first would otherwise be invisible to this proof.
CFG="$(cd "$ROOT" && docker compose -f docker-compose.yml config 2>/dev/null)" \
    || { echo "precondition: docker compose config did not render"; exit 2; }
IMGS="$(printf '%s\n' "$CFG" \
    | sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:.*\)$/\1/p')"
[ -n "$IMGS" ] \
    || { echo "FAIL: the rendered compose declares no postgres: image at all"; exit 1; }
while IFS= read -r img; do
    [ "$img" = "$WANT" ] \
        || { echo "FAIL: rendered compose image is '${img}', expected ${WANT}"; exit 1; }
done <<<"$IMGS"
echo "  ok  rendered compose: $(printf '%s' "$IMGS" | tr '\n' ' ')"

# 1b. the six profile-gated module servers (TASK-019, D14) are not rendered
# without their profiles, so they are rendered WITH them, and every service
# carrying the org.gremion.postgres label is read by its label — not by an
# image that happens to start with `postgres:`, which a `pgvector/...`
# override would not.
MODULE_IDS="$(cd "$ROOT" && node -e \
    "import('./scripts/check-postgres-major.mjs').then((m) => console.log(m.MODULE_POSTGRES_IDS.join(' ')))")"
[ -n "$MODULE_IDS" ] || { echo "precondition: could not read MODULE_POSTGRES_IDS"; exit 2; }
PROFILE_ARGS=()
for id in $MODULE_IDS; do PROFILE_ARGS+=(--profile "$id"); done
ALL_JSON="$(cd "$ROOT" && docker compose -f docker-compose.yml "${PROFILE_ARGS[@]}" config --format json 2>/dev/null)" \
    || { echo "precondition: docker compose config with the module profiles did not render"; exit 2; }
LABELLED="$(json_of "$ALL_JSON" \
    'Object.entries(cfg.services).filter(([, s]) => (s.labels || {})["org.gremion.postgres"]).map(([n, s]) => n + "=" + s.image).join("\n")')"
EXPECTED_N=$(( $(wc -w <<<"$MODULE_IDS") + 1 ))
[ "$(printf '%s\n' "$LABELLED" | sed '/^$/d' | wc -l)" -eq "$EXPECTED_N" ] \
    || { echo "FAIL: expected ${EXPECTED_N} labelled Postgres services with all module profiles, got: $(printf '%s' "$LABELLED" | tr '\n' ' ')"; exit 1; }
while IFS= read -r row; do
    [ "${row#*=}" = "$WANT" ] \
        || { echo "FAIL: rendered ${row%%=*} runs '${row#*=}', expected ${WANT}"; exit 1; }
done <<<"$LABELLED"
echo "  ok  rendered labelled Postgres services (${EXPECTED_N}, all module profiles): every one is ${WANT}"

# ── 2. the MOUNT the rendered compose declares for the data volume ─────────
# The tag and the mount are one contract: the 18+ entrypoint refuses to start
# against a mount at the pre-18 path, so a right tag on a wrong mount is a
# stack that never boots.
CFG_JSON="$(cd "$ROOT" && docker compose -f docker-compose.yml config --format json 2>/dev/null)" \
    || { echo "precondition: docker compose config --format json did not render"; exit 2; }
RENDERED_MOUNT="$(json_of "$CFG_JSON" \
    '(cfg.services.postgres.volumes || []).filter((v) => v.type === "volume").map((v) => v.target).join(" ")')"
[ "$RENDERED_MOUNT" = "$MOUNT" ] \
    || { echo "FAIL: rendered postgres data mount is '${RENDERED_MOUNT}', expected ${MOUNT}"; exit 1; }
echo "  ok  rendered data mount: ${RENDERED_MOUNT}"

# ── 3. the SERVER binary inside that image ─────────────────────────────────
SRV="$(docker run --rm "$WANT" postgres --version)"
[ "$(major_of "$SRV")" = "$MAJOR" ] \
    || { echo "FAIL: server reports '${SRV}', expected major ${MAJOR}"; exit 1; }
echo "  ok  server binary: ${SRV}"

# ── 4. the CLIENTS the backup/restore path execs INSIDE that same image ────
for bin in pg_dump pg_restore psql; do
    V="$(docker run --rm "$WANT" "$bin" --version)"
    [ "$(major_of "$V")" = "$MAJOR" ] \
        || { echo "FAIL: ${bin} reports '${V}', expected major ${MAJOR}"; exit 1; }
    echo "  ok  ${bin}: ${V}"
done

# ── 5.0 ISOLATION, asserted before anything is started ─────────────────────
# Both of the kernel's fixed names are read off the BASE render and must differ
# from the proof-scoped ones. A base whose names already matched would mean the
# overlay changes nothing and the steps below would be running against the
# operator's real volume on the operator's real network.
BASE_VOLUME="$(json_of "$CFG_JSON" '(cfg.volumes["pg-data"] || {}).name')"
BASE_NETWORK="$(json_of "$CFG_JSON" '(cfg.networks["gremion-net"] || {}).name')"
[ -n "$BASE_VOLUME" ] && [ "$BASE_VOLUME" != "$PROOF_VOLUME" ] \
    || { echo "FAIL: refusing to run — the proof volume is not distinct from '${BASE_VOLUME}'"; exit 1; }
[ -n "$BASE_NETWORK" ] && [ "$BASE_NETWORK" != "$PROOF_NETWORK" ] \
    || { echo "FAIL: refusing to run — the proof network is not distinct from '${BASE_NETWORK}'"; exit 1; }

# ...and the overlay is proven to have TAKEN EFFECT on the merged render, not
# merely written. This is the check that would catch an overlay that failed to
# merge, a renamed top-level key, or a base file that stopped declaring one of
# the two.
MERGED_JSON="$(dc config --format json 2>/dev/null)" \
    || { echo "precondition: the merged proof render did not resolve"; exit 2; }
MERGED_VOLUME="$(json_of "$MERGED_JSON" '(cfg.volumes["pg-data"] || {}).name')"
MERGED_NETWORK="$(json_of "$MERGED_JSON" '(cfg.networks["gremion-net"] || {}).name')"
[ "$MERGED_VOLUME" = "$PROOF_VOLUME" ] \
    || { echo "FAIL: the overlay did not scope the data volume — merged render says '${MERGED_VOLUME}', expected ${PROOF_VOLUME}"; exit 1; }
[ "$MERGED_NETWORK" = "$PROOF_NETWORK" ] \
    || { echo "FAIL: the overlay did not scope the network — merged render says '${MERGED_NETWORK}', expected ${PROOF_NETWORK}"; exit 1; }
echo "  ok  isolation: volume ${BASE_VOLUME} -> ${MERGED_VOLUME}, network ${BASE_NETWORK} -> ${MERGED_NETWORK}"

# ── 5. THE RUNNING SERVER, on the mounts the kernel really declares ────────
# Everything above this line is satisfied by a stack that cannot boot. This is
# the step that is not.

# Proof-local credentials and database names, exported so they win over any
# .env the operator happens to have in the repo root. The databases below are
# created by docker/postgres/init-databases.sh, the kernel's own init SQL —
# which makes this the first thing in the tree to run kernel SQL on the pin.
# The password is published in this file on purpose: 5.0 has just proven this
# cluster is reachable only from the proof's own network, so it protects
# nothing and pretending otherwise would be the real hazard.
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=b37-proof-not-a-secret
export KEYCLOAK_DB_NAME=keycloak  KEYCLOAK_DB_PASSWORD=b37-proof-not-a-secret
export GREMION_DB_NAME=gremion    GREMION_DB_PASSWORD=b37-proof-not-a-secret
export CONTROL_DB_NAME=control    CONTROL_DB_PASSWORD=b37-proof-not-a-secret
export PUBLIC_DB_PASSWORD=b37-proof-not-a-secret

# A leftover container from an earlier run would be RECREATED rather than built
# fresh, and a recreate carries the previous container's mounts for any path the
# image declares as a VOLUME. That is state leakage that can make this step pass
# on a compose file whose mount is wrong, so the clean slate is ASSERTED, not
# assumed: the container is torn down, the volume removed, and both facts read
# back before anything starts.
dc down --remove-orphans >/dev/null 2>&1 || true
docker volume rm -f "$PROOF_VOLUME" >/dev/null 2>&1 || true
if docker volume inspect "$PROOF_VOLUME" >/dev/null 2>&1; then
    echo "FAIL: ${PROOF_VOLUME} still exists after removal — refusing to prove anything on leftover state"
    exit 1
fi
LEFTOVER="$(docker ps -aq --filter "name=^${PROJECT}-postgres" | tr -d '\r\n')"
[ -z "$LEFTOVER" ] \
    || { echo "FAIL: a container of project ${PROJECT} survived teardown (${LEFTOVER})"; exit 1; }

dc up -d --force-recreate --renew-anon-volumes postgres >/dev/null 2>&1 \
    || { echo "FAIL: 'docker compose up -d postgres' did not start the service"; dc logs postgres | tail -20; exit 1; }
CID="$(dc ps -q postgres | tr -d '\r\n')"
[ -n "$CID" ] || { echo "FAIL: the postgres service has no container after 'up'"; exit 1; }

# ── 5.1 the NETWORKS the container really joined ───────────────────────────
# Read off the running container, because this is the post-condition the
# isolation argument rests on: exactly one network, and it is the proof's own.
# Anything else means this cluster is answering to clients it must never see.
NETS="$(docker inspect "$CID" \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' \
    | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//')"
[ "$NETS" = "$PROOF_NETWORK" ] \
    || { echo "FAIL: the running container's networks are '${NETS}', expected exactly '${PROOF_NETWORK}' — it must never join ${BASE_NETWORK}"; exit 1; }
echo "  ok  running container networks: ${NETS}"

# The mounts the container REALLY got, read off the running container. If the
# only mount into the postgres tree is not the one the compose file declares,
# nothing below this line would be measuring the shipped configuration.
MOUNTS="$(docker inspect "$CID" \
    --format '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' \
    | grep '^/var/lib/postgresql' | sort -u | tr '\n' ' ' | sed 's/ $//')"
[ "$MOUNTS" = "$MOUNT" ] \
    || { echo "FAIL: the running container's Postgres mounts are '${MOUNTS}', expected exactly '${MOUNT}'"; exit 1; }
echo "  ok  running container mounts: ${MOUNTS}"

# Ready means the FINAL server, reached over TCP. The image's entrypoint runs
# the init scripts on a temporary server started with listen_addresses='' and
# then shuts it down; a socket-only pg_isready passes against that temporary
# server, and the next query meets "the database system is shutting down"
# (measured 2026-09-25, TASK-019). -h 127.0.0.1 cannot be answered by it.
READY=false
for _ in $(seq 1 60); do
    if dc exec -T postgres pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" >/dev/null 2>&1; then READY=true; break; fi
    sleep 1
done
if [ "$READY" != true ]; then
    echo "FAIL: the postgres service never became ready on ${WANT} at mount ${MOUNT}"
    dc ps --format '{{.Name}} {{.Image}} {{.Status}}'
    dc logs postgres 2>&1 | tail -25
    exit 1
fi

# 5a. the major the RUNNING server reports — 180006 -> 18
VERNUM="$(dc exec -T postgres psql -U "$POSTGRES_USER" -Atc 'show server_version_num' | tr -d '\r')"
RUNNING_MAJOR="$(( VERNUM / 10000 ))"
[ "$RUNNING_MAJOR" = "$MAJOR" ] \
    || { echo "FAIL: the running server reports major ${RUNNING_MAJOR} (server_version_num=${VERNUM}), expected ${MAJOR}"; exit 1; }
echo "  ok  running server: major ${RUNNING_MAJOR} (server_version_num=${VERNUM})"

# 5b. the data directory is ON the mounted volume. A PGDATA outside it would
#     mean the cluster lives on the container's writable layer and is destroyed
#     on every recreate — which is exactly what a relocated PGDATA plus an
#     unchanged mount produces where the entrypoint does not refuse outright.
DATADIR="$(dc exec -T postgres psql -U "$POSTGRES_USER" -Atc 'show data_directory' | tr -d '\r')"
case "$DATADIR" in
    "$MOUNT"|"$MOUNT"/*) ;;
    *) echo "FAIL: data_directory is '${DATADIR}', which is not on the mounted volume ${MOUNT}"; exit 1 ;;
esac
ON_DISK="$(dc exec -T postgres cat "${DATADIR}/PG_VERSION" | tr -d '\r')"
[ "$ON_DISK" = "$MAJOR" ] \
    || { echo "FAIL: ${DATADIR}/PG_VERSION says '${ON_DISK}', expected ${MAJOR}"; exit 1; }
echo "  ok  data directory: ${DATADIR} (PG_VERSION ${ON_DISK}) under ${MOUNT}"

# 5c. the kernel's own init SQL ran on this major
DBS="$(dc exec -T postgres psql -U "$POSTGRES_USER" -Atc \
    'select datname from pg_database order by 1' | tr -d '\r')"
for db in "$KEYCLOAK_DB_NAME" "$GREMION_DB_NAME" "$CONTROL_DB_NAME"; do
    printf '%s\n' "$DBS" | grep -qx "$db" \
        || { echo "FAIL: docker/postgres/init-databases.sh did not create '${db}' on major ${MAJOR} (got: $(printf '%s' "$DBS" | tr '\n' ' '))"; exit 1; }
done
echo "  ok  kernel init SQL on major ${MAJOR}: ${KEYCLOAK_DB_NAME}, ${GREMION_DB_NAME}, ${CONTROL_DB_NAME} created"

# 5d. the clients INSIDE the running container, which is what gremion-backup
#     and scripts/restore.sh actually exec
for bin in pg_dump psql; do
    V="$(dc exec -T postgres "$bin" --version | tr -d '\r')"
    [ "$(major_of "$V")" = "$MAJOR" ] \
        || { echo "FAIL: ${bin} inside the running service reports '${V}', expected major ${MAJOR}"; exit 1; }
    echo "  ok  ${bin} inside the running service: ${V}"
done

# 5e. the RUNNING check (scripts/check-postgres-major-running.mjs, TASK-019)
#     against this very container, by its org.gremion.postgres label: the
#     proof starts the kernel server only, so no module profile is expected.
RUNNING="$(cd "$ROOT" && node scripts/check-postgres-major-running.mjs --project "$PROJECT" --no-profiles 2>&1)" \
    || { echo "FAIL: check-postgres-major-running.mjs on project ${PROJECT}:"; printf '%s\n' "$RUNNING"; exit 1; }
echo "  ok  running check: $(printf '%s\n' "$RUNNING" | tail -1)"

# ── 6. the ONE standalone backup-client image in the tree (k8s overlay) ────
# k8s/** is frozen (D16) and out of the digest scan, so this reads the MAJOR
# only: the frozen manifest must not have drifted off the pinned tag.
WANT_TAG="$(read_const POSTGRES_IMAGE_TAG)"
K8S="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\).*$/\1/p' \
    "${ROOT}/k8s/overlays/production/patches/backup-cronjob.yaml" | head -1)"
[ -n "$WANT_TAG" ] && [ "$K8S" = "$WANT_TAG" ] \
    || { echo "FAIL: backup cronjob client image is '${K8S}', expected ${WANT_TAG} (k8s is frozen at the tag, D16)"; exit 1; }
echo "  ok  k8s backup cronjob client: ${K8S}"

# ── 7. the host backup and restore paths take their client from the SERVER ─
#      container, so the pin covers them. Assert that contract on the real text.
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

echo "postgres-major proof GREEN — major ${MAJOR} runs from ${MOUNT} on ${PROOF_NETWORK}, server and clients agree"
