#!/usr/bin/env bash
#
# INTEGRATION (Docker on a Linux engine) — the §J restore proof, end to end.
#
# Builds instance A (seeded), stages a backup in the TASK 9 layout
# (<root>/backups/current), snapshots it with restic, then restores it
# into instance B with gremion-restore-into and asserts BY CONTENT from the
# running system. Then breaks each proof and shows it going RED before restoring.
#
# Instance A runs TWO Postgres services that both hold a database called
# `shared`. That is the shape of Task 9's round-5 finding: keyed on the database
# name alone the two dumps collapse onto one restore target and one server's
# data is silently replaced by the other's. Here each dump keeps its
# <service>__<database> identity and the run refuses rather than guessing.
#
# Requires on PATH: docker, restic, sha256sum, gzip. On Windows install restic
# with `winget install --id restic.restic`; note that Docker Desktop under Git
# Bash cannot bind-mount MSYS paths, so this script is run inside a Linux
# engine there (see the task report).
#
# Usage: test/host/integration/restore-proof.sh [--keep]
# Exit:  0 proof green · 1 a proof failed · 2 missing precondition
set -euo pipefail

# Docker Desktop under Git Bash mangles container-side paths of -v arguments.
case "${OSTYPE:-}" in msys*|cygwin*) export MSYS_NO_PATHCONV=1 ;; esac

KERNEL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN="${KERNEL_ROOT}/infra/host/bin"
KEEP=false
[[ "${1:-}" == "--keep" ]] && KEEP=true

info() { echo "[restore-proof] $*"; }
die()  { echo "[restore-proof] FAIL: $*" >&2; exit "${2:-1}"; }

for c in docker restic sha256sum gzip; do
    command -v "$c" >/dev/null 2>&1 || die "missing required tool: $c" 2
done
docker info >/dev/null 2>&1 || die "docker is not running on this box" 2

WORK="$(mktemp -d)"
A="${WORK}/a"; B="${WORK}/b"
export RESTIC_PASSWORD="restore-proof-passphrase"
export RESTIC_REPOSITORY="${WORK}/repo"

# icompose <instance root> <verb…> — every compose call of this fixture, run
# FROM THE INSTANCE'S RELEASE TREE, because the instances carry the RELATIVE
# COMPOSE_FILE the rendered templates ship (state.env.tmpl, app.env.tmpl). A
# fixture with an ABSOLUTE COMPOSE_FILE cannot see a program that forgot to cd,
# which is how the recreate inside gremion-neuter shipped unable to run.
icompose() {   # <instance root> <verb…>
    local root="$1"; shift
    ( cd "${root}/current" && docker compose --env-file "${root}/etc/env/state.env" "$@" )
}

cleanup() {
    [[ "$KEEP" == true ]] && { info "kept: ${WORK}"; return 0; }
    icompose "$A" down --volumes --remove-orphans >/dev/null 2>&1 || true
    icompose "$B" down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker rm -f proofb-null-sink >/dev/null 2>&1 || true
    docker volume rm proofa_traefik_acme proofa_tenant_secrets proofa_mail_data >/dev/null 2>&1 || true
    docker volume rm proofb_traefik_acme proofb_tenant_secrets proofb_mail_data >/dev/null 2>&1 || true
    docker network rm proofa_state proofb_state >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# ── the fixture composition (one file, both instances) ─────────────────────
# `analytics` is a SECOND Postgres server in the same stack. Its data volume is
# named analytics_pgdata on purpose: RESTORE_VOLUME_SKIP_RE must skip a second
# server's data directory for exactly the reason it skips the first one.
cat >"${WORK}/docker-compose.yml" <<'YAML'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER:     ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB:       ${CONTROL_DB_NAME}
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 3s
      timeout: 3s
      retries: 20
  analytics:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER:     ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB:       analytics
    volumes:
      - analytics_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 3s
      timeout: 3s
      retries: 20
  nextcloud:
    image: alpine:3.22
    command: ["sh", "-c", "sleep 86400"]
    environment:
      SMTP_HOST: ${SMTP_HOST:-null-sink}
    volumes:
      - files-data:/files
volumes:
  pg-data:
  analytics_pgdata:
  files-data:
  traefik-acme:
    name: ${STACK}_traefik_acme
    external: true
networks:
  default:
    name: ${STACK}_state
    external: true
YAML

write_instance() {   # <root> <stack> <smtp host>
    local root="$1" stack="$2" smtp="$3"
    mkdir -p "${root}"/{etc/env,etc/secrets,etc/edge,releases,bin,backups,runtime,logs}
    mkdir -p "${root}/current/scripts"
    chmod 700 "${root}/etc"
    cp "${KERNEL_ROOT}/scripts/restore.sh" "${root}/current/scripts/restore.sh"
    chmod 755 "${root}/current/scripts/restore.sh"
    # The composition lives IN the release tree and is named by a RELATIVE
    # COMPOSE_FILE, exactly as the rendered env templates ship it.
    cp "${WORK}/docker-compose.yml" "${root}/current/docker-compose.yml"
    cat >"${root}/etc/env/state.env" <<EOF
STACK=${stack}
COMPOSE_PROJECT_NAME=${stack}-state
COMPOSE_FILE=docker-compose.yml
RESTIC_REPOSITORY=${RESTIC_REPOSITORY}
RESTIC_PASSWORD=${RESTIC_PASSWORD}
PLATFORM_DOMAIN=example.org
TRAEFIK_CERT_RESOLVER=
POSTGRES_USER=postgres
POSTGRES_PASSWORD=proofpassword
CONTROL_DB_NAME=control
GREMION_DB_USER=gremion
KEYCLOAK_DB_USER=keycloak
CONTROL_DB_USER=control
SMTP_HOST=${smtp}
EOF
    chmod 600 "${root}/etc/env/state.env"
    echo none >"${root}/runtime/active-colour"
    docker network create "${stack}_state" >/dev/null
    docker volume create "${stack}_traefik_acme"   >/dev/null
    docker volume create "${stack}_tenant_secrets" >/dev/null
    docker volume create "${stack}_mail_data"      >/dev/null
    icompose "$root" up -d
}

wait_pg() {   # <root> <service>
    local cid deadline=$((SECONDS + 180))
    cid="$(icompose "$1" ps -q "$2")"
    [[ -n "$cid" ]] || die "no $2 container in $1"
    while (( SECONDS < deadline )); do
        if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" == healthy ]]; then
            echo "$cid"; return 0
        fi
        sleep 2
    done
    die "$2 in $1 never became healthy"
}

# restore.sh recreates each database OWNED BY its role, so the roles must exist
# in the target too — a fresh instance has none.
seed_roles() {   # <postgres container id>
    docker exec -i "$1" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD 'proofpassword';
CREATE ROLE gremion  LOGIN PASSWORD 'proofpassword';
CREATE ROLE control  LOGIN PASSWORD 'proofpassword';
SQL
}

# ── instance A: seed, stage, snapshot ──────────────────────────────────────
info "building instance A (proofa)"
write_instance "$A" proofa null-sink
PGA="$(wait_pg "$A" postgres)"
ANA="$(wait_pg "$A" analytics)"
seed_roles "$PGA"

docker exec -i "$PGA" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE DATABASE keycloak OWNER keycloak;
CREATE DATABASE gremion  OWNER gremion;
CREATE DATABASE shared   OWNER postgres;
SQL
docker exec -i "$PGA" psql -v ON_ERROR_STOP=1 -U postgres -d control <<'SQL'
CREATE TABLE proof_row (k text PRIMARY KEY, v text NOT NULL);
INSERT INTO proof_row VALUES ('seed', 'ratified');
SQL
docker exec -i "$PGA" psql -v ON_ERROR_STOP=1 -U postgres -d shared <<'SQL'
CREATE TABLE whose_server (name text PRIMARY KEY);
INSERT INTO whose_server VALUES ('kernel-postgres');
SQL
# The SAME database name on the SECOND server, with different content.
docker exec -i "$ANA" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE DATABASE shared OWNER postgres;
SQL
docker exec -i "$ANA" psql -v ON_ERROR_STOP=1 -U postgres -d shared <<'SQL'
CREATE TABLE whose_server (name text PRIMARY KEY);
INSERT INTO whose_server VALUES ('analytics-postgres');
SQL

NCA="$(icompose "$A" ps -q nextcloud)"
docker exec "$NCA" sh -c 'printf "gremion restore proof\n" > /files/proof.txt'
PROOF_SHA="$(docker exec "$NCA" sha256sum /files/proof.txt | awk '{print $1}')"
docker run --rm -v proofa_traefik_acme:/v alpine:3.22 sh -c 'printf "{}\n" > /v/acme.json'
info "seeded: proof.txt sha256=${PROOF_SHA}"

# Stage in the TASK 9 layout: backups/current/<db>.sql.gz and
# backups/current/volumes/<vol>.tar. This is the tree a real
# gremion-backup produces; the locator must find it there.
STAGE="${A}/backups/current"
mkdir -p "${STAGE}/volumes"
for db in control keycloak gremion; do
    docker exec "$PGA" pg_dump -U postgres "$db" | gzip -c >"${STAGE}/${db}.sql.gz"
done
for vol in $(docker volume ls -q --filter label=com.docker.compose.project=proofa-state) \
           proofa_traefik_acme; do
    docker run --rm -v "${vol}:/v:ro" -v "${STAGE}/volumes:/out" alpine:3.22 \
        tar -cf "/out/${vol}.tar" -C /v .
done
cp -r "${A}/etc" "${A}/backups/etc-snapshot"

restic init >/dev/null
restic backup --quiet --tag "label=proof" --tag "class=snapshot" \
    "${STAGE}" "${A}/backups/etc-snapshot" >/dev/null
info "restic snapshot taken from ${STAGE}"

# ── instance B: restore into it ────────────────────────────────────────────
# Every gremion-restore-into call below is made with the restic keys UNSET in
# its environment (env -u): on the host, sudo's env_reset drops whatever the
# operator exported in their own shell, so the program has to take both out of
# the instance's own state.env or it cannot run at all.
# The snapshot's etc lives under backups/etc-snapshot (not */etc/env/state.env),
# so name the source stack explicitly. B starts with the LIVE mail host in its
# state env, so the neuter inside the restore really has a service to recreate.
info "building instance B (proofb)"
write_instance "$B" proofb mail.example.org
PGB0="$(wait_pg "$B" postgres)"
wait_pg "$B" analytics >/dev/null
seed_roles "$PGB0"

set +e
OUT="$(env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD "${BIN}/gremion-restore-into" --stack proofb --root "$B" --release "${B}/current" \
        --src-stack proofa --snapshot latest --rto \
        --proof-file "/files/proof.txt:${PROOF_SHA}" \
        --proof-row db=control "sql=SELECT v::text FROM proof_row WHERE k='seed'" want=ratified 2>&1)"
RC=$?
set -e
printf '%s\n' "$OUT"
[[ $RC -eq 0 ]] || die "restore-into exited ${RC}"
grep -q "RESTORE-PROOF: stack=proofb snapshot=latest databases=3 volumes=2 buckets=0 files=1 rows=1 acme=present" <<<"$OUT" \
    || die "proof line missing or wrong"
grep -q "SKIP volume proofa-state_pg-data" <<<"$OUT" \
    || die "the Postgres data volume was not skipped"
grep -q "SKIP volume proofa-state_analytics_pgdata" <<<"$OUT" \
    || die "the SECOND Postgres server's data volume was not skipped"
grep -qE 'RTO-SECONDS=[0-9]+' <<<"$OUT" || die "no RTO measured"

# post-conditions read from the RUNNING instance B, not from the program output
PGB="$(icompose "$B" ps -q postgres)"
NCB="$(icompose "$B" ps -q nextcloud)"
[[ "$(docker exec -i "$PGB" psql -tAq -U postgres -d control -c "SELECT v FROM proof_row WHERE k='seed';")" == ratified ]] \
    || die "seeded row absent from instance B"
[[ "$(docker exec "$NCB" sha256sum /files/proof.txt | awk '{print $1}')" == "$PROOF_SHA" ]] \
    || die "restored file differs in instance B"
docker run --rm -v proofb_traefik_acme:/v:ro alpine:3.22 test -s /v/acme.json \
    || die "ACME volume did not arrive in instance B"
[[ "$(docker inspect -f '{{.State.Running}}' proofb-null-sink)" == true ]] \
    || die "null sink is not running in instance B"
docker exec "$NCB" sh -c 'nc -z -w 3 null-sink 1025 || getent hosts null-sink' >/dev/null \
    || die "null-sink neither resolves nor accepts SMTP from inside instance B"
NCENV="$(docker exec "$NCB" env)"
grep -q '^SMTP_HOST=null-sink$' <<<"$NCENV" \
    || die "the neuter inside the restore did not recreate nextcloud on the null sink"
info "GREEN: content proof, neuter and null sink verified from the running system"

# ── RED drills ─────────────────────────────────────────────────────────────
info "RED 1: wrong checksum must fail the proof"
set +e
RED1="$(env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD "${BIN}/gremion-restore-into" --stack proofb --root "$B" --release "${B}/current" \
         --src-stack proofa --snapshot latest \
         --proof-file "/files/proof.txt:0000000000000000000000000000000000000000" \
         --proof-row "control:SELECT v FROM proof_row WHERE k='seed':ratified" 2>&1)"
RC1=$?
set -e
[[ $RC1 -eq 1 ]] || die "expected exit 1 on a checksum mismatch, got ${RC1}"
grep -q "PROOF-FILE mismatch /files/proof.txt" <<<"$RED1" || die "no mismatch message"
info "RED 1 observed: $(grep -m1 'PROOF-FILE mismatch' <<<"$RED1")"

info "RED 2: the colon proof-row form must refuse a cast rather than truncate it"
set +e
RED2="$(env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD "${BIN}/gremion-restore-into" --stack proofb --root "$B" --release "${B}/current" \
         --src-stack proofa --snapshot latest \
         --proof-file "/files/proof.txt:${PROOF_SHA}" \
         --proof-row "control:SELECT v::text FROM proof_row WHERE k='seed':ratified" 2>&1)"
RC2=$?
set -e
[[ $RC2 -eq 2 ]] || die "expected exit 2 on a colon-form cast, got ${RC2}"
grep -q "contains '::'" <<<"$RED2" || die "no ambiguity message"
info "RED 2 observed: $(grep -m1 "contains '::'" <<<"$RED2")"

# The env assert is read from the RUNNING container, so it can only be watched
# RED against a container that really carries the live host. The sink host is
# pointed AT the live mail host, so neither the env rewrite nor the recreate can
# clean it up and the post-condition is the only thing left to catch it.
info "RED 3: neuter's env assert must reject a live mail host"
sed -i 's/^SMTP_HOST=.*/SMTP_HOST=mail.example.org/' "${B}/etc/env/state.env"
icompose "$B" up -d --force-recreate nextcloud >/dev/null
set +e
RED3="$("${BIN}/gremion-neuter" --stack proofb --root "$B" \
         --null-sink-host "mail.example.org" 2>&1)"
RC3=$?
set -e
[[ $RC3 -eq 1 ]] || die "expected exit 1 when the sink IS the live mail host, got ${RC3}"
grep -q "still names mail.example.org" <<<"$RED3" || die "no live-host message"
info "RED 3 observed: $(grep -m1 'still names mail.example.org' <<<"$RED3")"

# Task 9's round-5 shape, end to end: ONE database name on TWO Postgres servers.
info "RED 4: two same-named databases on two servers must stay distinct and block"
docker exec "$PGA" pg_dump -U postgres shared | gzip -c >"${STAGE}/postgres__shared.sql.gz"
docker exec "$ANA" pg_dump -U postgres shared | gzip -c >"${STAGE}/analytics__shared.sql.gz"
restic backup --quiet --tag "label=proof-keyed" --tag "class=snapshot" "${STAGE}" >/dev/null
set +e
RED4="$(env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD "${BIN}/gremion-restore-into" --stack proofb --root "$B" --release "${B}/current" \
         --src-stack proofa --snapshot latest \
         --proof-file "/files/proof.txt:${PROOF_SHA}" \
         --proof-row db=control "sql=SELECT v::text FROM proof_row WHERE k='seed'" want=ratified 2>&1)"
RC4=$?
set -e
[[ $RC4 -eq 3 ]] || die "expected exit 3 on an unaddressable keyed dump, got ${RC4}"
grep -q "postgres__shared.sql.gz -> service postgres database shared"  <<<"$RED4" \
    || die "the kernel server's dump was not resolved to (postgres, shared)"
grep -q "analytics__shared.sql.gz -> service analytics database shared" <<<"$RED4" \
    || die "the second server's dump was not resolved to (analytics, shared)"
grep -q "BLOCKED: restore.sh cannot target 'shared'" <<<"$RED4" || die "no BLOCKED message"
[[ "$(docker exec -i "$PGB" psql -tAq -U postgres -d control \
        -c "SELECT count(*) FROM pg_database WHERE datname='shared';")" == 0 ]] \
    || die "a blocked snapshot still created the 'shared' database in instance B"
info "RED 4 observed: $(grep -m1 'BLOCKED: restore.sh cannot target' <<<"$RED4")"

# The neuter's live decision and its post-condition must apply the SAME rule as
# the env rewrite, which retargets an SMTP host key by NAME whatever its value
# is. A relay host that is not mail.example.org — an internal service name, a
# raw IP, a third-party relay — is invisible to a value-only test. Here it also
# cannot be cleaned up by the recreate, because the key is set IN THE
# COMPOSITION rather than in the env file the rewrite owns, so the
# post-condition read from the running container is the only thing left that can
# catch it. Without it the program recreates nothing, prints
# "docker exec env clean" and exits 0 while the container still relays.
info "RED 5: a non-mail.example.org SMTP host in a running container must fail the neuter"
awk '{print; if (index($0, "SMTP_HOST: ${SMTP_HOST:-null-sink}")) print "      EMAIL_HOST: 203.0.113.25"}' \
    "${B}/current/docker-compose.yml" >"${WORK}/b-red5.yml"
grep -q 'EMAIL_HOST: 203.0.113.25' "${WORK}/b-red5.yml" \
    || die "RED 5 fixture: the composition was not amended"
cp "${WORK}/b-red5.yml" "${B}/current/docker-compose.yml"
icompose "$B" up -d --force-recreate nextcloud >/dev/null
NCB="$(icompose "$B" ps -q nextcloud)"
NCENV="$(docker exec "$NCB" env)"
grep -q '^EMAIL_HOST=203.0.113.25$' <<<"$NCENV" \
    || die "RED 5 fixture: the running container does not carry the relay host"
set +e
RED5="$("${BIN}/gremion-neuter" --stack proofb --root "$B" --release "${B}/current" 2>&1)"
RC5=$?
set -e
[[ $RC5 -eq 1 ]] || die "expected exit 1 on a non-sink SMTP host in a running container, got ${RC5}"
grep -q "EMAIL_HOST still names 203.0.113.25, not the null sink null-sink" <<<"$RED5" \
    || die "the post-condition did not name the surviving relay host"
grep -q "live mail/token value(s) survive neutering" <<<"$RED5" \
    || die "no offender summary"
# the same run PROVES the live decision too: the env-file key was recreated away
NCB="$(icompose "$B" ps -q nextcloud)"
NCENV="$(docker exec "$NCB" env)"
grep -q '^SMTP_HOST=null-sink$' <<<"$NCENV" \
    || die "RED 5: the recreate did not run, so the drill proved only half the rule"
info "RED 5 observed: $(grep -m1 'EMAIL_HOST still names' <<<"$RED5")"
grep -v 'EMAIL_HOST: 203.0.113.25' "${B}/current/docker-compose.yml" >"${WORK}/b-ok.yml"
cp "${WORK}/b-ok.yml" "${B}/current/docker-compose.yml"
icompose "$B" up -d --force-recreate nextcloud >/dev/null

info "restoring: re-neutering instance B"
"${BIN}/gremion-neuter" --stack proofb --root "$B" >/dev/null
NCB="$(icompose "$B" ps -q nextcloud)"
NCENV="$(docker exec "$NCB" env)"
grep -q '^SMTP_HOST=null-sink$' <<<"$NCENV" \
    || die "re-neuter did not restore the null sink in the running container"
info "RESTORE-PROOF INTEGRATION: green (5 guards watched RED and restored)"
