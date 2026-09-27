#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box). Not collected by `make test-unit`.
#
# TASK-041 (L3-08; PRD-PLAT-012, TRD-074/075/076): the running-stack proof of
# whole-host tenant resolution. Builds gremion-ui at the tested commit and runs
# it behind the pinned Traefik (docker-compose.yml) and the pinned PG18
# (TASK-019 digest), on a scratch network, with plain `docker create/start` and
# names unique to this run (t041-<sha8>-*), torn down by name. Never `docker
# compose`, never a shared volume: Postgres lives on a tmpfs.
#
# The edge is THIS task's fixture (test/host/fixtures/tenant-host-proof/),
# independent of TASK-034/040 merge order:
#   static   the rendered production docker/traefik/traefik.yml plus a
#            plaintext entrypoint `proof` whose trustedIPs is COPIED from
#            websecure (asserted equal below);
#   routers  t041-a       Host(a.t041.test) -> pin, proxytrust, starting
#            t041-unbound Host(t041.test)   -> proxytrust
#   customer tenant `a`, host a.t041.test bound through registry
#            addTenantDomain (bind-customer.mjs).
#
# Assertions, each on the RUNNING system (status + body + app log):
#   (a) nope.t041.test          -> Traefik 404, no A marker, no default marker,
#                                  and the app never saw it
#   (b) t041.test, no XFH       -> app 404, no marker, exactly ONE
#                                  tenant.host.rejected {ts, host=t041.test,
#                                  reason=unbound}
#   (c) from Traefik's own namespace (its trusted loopback):
#       Host t041.test + forged X-Forwarded-Host a.t041.test
#                               -> 404, no A marker, exactly ONE reason=forged
#   (d) a.t041.test             -> 302 to A's sign-in
#   (e) app stopped             -> the starting page (a build of prod
#                                  `fallback:`), not a raw 502
# plus: TENANT_PROXY_SHARED_SECRET is set in the app (docker exec env), the
# proof entrypoint trusts exactly websecure's list, and the production keycloak
# router is Host-literal on the apex (TASK-041 Q6).
#
# PROOF_APP_REF=<git ref> builds the app from another commit (default HEAD) --
# the guard-efficacy run points it at the pre-change base and watches (b) and
# (c) go RED. T041_KEEP=1 leaves the containers up for inspection.
#
# Prints:  TENANT-HOST-PROOF: a=ok b=ok c=ok d=ok e=ok
# Exit codes: 0 ok · 1 an assertion failed · 2 missing precondition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FIX="$REPO_ROOT/test/host/fixtures/tenant-host-proof"

# Git Bash on Windows: stop MSYS rewriting container paths (/app/config,
# /etc/traefik); host paths handed to docker/node go through hostpath().
export MSYS_NO_PATHCONV=1
# Pure bash (no process spawn: on Docker Desktop hosts every spawn costs ~2 s).
hostpath() {
    case "${OSTYPE:-}" in
        msys*|cygwin*) if [[ "$1" =~ ^/([a-zA-Z])/(.*)$ ]]; then printf '%s:/%s' "${BASH_REMATCH[1]^^}" "${BASH_REMATCH[2]}"; return; fi ;;
    esac
    printf '%s' "$1"
}
cd "$REPO_ROOT"

step() { echo "[t041 +${SECONDS}s] $*" >&2; }
die() { echo "tenant-host-proof: FAIL: $*" >&2; exit 1; }
precondition() { echo "tenant-host-proof: PRECONDITION: $*" >&2; exit 2; }
for c in docker curl git node pnpm openssl; do command -v "$c" >/dev/null 2>&1 || precondition "missing $c"; done
docker info >/dev/null 2>&1 || precondition "no Docker daemon"

REF="${PROOF_APP_REF:-HEAD}"
SHA="$(git rev-parse --verify "${REF}^{commit}")" || precondition "unknown ref $REF"
SHA8="${SHA:0:8}"
N="t041-$SHA8"
NET="$N-net" PG="$N-pg" APP="$N-app" FB="$N-fallback" TR="$N-traefik"
APP_IMG="$N-app:local" FB_IMG="$N-fallback:local"
ROOT="$FIX/.proof-root/$SHA8"
PROOF_PORT=8090

COMPOSE_TEXT="$(<"$REPO_ROOT/docker-compose.yml")"
# Split so no scannable image-ref token sits in this file (make lint-postgres-major
# would read the regex source as a second, empty pin); the pin itself is read
# from docker-compose.yml, the single source.
PG_RE='image: (postgres'
PG_RE+=':18-alpine@sha256:[0-9a-f]{64})'
TR_RE='image: (traefik:v[0-9.]+)'
PG_IMAGE='' TR_IMAGE=''
if [[ "$COMPOSE_TEXT" =~ $PG_RE ]]; then PG_IMAGE="${BASH_REMATCH[1]}"; fi
if [[ "$COMPOSE_TEXT" =~ $TR_RE ]]; then TR_IMAGE="${BASH_REMATCH[1]}"; fi
[ -n "$PG_IMAGE" ] || precondition "no pinned PostgreSQL 18 image digest in docker-compose.yml"
[ -n "$TR_IMAGE" ] || precondition "no pinned traefik image in docker-compose.yml"

teardown() { # by this run's names only: t041-<sha8>-*
    local ids
    ids="$(docker ps -aq --filter "name=^$N-" 2>/dev/null || true)"
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
    if docker network ls -q --filter "name=^$NET\$" | grep -q .; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
    rm -rf "$ROOT"
}
on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ] && docker inspect "$APP" >/dev/null 2>&1; then
        echo "--- $APP log (tail) ---" >&2
        docker logs --tail 40 "$APP" 2>&1 | sed 's/^/    /' >&2 || true
    fi
    if [ "${T041_KEEP:-0}" = "1" ] || { [ "$rc" -eq 0 ] && [ "${KEEP_ON_SUCCESS:-0}" = "1" ]; }; then
        echo "left $N-* up" >&2
    else
        teardown
    fi
    exit "$rc"
}
trap on_exit EXIT

# One openssl spawn for every per-run secret: 12 x 48 hex characters.
secret_into() { printf -v "$1" '%s' "${SECRETS:$((SECRET_I * 48)):48}"; SECRET_I=$((SECRET_I + 1)); }

phase_up() {
teardown # a previous aborted run of THIS commit, by name only

SECRETS="$(openssl rand -hex 288)" SECRET_I=0
for v in PG_PW CTL_PW UI_PW KC_PW PUB_PW PROXY_SECRET AUTH_SEC KC_SEC PUSH_SEC KCADM_SEC; do secret_into "$v"; done

# ── images ────────────────────────────────────────────────────────────────────
step "images"
if ! docker image inspect "$APP_IMG" >/dev/null 2>&1; then
    echo "building $APP_IMG from $SHA8 ..."
    git archive --format=tar "$SHA" | docker build -q -f gremion-ui/Dockerfile -t "$APP_IMG" - >/dev/null \
        || precondition "gremion-ui image build failed"
fi
docker build -q -t "$FB_IMG" "$(hostpath "$REPO_ROOT/docker/fallback")" >/dev/null || precondition "fallback image build failed"

docker network create "$NET" >/dev/null

# ── Postgres 18 (TASK-019 digest), init-databases.sh, tmpfs data ─────────────
step "postgres"
docker create --name "$PG" --network "$NET" --network-alias postgres -p 127.0.0.1::5432 \
    --tmpfs /var/lib/postgresql \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PG_PW" \
    -e CONTROL_DB_USER=control -e CONTROL_DB_PASSWORD="$CTL_PW" -e CONTROL_DB_NAME=control \
    -e GREMION_DB_USER=gremion -e GREMION_DB_PASSWORD="$UI_PW" -e GREMION_DB_NAME=gremion \
    -e KEYCLOAK_DB_USER=keycloak -e KEYCLOAK_DB_PASSWORD="$KC_PW" -e KEYCLOAK_DB_NAME=keycloak \
    -e PUBLIC_DB_PASSWORD="$PUB_PW" \
    "$PG_IMAGE" >/dev/null
docker cp "$(hostpath "$REPO_ROOT/docker/postgres/init-databases.sh")" "$PG:/docker-entrypoint-initdb.d/init-databases.sh"
docker start "$PG" >/dev/null
for _ in $(seq 1 60); do
    if docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null \
        && [ "$(docker exec "$PG" psql -U postgres -tAc "select 1 from pg_database where datname='control'" 2>/dev/null)" = "1" ]; then
        break
    fi
    sleep 1
done
[ "$(docker exec "$PG" psql -U postgres -tAc "select 1 from pg_database where datname='control'" 2>/dev/null)" = "1" ] \
    || precondition "postgres never came up with the control database"
docker exec "$PG" psql -q -U postgres -c "CREATE DATABASE t041a OWNER gremion" >/dev/null
PG_PORT="$(docker port "$PG" 5432/tcp | head -n1 | sed 's/.*://')"

# ── customer A: registered and bound through the registry (addTenantDomain) ──
step "bind customer A"
BIND_OUT="$(PLATFORM_DOMAIN=t041.test CONTROL_DATABASE_URL="postgresql://control:$CTL_PW@127.0.0.1:$PG_PORT/control" \
    pnpm -s -C gremion-ui exec tsx ../test/host/fixtures/tenant-host-proof/bind-customer.mjs 2>&1)" \
    || { echo "$BIND_OUT" >&2; precondition "binding customer A failed"; }
echo "$BIND_OUT" | grep -q 'T041-BIND .* host=a.t041.test' || { echo "$BIND_OUT" >&2; die "customer A not bound"; }

# ── gremion-ui at the tested commit ───────────────────────────────────────────
step "app"
docker create --name "$APP" --network "$NET" --network-alias gremion-ui \
    -e DATABASE_URL="postgresql://gremion:$UI_PW@postgres:5432/gremion" \
    -e CONTROL_DATABASE_URL="postgresql://control:$CTL_PW@postgres:5432/control" \
    -e T041_A_DATABASE_URL="postgresql://gremion:$UI_PW@postgres:5432/t041a" \
    -e AUTH_SECRET="$AUTH_SEC" -e AUTH_KEYCLOAK_ID=gremion-ui -e AUTH_KEYCLOAK_SECRET="$KC_SEC" \
    -e AUTH_KEYCLOAK_ISSUER=http://t041.test/auth/realms/gremion \
    -e AUTH_KEYCLOAK_INTERNAL=http://keycloak:8080/auth/realms/gremion \
    -e AUTH_TRUST_HOST=1 -e PUBLIC_BASE_URL=http://t041.test \
    -e INTERNAL_PUSH_SECRET="$PUSH_SEC" -e INTERNAL_BASE_URL=http://gremion-ui:3000 \
    -e TENANT_PROXY_SHARED_SECRET="$PROXY_SECRET" \
    -e KEYCLOAK_ADMIN_URL=http://keycloak:8080/auth -e KEYCLOAK_ADMIN_CLIENT_SECRET="$KCADM_SEC" \
    -e CONFIG_PATH=/app/config/config.json \
    "$APP_IMG" >/dev/null
docker cp "$(hostpath "$FIX/config/default")/." "$APP:/app/config"
docker cp "$(hostpath "$FIX/config/a")/." "$APP:/data/a"
docker start "$APP" >/dev/null

docker create --name "$FB" --network "$NET" "$FB_IMG" >/dev/null
docker start "$FB" >/dev/null

# TENANT_PROXY_SHARED_SECRET is SET in the running app (the value never printed).
[ "$(docker exec "$APP" env | grep -c '^TENANT_PROXY_SHARED_SECRET=.')" = "1" ] \
    || die "TENANT_PROXY_SHARED_SECRET is not set in $APP"

for _ in $(seq 1 90); do
    docker logs "$APP" 2>&1 | grep -q '\[boot\] Migrations complete' && break
    docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null | grep -q true || die "$APP exited during boot"
    sleep 1
done
docker logs "$APP" 2>&1 | grep -q '\[boot\] Migrations complete' || die "$APP never finished boot"

# ── Traefik: rendered production static config + the proof entrypoint ────────
step "traefik"
TRUST_LINE="$(T041_SHA8="$SHA8" T041_PROXY_SECRET="$PROXY_SECRET" T041_PROOF_PORT="$PROOF_PORT" \
    node "$(hostpath "$FIX/render-traefik.mjs")" "$(hostpath "$ROOT/etc-traefik")")"
WS="$(echo "$TRUST_LINE" | sed -n 's/^T041-TRUSTED websecure=\(.*\) proof=.*$/\1/p')"
PF="$(echo "$TRUST_LINE" | sed -n 's/^T041-TRUSTED websecure=.* proof=\(.*\)$/\1/p')"
[ -n "$WS" ] && [ "$WS" = "$PF" ] || die "proof trustedIPs ($PF) != websecure trustedIPs ($WS)"

docker create --name "$TR" --network "$NET" -p "127.0.0.1::$PROOF_PORT" \
    --tmpfs /logs --tmpfs /letsencrypt \
    "$TR_IMAGE" --configFile=/etc/traefik/traefik.yml >/dev/null
docker cp "$(hostpath "$ROOT/etc-traefik")/." "$TR:/etc/traefik"
docker start "$TR" >/dev/null
for _ in $(seq 1 60); do
    R="$(docker exec "$TR" wget -qO- http://127.0.0.1:8080/api/http/routers 2>/dev/null || true)"
    case "$R" in *'t041-a@file'*'t041-unbound@file'*|*'t041-unbound@file'*'t041-a@file'*) break ;; esac
    sleep 1
done
case "$R" in *'t041-a@file'*) ;; *) die "Traefik never registered the proof routers" ;; esac
TR_PORT="$(docker port "$TR" "$PROOF_PORT/tcp" | head -n1 | sed 's/.*://')"

# ── the production keycloak router is Host-literal on the apex (Q6) ──────────
step "keycloak rule"
KC_RULE="$(node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
const y = parse(readFileSync(process.argv[1], 'utf8'), { logLevel: 'error' })
const l = (y.services.keycloak.labels || []).find((s) => s.startsWith('traefik.http.routers.keycloak.rule='))
console.log(l ? l.slice(l.indexOf('=') + 1) : '')
" "$(hostpath "$REPO_ROOT/docker-compose.prod.yml")")"
case "$KC_RULE" in
    'Host(`${DOMAIN}`) && '*) case "$KC_RULE" in *HostRegexp*) die "keycloak rule has a HostRegexp leg: $KC_RULE" ;; esac ;;
    *) die "keycloak rule is not Host-literal on the apex: $KC_RULE" ;;
esac

}

# ── probes ────────────────────────────────────────────────────────────────────
phase_probe() {
docker inspect "$TR" >/dev/null 2>&1 || precondition "the proof stack is not up (run with T041_PHASE=up first)"
TR_PORT="$(docker port "$TR" "$PROOF_PORT/tcp" | head -n1 | sed 's/.*://')"
A_MARK='T041CUSTA' D_MARK='T041DFLT'
probe() { # probe <host> [extra curl args...] -> sets STATUS BODY HDRS
    local host="$1"; shift
    HDRS="$(curl -sS -o "$(hostpath "$ROOT/body")" -D - -H "Host: $host" "$@" "http://127.0.0.1:$TR_PORT/" | tr -d '\r')"
    STATUS="$(printf '%s\n' "$HDRS" | sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p')"
    BODY="$(cat "$ROOT/body")"
}
no_marker() { # no_marker <label>
    case "$BODY" in *"$A_MARK"*|*"$D_MARK"*) die "$1: tenant content in body" ;; esac
    printf '%s\n' "$HDRS" | grep -qi '^location:' && die "$1: a redirect (tenant flow) where none may be" || true
}
events() { docker logs "$APP" 2>&1 | grep '"msg":"tenant.host.rejected"' || true; }

mkdir -p "$ROOT"

# (a) an unregistered host: no router -> Traefik's own 404; the app never sees it.
step "probe (a)"
probe nope.t041.test
[ "$STATUS" = "404" ] || die "(a) nope.t041.test: status $STATUS, want 404"
no_marker "(a)"
events | grep -q 'nope.t041.test' && die "(a) the app saw nope.t041.test (want Traefik's no-router 404)"
RESULT_A=ok; echo "  (a) $STATUS ${BODY:0:40}"

# (b) the unbound host, no X-Forwarded-Host, from the host: app 404 + one event.
step "probe (b)"
probe t041.test
[ "$STATUS" = "404" ] || die "(b) t041.test: status $STATUS, want 404"
no_marker "(b)"
[ "$BODY" = "Not Found" ] || die "(b) body is not the app's 404: $BODY"
B_EVENTS="$(events | grep '"host":"t041.test"' || true)"
[ "$(printf '%s' "$B_EVENTS" | grep -c . || true)" = "1" ] || die "(b) want exactly one tenant.host.rejected for t041.test, got: ${B_EVENTS:-none}"
printf '%s' "$B_EVENTS" | grep -q '"reason":"unbound"' || die "(b) reason is not unbound: $B_EVENTS"
printf '%s' "$B_EVENTS" | grep -Eq '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z"' || die "(b) no RFC 3339 ts: $B_EVENTS"
RESULT_B=ok; echo "  (b) 404 + $B_EVENTS"

# (c) a forged X-Forwarded-Host naming customer A, from Traefik's trusted loopback.
step "probe (c)"
C_OUT="$(docker exec "$TR" wget -S -O- --header 'Host: t041.test' --header 'X-Forwarded-Host: a.t041.test' \
    "http://127.0.0.1:$PROOF_PORT/" 2>&1 || true)"
printf '%s\n' "$C_OUT" | grep -q 'HTTP/1.1 404' || die "(c) want 404, got: $C_OUT"
case "$C_OUT" in *"$A_MARK"*|*'ocation:'*) die "(c) customer A answered a forged X-Forwarded-Host: $C_OUT" ;; esac
C_EVENTS="$(events | grep '"reason":"forged"' || true)"
[ "$(printf '%s' "$C_EVENTS" | grep -c . || true)" = "1" ] || die "(c) want exactly one reason=forged line, got: ${C_EVENTS:-none}"
printf '%s' "$C_EVENTS" | grep -q '"host":"a.t041.test"' || die "(c) forged line does not name a.t041.test: $C_EVENTS"
RESULT_C=ok; echo "  (c) 404 + $C_EVENTS"

# (d) customer A on its bound host: the app answers with A's sign-in redirect.
step "probe (d)"
probe a.t041.test
[ "$STATUS" = "302" ] || die "(d) a.t041.test: status $STATUS, want 302 (body: ${BODY:0:200})"
LOC="$(printf '%s\n' "$HDRS" | sed -n 's/^[Ll]ocation: *//p' | head -n1)"
case "$LOC" in *'/auth/'*) ;; *) die "(d) redirect is not to the sign-in: $LOC" ;; esac
case "$LOC" in http*://*) case "$LOC" in http*://a.t041.test/*) ;; *) die "(d) redirect leaves A's host: $LOC" ;; esac ;; esac
RESULT_D=ok; echo "  (d) $STATUS Location: $LOC"

# (e) the app stopped: the starting page (the errors middleware), not a raw 502.
step "probe (e)"
docker stop -t 5 "$APP" >/dev/null
probe a.t041.test
case "$BODY" in *'Gremion is starting'*) ;; *) die "(e) want the starting page, got $STATUS: ${BODY:0:200}" ;; esac
case "$BODY" in *'Bad Gateway'*) die "(e) a raw 502 body leaked" ;; esac
RESULT_E=ok; echo "  (e) $STATUS starting page"

echo "TENANT-HOST-PROOF: a=$RESULT_A b=$RESULT_B c=$RESULT_C d=$RESULT_D e=$RESULT_E (app $SHA8, $TR_IMAGE, ${PG_IMAGE%%@*})"
}

# T041_PHASE: all (default) | up (build + start, leave running) | probe (assert
# against a running `up`, then tear down) | down. The split exists for callers
# whose single command is time-boxed: on Docker Desktop the whole run takes ~5 min.
case "${T041_PHASE:-all}" in
    all) phase_up; phase_probe ;;
    up) phase_up; KEEP_ON_SUCCESS=1; echo "TENANT-HOST-PROOF: up ($N-*)" ;;
    probe) phase_probe ;;
    down) ;;
    *) precondition "unknown T041_PHASE=${T041_PHASE}" ;;
esac
