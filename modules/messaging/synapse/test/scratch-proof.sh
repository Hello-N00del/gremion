#!/usr/bin/env bash
# ============================================================
# The chat module's Synapse on a SCRATCH stack (TASK-198 TDD 5 and 7). The
# static half is `make lint-synapse`; this is the running half.
#
#   make synapse-proof PHASE=<phase>      (one phase per call)
#   bash scratch-proof.sh <phase> <absolute path of the kernel docker-compose.yml>
#
# The compose file is passed in by the Makefile, so this script names nothing
# outside modules/messaging/ itself; the checkout root is that file's
# directory. Phases, in order (state lives in the proof directory). Every
# phase finishes inside the 4-minute budget of one call and is re-entrant:
#
#   prepare   STACK=t198-<sha8>, a gitignored env file (COMPOSE_PROJECT_NAME,
#             COMPOSE_PROFILES=messaging, every x-required-env key; never the
#             checkout's .env), the externals ${STACK}_state, _edge and
#             _traefik_acme, a legal/legal.env stub when absent, a test RSA
#             key for the IdP stub; tags the pre-built t198-<sha8>/synapse
#             image as the compose image name
#   names     every rendered project, network and volume name starts with
#             ${STACK} -- before any up
#   initdb    (TDD 5) messaging-postgres alone: C|C|synapse, rolsuper f
#   a         only messaging-postgres runs and NO matrix container exists:
#             datcollate/datctype/owner C|C|synapse, major 18
#   b         IdP stub up, matrix up: healthy; the rendered config reads
#             psycopg2, the server name and synapse, names no SQLite;
#             public.users exists; first-boot seconds and RSS recorded
#   c1        stub stopped, matrix restarted: "jwt_config disabled" in the
#             log; the restart time is recorded for c2
#   c2        unhealthy after start_period (240 s + 3 x 15 s from c1), while
#             the old probe (/versions) still exits 0. Polls at most 100 s
#             per call: before the deadline it exits 3 with PENDING -- run it
#             again; it never reads healthy (that is a FAIL)
#   d1        the synapse database recreated bare (en_US.utf8): the preflight
#             names en_US.utf8 and Synapse never starts; matrix left stopped
#   d2        the synapse database restored C|C (libc), matrix stays stopped
#   e         the kernel postgres joins; in-container: major 18, uuidv7;
#             then the kernel's check-postgres-major-running (path passed in)
#   f         both data volumes carry com.docker.compose.project=${STACK}-state
#             (the filter of gremion-backup's project_volumes)
#   teardown  docker rm -f / network rm / volume rm / image rm (the compose
#             tag AND the built t198-<sha8>/synapse image), by the ${STACK}
#             prefix only
#
# Scratch safety: every resource is named ${STACK}-*; no host port is
# published (probe and psql run INSIDE the containers, addressed by the
# com.docker.compose.project + com.docker.compose.service labels). This
# script never runs `docker compose down`, never prunes, and never touches a
# resource outside the ${STACK} prefix. Every assertion reads a post-condition
# (a psql row, a rendered file, docker inspect), never an exit code alone.
# ============================================================
set -euo pipefail

# Git Bash on Windows (the operator's gate box while CI is off; brief section
# 5.7): MSYS rewrites every argument that looks like a POSIX path, so the
# container paths below (/stub, /data/homeserver.yaml, /synapse-healthcheck.sh)
# would reach docker as paths under the Git install. Conversion is off for the
# whole script, and every HOST path handed to docker, node or openssl is made
# mixed-form (C:/...) by cygpath instead. Both are no-ops on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

PHASE="${1:-}"
COMPOSE="${2:-}"
die() { echo "[synapse-proof] FAIL: $*" >&2; exit 1; }
ok() { echo "[synapse-proof] OK: $*"; }
[[ -n "$PHASE" ]] || die "usage: scratch-proof.sh <phase> <docker-compose.yml> (make synapse-proof PHASE=<phase>)"
[[ -f "$COMPOSE" ]] || die "the compose file '$COMPOSE' does not exist (pass the kernel docker-compose.yml)"
COMPOSE="$(hostpath "$COMPOSE")"
REPO="$(hostpath "$(cd "$(dirname "$COMPOSE")" && pwd)")"
OUT="$(hostpath "${T198_OUT:-$REPO/.scratch/t198-proof}")"
mkdir -p "$OUT"
ENVF="$OUT/state.env"
for t in docker python3 openssl; do command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"; done

ledger() { tee -a "$OUT/$1"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [[ "$PHASE" == prepare ]]; then
  SHA8="$(git -C "$REPO" rev-parse --short=8 HEAD)"
  STACK="t198-${SHA8}"
else
  [[ -f "$ENVF" ]] || die "no env file at $ENVF -- run PHASE=prepare first"
  STACK="$(sed -n 's/^STACK=//p' "$ENVF" | tr -d '\r')"
fi
[[ "$STACK" =~ ^t198-[0-9a-f]{8}$ ]] || die "refusing a stack name outside t198-<sha8>: '$STACK'"
PROJECT="${STACK}-state"
IMAGE_LOCAL="${STACK}/synapse"
IMAGE_TAG="${STACK}"
IMAGE_COMPOSE="ghcr.io/hello-n00del/gremion-synapse:${IMAGE_TAG}"
STUB="${STACK}-idp-stub"

compose() { docker compose -f "$COMPOSE" --project-directory "$REPO" --env-file "$ENVF" -p "$PROJECT" "$@"; }
cid() { docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=$1"; }
running_cid() { docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=$1"; }
need_names() { [[ -f "$OUT/.names-ok" ]] || die "run PHASE=names before any up"; }
psql_pg() {
  local c u; c="$(running_cid messaging-postgres)"; [[ -n "$c" ]] || die "messaging-postgres is not running"
  u="$(sed -n 's/^MESSAGING_PG_USER=//p' "$ENVF" | tr -d '\r')"
  docker exec "$c" psql -U "${u:-messaging}" -d "${2:-postgres}" -AtX -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'
}
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" | tr -d '\r'; }
# Every wait is bounded by WALL-CLOCK seconds (bash's SECONDS), not by a count
# of sleeps: on a loaded box each docker call costs seconds of its own, and a
# counted 200 s loop ran past the 4-minute call budget (measured, round 2).
wait_health() { # <cid> <want> <timeout s>
  local end=$((SECONDS + $3)) s
  while (( SECONDS < end )); do
    s="$(health "$1")"
    [[ "$s" == "$2" ]] && return 0
    sleep 2
  done
  return 1
}
# Poll the container log since <since> for an ERE, at most <timeout> s.
wait_log() { # <cid> <since> <ERE> <timeout s>
  # Captured first: `docker logs | grep -q` under pipefail reads SIGPIPE as failure.
  local end=$((SECONDS + $4)) l
  while (( SECONDS < end )); do
    l="$(docker logs --since "$2" "$1" 2>&1)"
    grep -Eq "$3" <<< "$l" && return 0
    sleep 5
  done
  return 1
}

phase_prepare() {
  docker image inspect "$IMAGE_LOCAL" >/dev/null 2>&1 \
    || die "no image $IMAGE_LOCAL -- docker build -t $IMAGE_LOCAL modules/messaging/synapse first"
  docker tag "$IMAGE_LOCAL" "$IMAGE_COMPOSE"
  rnd() { openssl rand -hex 16 | tr -d '\r'; }
  umask 077
  cat > "$ENVF" <<EOF
# TASK-198 scratch proof -- generated, gitignored, never the checkout's .env
STACK=${STACK}
COMPOSE_PROJECT_NAME=${PROJECT}
COMPOSE_PROFILES=messaging
IMAGE_TAG=${IMAGE_TAG}
GREMION_ROOT=${OUT}/root
ACME_CA_SERVER=https://acme.invalid/directory
EDGE_V4_SUBNET=10.198.0.0/24
EDGE_V6_SUBNET=fd5a:198::/64
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
EDGE_HTTP_PORT=80
EDGE_HTTPS_PORT=443
TRAEFIK_API_PORT=8080
INTERNALTEST_PORT=8081
PLATFORM_DOMAIN=${STACK}.example.org
DOMAIN=${STACK}.example.org
POSTGRES_PASSWORD=$(rnd)
KEYCLOAK_DB_PASSWORD=$(rnd)
GREMION_DB_PASSWORD=$(rnd)
CONTROL_DB_PASSWORD=$(rnd)
PUBLIC_DB_PASSWORD=$(rnd)
MESSAGING_PG_USER=messaging
MESSAGING_PG_PASSWORD=$(rnd)
SYNAPSE_DB_PASSWORD=$(rnd)
SYNAPSE_KEYCLOAK_ISSUER_URL=https://idp.${STACK}.example.org/auth/realms/t198
SYNAPSE_KEYCLOAK_FETCH_URL=http://${STUB}:8080/realm.json
SYNAPSE_OIDC_CLIENT_SECRET=$(rnd)
SYNAPSE_KC_MAX=3
EOF
  docker network inspect "${STACK}_state" >/dev/null 2>&1 || docker network create "${STACK}_state" >/dev/null
  docker network inspect "${STACK}_edge" >/dev/null 2>&1 || docker network create "${STACK}_edge" >/dev/null
  docker volume inspect "${STACK}_traefik_acme" >/dev/null 2>&1 || docker volume create "${STACK}_traefik_acme" >/dev/null
  if [[ ! -e "$REPO/legal/legal.env" ]]; then
    mkdir -p "$REPO/legal" && : > "$REPO/legal/legal.env" && : > "$OUT/.legal-created"
  fi
  # The private key stays OUTSIDE the directory the stub serves.
  rm -rf "$OUT/stub"; mkdir -p "$OUT/stub"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OUT/stub-key.pem" 2>/dev/null
  local spki; spki="$(openssl pkey -in "$OUT/stub-key.pem" -pubout -outform DER | openssl base64 -A | tr -d '\r')"
  printf '{"realm":"t198","public_key":"%s"}\n' "$spki" > "$OUT/stub/realm.json"
  # umask 077 above: docker cp keeps the host mode, so make the served copy
  # world-readable for whatever user the stub process runs as.
  chmod 0755 "$OUT/stub"; chmod 0644 "$OUT/stub/realm.json"
  ok "prepared ${STACK}: env file, externals, stub key, image ${IMAGE_COMPOSE} (run PHASE=names before any up)"
  printf '%s prepared %s\n' "$(now)" "$STACK" | ledger run.log
}

phase_names() {
  local names
  names="$(compose config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(c.get("name", ""))
for kind in ("networks", "volumes"):
    for k, v in (c.get(kind) or {}).items():
        print((v or {}).get("name") or k)
' | tr -d '\r')"
  [[ -n "$names" ]] || die "the state project renders nothing"
  while IFS= read -r n; do
    [[ "$n" == "${STACK}"* ]] || die "the render names a network or volume outside ${STACK}: $n"
  done <<< "$names"
  ok "names: $(wc -l <<< "$names") rendered names, every one under ${STACK}"
  : > "$OUT/.names-ok"
}

assert_no_matrix() {
  [[ -z "$(cid matrix)" ]] || die "a matrix container exists -- the database must be asserted before Synapse's first boot"
}

phase_initdb() {
  need_names
  assert_no_matrix
  compose up -d --no-deps --no-build messaging-postgres >/dev/null
  wait_health "$(cid messaging-postgres)" healthy 120 || die "messaging-postgres is not healthy after 120 s"
  local row sup
  row="$(psql_pg "SELECT datcollate || '|' || datctype || '|' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'synapse'")"
  sup="$(psql_pg "SELECT rolsuper FROM pg_roles WHERE rolname = 'synapse'")"
  printf 'initdb: %s rolsuper=%s\n' "${row:-<no row>}" "${sup:-<no role>}" | ledger initdb.log
  [[ "$row" == "C|C|synapse" ]] || die "synapse database is '${row:-<no row>}', want C|C|synapse"
  [[ "$sup" == "f" ]] || die "the synapse role's rolsuper is '${sup:-<no role>}', want f"
  ok "initdb: C|C|synapse, synapse is not a superuser"
}

phase_a() {
  need_names
  assert_no_matrix
  [[ -n "$(running_cid messaging-postgres)" ]] || die "messaging-postgres is not running (PHASE=initdb first)"
  local row major
  row="$(psql_pg "SELECT datcollate, datctype, pg_get_userbyid(datdba) FROM pg_database WHERE datname='synapse'")"
  major="$(psql_pg "SELECT current_setting('server_version_num')::int / 10000")"
  local others mx
  others="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" | wc -l | tr -d ' ')"
  mx="$(cid matrix | wc -l | tr -d ' ')"
  printf '%s a: %s major=%s running-containers=%s matrix-containers=%s\n' "$(now)" "$row" "$major" "$others" "$mx" | ledger a.log
  [[ "$mx" == "0" ]] || die "7a: $mx matrix container(s) exist"
  [[ "$row" == "C|C|synapse" ]] || die "7a: '$row', want C|C|synapse"
  [[ "$major" == "18" ]] || die "7a: major $major, want 18"
  [[ "$others" == "1" ]] || die "7a: $others running containers in ${PROJECT}, want messaging-postgres alone"
  ok "7a: only messaging-postgres runs, no matrix container exists: C|C|synapse on 18"
}

# The IdP stub: python's http.server in the synapse image on ${STACK}_state,
# serving realm.json. The file is copied in (docker cp) rather than
# bind-mounted, so no host path has to survive a Windows path translation.
stub_up() {
  docker rm -f "$STUB" >/dev/null 2>&1 || true
  docker create --name "$STUB" --network "${STACK}_state" --entrypoint python3 \
    "$IMAGE_LOCAL" -m http.server 8080 --directory /stub >/dev/null
  docker cp "$OUT/stub/." "$STUB:/stub" >/dev/null
  docker start "$STUB" >/dev/null
  local end=$((SECONDS + 30)) body=''
  while (( SECONDS < end )); do
    body="$(docker exec "$STUB" python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8080/realm.json", timeout=3).read().decode())' 2>/dev/null || true)"
    [[ "$body" == *'"public_key"'* ]] && return 0
    sleep 2
  done
  die "the IdP stub does not serve realm.json after 30 s"
}

phase_b() {
  need_names
  stub_up
  local t0 c t1 users rss
  t0="$(date +%s)"
  compose up -d --no-build matrix >/dev/null
  c="$(cid matrix)"; [[ -n "$c" ]] || die "no matrix container after up"
  wait_health "$c" healthy 150 || { docker logs "$c" 2>&1 | tail -40 >&2; die "7b: matrix is $(health "$c"), not healthy, after 150 s"; }
  t1="$(date +%s)"
  # The rendered config holds secrets: parsed from a pipe, never written out.
  docker exec "$c" cat /data/homeserver.yaml | python3 -c '
import sys, yaml
text = sys.stdin.read()
c = yaml.safe_load(text)
assert c["database"]["name"] == "psycopg2", c["database"]["name"]
assert c["server_name"] == sys.argv[1], c["server_name"]
assert c["database"]["args"]["dbname"] == "synapse"
assert "sqlite3" not in text and "homeserver.db" not in text
assert c["jwt_config"]["enabled"] is True and c["jwt_config"]["secret"].startswith("-----BEGIN PUBLIC KEY-----")
print("render:", c["database"]["name"], c["server_name"], c["database"]["args"]["dbname"])
' "$STACK.example.org" || die "7b: the rendered config is not the PostgreSQL one"
  docker exec "$c" sh -c 'test ! -e /data/homeserver.db' || die "7b: /data/homeserver.db exists"
  users="$(psql_pg "SELECT to_regclass('public.users') IS NOT NULL" synapse)"
  [[ "$users" == "t" ]] || die "7b: public.users does not exist in the synapse database"
  rss="$(docker stats --no-stream --format '{{.MemUsage}}' "$c" | tr -d '\r')"
  printf '%s b: healthy after %ss (SYNAPSE_KC_MAX=3), render psycopg2 %s.example.org synapse, no homeserver.db, public.users present, RSS %s\n' \
    "$(now)" "$((t1 - t0))" "$STACK" "$rss" | ledger b.log
  ok "7b: healthy after $((t1 - t0)) s; psycopg2, no SQLite, public.users present; RSS ${rss}"
}

phase_c1() {
  need_names
  local c since t0
  c="$(cid matrix)"; [[ -n "$c" ]] || die "no matrix container (PHASE=b first)"
  [[ "$(health "$c")" == healthy ]] || die "7c1: matrix is $(health "$c"); c1 starts from the healthy matrix of PHASE=b"
  docker rm -f "$STUB" >/dev/null 2>&1 || true
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; t0="$(date +%s)"
  docker restart "$c" >/dev/null
  printf '%s %s\n' "$since" "$t0" > "$OUT/c.since"
  # SYNAPSE_KC_MAX=3 fetch attempts of ~7 s, then the entrypoint degrades.
  wait_log "$c" "$since" 'jwt_config disabled' 150 || die "7c1: no 'jwt_config disabled' in the log within 150 s of the restart"
  printf '%s c1: stub stopped, matrix restarted at %s -> "jwt_config disabled"; health=%s\n' "$(now)" "$since" "$(health "$c")" | ledger c.log
  ok "7c1: 'jwt_config disabled' after the restart at ${since}; run PHASE=c2 (unhealthy only after start_period 240 s + 3 x 15 s)"
}

phase_c2() {
  need_names
  local c since t0 s='' end elapsed old new
  c="$(cid matrix)"; [[ -n "$c" ]] || die "no matrix container (PHASE=b first)"
  [[ -f "$OUT/c.since" ]] || die "run PHASE=c1 first"
  read -r since t0 < "$OUT/c.since"
  # 100 s of polling: on the loaded Windows gate box one docker call has cost
  # up to ~30 s and the phase's other calls ~60 s, and a 170 s poll ran the
  # call to 245 s (measured, round 2).
  end=$((SECONDS + 100))
  while (( SECONDS < end )); do
    s="$(health "$c")"
    [[ "$s" == unhealthy ]] && break
    [[ "$s" == healthy ]] && die "7c2: matrix reads healthy with the IdP down -- the probe does not see the missing JWT flow"
    sleep 5
  done
  elapsed=$(( $(date +%s) - t0 ))
  if [[ "$s" != unhealthy ]]; then
    (( elapsed < 900 )) || die "7c2: matrix is ${s} ${elapsed} s after the restart, want unhealthy (start_period 240 s + 3 x 15 s)"
    echo "[synapse-proof] PENDING: 7c2: matrix is ${s} ${elapsed} s after the restart at ${since}; unhealthy needs start_period 240 s + 3 x 15 s -- run PHASE=c2 again" >&2
    exit 3
  fi
  grep -q 'jwt_config disabled' <<< "$(docker logs --since "$since" "$c" 2>&1)" || die "7c2: no 'jwt_config disabled' in the log since the restart"
  set +e
  docker exec "$c" curl -sf --max-time 5 http://127.0.0.1:8008/_matrix/client/versions >/dev/null; old=$?
  docker exec "$c" /synapse-healthcheck.sh > "$OUT/c-probe.txt" 2>&1; new=$?
  set -e
  printf '%s c2: stub stopped -> "jwt_config disabled"; health=%s %ss after the restart; old probe (/versions) exit %s; new probe exit %s: %s\n' \
    "$(now)" "$(health "$c")" "$elapsed" "$old" "$new" "$(tr '\r\n' '  ' < "$OUT/c-probe.txt")" | ledger c.log
  [[ "$old" == 0 ]] || die "7c2: the old probe did not exit 0 (exit $old) -- the RED comparison is void"
  [[ "$new" != 0 ]] || die "7c2: the new probe exited 0 with jwt_config disabled"
  grep -q 'org.matrix.login.jwt is not offered' "$OUT/c-probe.txt" || die "7c2: the probe failed for another reason than the missing JWT flow"
  ok "7c2: unhealthy ${elapsed} s after the restart with the IdP down, while the old /versions probe exits 0"
}

phase_d1() {
  need_names
  local c since logs
  c="$(cid matrix)"; [[ -n "$c" ]] || die "no matrix container (PHASE=b first)"
  docker stop "$c" >/dev/null
  psql_pg "DROP DATABASE IF EXISTS synapse" >/dev/null
  psql_pg "CREATE DATABASE synapse OWNER synapse" >/dev/null
  printf '%s d1: recreated bare: %s\n' "$(now)" "$(psql_pg "SELECT datcollate||'|'||datctype FROM pg_database WHERE datname='synapse'")" | ledger d.log
  stub_up
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker start "$c" >/dev/null
  wait_log "$c" "$since" "datcollate is 'en_US.utf8'" 90 || true
  # A grace for anything a (wrongly) passing preflight would start.
  sleep 10
  logs="$(docker logs --since "$since" "$c" 2>&1)"
  docker stop "$c" >/dev/null
  { grep '\[db-preflight\]' <<< "$logs" || true; } | ledger d.log
  grep -q "datcollate is 'en_US.utf8'" <<< "$logs" || die "7d1: the preflight did not name en_US.utf8"
  if grep -qE 'Synapse now listening|Setting up server|synapse\.app\.homeserver' <<< "$logs"; then die "7d1: Synapse started on the bare database"; fi
  [[ "$(psql_pg "SELECT to_regclass('public.users') IS NULL" synapse)" == "t" ]] || die "7d1: Synapse wrote its schema into the bare database"
  ok "7d1: the preflight names en_US.utf8 and Synapse never started; matrix stopped (${SECONDS} s) -- run PHASE=d2 to restore the C database"
}

phase_d2() {
  need_names
  local c row
  c="$(cid matrix)"
  if [[ -n "$c" ]]; then docker stop "$c" >/dev/null; fi
  psql_pg "DROP DATABASE IF EXISTS synapse" >/dev/null
  psql_pg "CREATE DATABASE synapse OWNER synapse TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'" >/dev/null
  row="$(psql_pg "SELECT datcollate || '|' || datctype || '|' || datlocprovider::text FROM pg_database WHERE datname = 'synapse'")"
  printf '%s d2: restored %s\n' "$(now)" "$row" | ledger d.log
  [[ "$row" == "C|C|c" ]] || die "7d2: the restored database is '$row', want C|C|c"
  ok "7d2: the synapse database is restored C|C (libc); matrix stays stopped"
}

phase_e() {
  need_names
  compose up -d --no-deps --no-build postgres >/dev/null
  wait_health "$(cid postgres)" healthy 120 || die "the kernel postgres is not healthy"
  local v u
  v="$(psql_pg "SELECT current_setting('server_version_num')")"
  u="$(psql_pg "SELECT uuid_extract_version(uuidv7())")"
  printf '%s e: messaging-postgres server_version_num=%s uuidv7 version=%s\n' "$(now)" "$v" "$u" | ledger e.log
  [[ "${v:0:2}" == "18" && "$u" == "7" ]] || die "7e: server_version_num $v / uuid version $u"
  # The kernel's running check, when the caller names it (the Makefile passes
  # it as $3, so this script names nothing outside modules/messaging/).
  local running="${3:-}"
  if [[ -n "$running" ]]; then
    running="$(hostpath "$running")"
    node "$running" --project "$PROJECT" --profile messaging 2>&1 | ledger e.log
    [[ "${PIPESTATUS[0]}" == 0 ]] || die "7e: $running refused the running stack"
    ok "7e: messaging-postgres runs 18 ($v); the kernel running check passed"
  else
    ok "7e: messaging-postgres runs 18 ($v); the kernel running check was NOT run (no path passed)"
  fi
}

phase_f() {
  local vols
  vols="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" | tr -d '\r' | sort)"
  printf '%s f: %s\n' "$(now)" "$(tr '\n' ' ' <<< "$vols")" | ledger f.log
  grep -qx "${PROJECT}_messaging-pg-data" <<< "$vols" || die "7f: ${PROJECT}_messaging-pg-data does not carry the project label"
  grep -qx "${PROJECT}_synapse-data" <<< "$vols" || die "7f: ${PROJECT}_synapse-data does not carry the project label"
  ok "7f: both data volumes carry com.docker.compose.project=${PROJECT}"
}

phase_teardown() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}")"
  if [[ -n "$ids" ]]; then xargs docker rm -f <<< "$ids" >/dev/null; fi
  docker rm -f "$STUB" >/dev/null 2>&1 || true
  docker network rm "${STACK}_state" "${STACK}_edge" >/dev/null 2>&1 || true
  local v
  for v in $(docker volume ls -q | tr -d '\r' | grep "^${STACK}" || true); do docker volume rm "$v" >/dev/null; done
  docker image rm "$IMAGE_COMPOSE" >/dev/null 2>&1 || true
  docker image rm "$IMAGE_LOCAL" >/dev/null 2>&1 || true
  if [[ -f "$OUT/.legal-created" ]]; then rm -f "$REPO/legal/legal.env" "$OUT/.legal-created"; fi
  rm -f "$OUT/.names-ok" "$OUT/c.since"
  local left
  left="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}"; docker ps -aq --filter "name=^${STUB}\$";
          docker network ls -q --filter "name=^${STACK}_"; docker volume ls -q | tr -d '\r' | grep "^${STACK}" || true;
          docker image ls -q "$IMAGE_LOCAL"; docker image ls -q "$IMAGE_COMPOSE")"
  [[ -z "$left" ]] || die "teardown: resources under ${STACK} remain: $(tr '\n' ' ' <<< "$left")"
  ok "teardown: ${STACK} containers, networks, volumes, the compose image tag and the built image removed"
}

case "$PHASE" in
  prepare) phase_prepare ;;
  names) phase_names ;;
  initdb) phase_initdb ;;
  a) phase_a ;;
  b) phase_b ;;
  c1) phase_c1 ;;
  c2) phase_c2 ;;
  d1) phase_d1 ;;
  d2) phase_d2 ;;
  e) phase_e "$@" ;;
  f) phase_f ;;
  teardown) phase_teardown ;;
  *) die "unknown phase '$PHASE' (prepare names initdb a b c1 c2 d1 d2 e f teardown)" ;;
esac
