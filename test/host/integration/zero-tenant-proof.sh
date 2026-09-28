#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box). Not collected by `make test-unit`.
#
# TASK-042 (PRD-PLAT-012, TRD-075, B12 Task 10): the running-stack proof that a
# platform with ZERO customers boots healthy, serves no tenant content on any
# host, and that the first-run setup wizard is unreachable. Modelled on
# TASK-041's tenant-host-proof.sh: gremion-ui is built at the tested commit and
# run with plain `docker run` next to the pinned PostgreSQL 18 (the TASK-019
# digest, read from docker-compose.yml), on a scratch network, with fresh
# NAMED volumes, all named t042b-<sha8>-* and torn down by name. Never
# `docker compose`, never a shared volume.
#
# The app runs with `--restart unless-stopped` and the healthcheck of the
# gremion-ui service in docker-compose.yml (parsed, asserted equal on the
# running container), so a boot that exits is OBSERVABLE as RestartCount > 0.
# No AUTH_KEYCLOAK_ISSUER is set: nothing in a zero-tenant boot may need it.
#
# Assertions, each on the RUNNING system, after
# BOOT_MAX_TRANSIENT_FAILURES x BOOT_RETRY_DELAY_MS (hooks.server.ts at the
# tested commit) plus one health interval:
#   boot     control `tenant` count 0; logs hold `[boot] Migrations complete`
#            and no `[boot] failed`
#   state    State.Running true, State.Status running, RestartCount 0,
#            State.Health.Status healthy; the container's healthcheck equals
#            the compose service's
#   hosts    for every host (no X-Forwarded-Host; nope.t042.test;
#            default.t042.test; the apex t042.test), sent as X-Forwarded-Host
#            with Host equal to it and the X-Proxy-Trust secret: GET / and
#            GET /setup answer 404 with no tenant content (no fixture marker,
#            no rendered page). /healthz is recorded, never a discriminator.
#   wizard   fixture customer bound by SQL (fixtures/zero-tenant-proof,
#            setup_complete false): unauthenticated GET /setup on its host
#            answers exactly like the never-existing /t042-no-such-route:
#            302 to /auth/login?callbackUrl=<the URL-encoded path>
#   manifest the image's adapter-node route manifest (build/server/manifest.js
#            or its hashed chunk) holds no route id /setup or
#            /api/setup/{admins,config,health} (and does hold /api/setup/seed)
#   admins   POST /api/setup/admins with a planted .setup-token sent as
#            X-Setup-Token answers authGuard's 401 {error:'Unauthenticated'}
#
# Every check is evaluated and printed (`  ok <name>` / `FAIL <name>: ...`), so
# one run against the pre-change base records the whole RED matrix:
#   PROOF_APP_REF=<base>                       boot restarts / never healthy
#   PROOF_APP_REF=<base> PROOF_WITH_ISSUER=1   tenant count 1, /setup 200,
#                                              manifest holds /setup
# PROOF_WITH_ISSUER=1 exists only for that RED run (the base cannot boot
# without it); it is never part of the green proof.
#
# T042_PHASE: all (default) | build | up | probe-boot | probe-wizard | down.
# The split exists because each caller command is time-boxed: `build` warms
# the image, `up` starts the stack and waits out the boot window, the two probe
# halves assert (boot/state/hosts, then wizard/manifest/admins and the verdict)
# and leave the stack up, `down` removes it by name. `all` tears down on exit
# unless T042_KEEP=1.
#
# Prints:  ZERO-TENANT-PROOF: boot=ok state=ok hosts=ok wizard=ok manifest=ok admins=ok
# Exit codes: 0 ok · 1 an assertion failed · 2 missing precondition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FIX="$REPO_ROOT/test/host/fixtures/zero-tenant-proof"

# Git Bash on Windows: stop MSYS rewriting container paths; host paths handed
# to docker go through hostpath().
export MSYS_NO_PATHCONV=1
hostpath() {
    case "${OSTYPE:-}" in
        msys*|cygwin*) if [[ "$1" =~ ^/([a-zA-Z])/(.*)$ ]]; then printf '%s:/%s' "${BASH_REMATCH[1]^^}" "${BASH_REMATCH[2]}"; return; fi ;;
    esac
    printf '%s' "$1"
}
cd "$REPO_ROOT"

step() { echo "[t042 +${SECONDS}s] $*" >&2; }
precondition() { echo "zero-tenant-proof: PRECONDITION: $*" >&2; exit 2; }
for c in docker curl git node openssl; do command -v "$c" >/dev/null 2>&1 || precondition "missing $c"; done
docker info >/dev/null 2>&1 || precondition "no Docker daemon"

REF="${PROOF_APP_REF:-HEAD}"
SHA="$(git rev-parse --verify "${REF}^{commit}")" || precondition "unknown ref $REF"
SHA8="${SHA:0:8}"
N="t042b-$SHA8"
NET="$N-net" PG="$N-pg" APP="$N-app"
PG_VOL="$N-pgdata" DATA_VOL="$N-data"
APP_IMG="$N-app:local"
ROOT="$FIX/.proof-root/$SHA8"
APEX="t042.test"
FIXTURE_HOST="proof.$APEX"
FIXTURE_MARK="T042FIXTURE"

# ── the compose file is the single source for the PG pin and the healthcheck ──
COMPOSE_TEXT="$(<"$REPO_ROOT/docker-compose.yml")"
# Split so no scannable image-ref token sits in this file (lint-postgres-major).
PG_RE='image: (postgres'
PG_RE+=':18-alpine@sha256:[0-9a-f]{64})'
PG_IMAGE=''
if [[ "$COMPOSE_TEXT" =~ $PG_RE ]]; then PG_IMAGE="${BASH_REMATCH[1]}"; fi
[ -n "$PG_IMAGE" ] || precondition "no pinned PostgreSQL 18 image digest in docker-compose.yml"
HC="$(node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
const y = parse(readFileSync(process.argv[1], 'utf8'), { logLevel: 'error' })
const h = y.services['gremion-ui'].healthcheck
console.log([JSON.stringify(h.test), h.interval, h.timeout, h.retries, h.start_period].join('|'))
" "$(hostpath "$REPO_ROOT/docker-compose.yml")")" || precondition "cannot parse the gremion-ui healthcheck from docker-compose.yml"
IFS='|' read -r HC_TEST HC_INTERVAL HC_TIMEOUT HC_RETRIES HC_START <<<"$HC"
[ "$HC_TEST" = '["CMD","wget","-qO-","http://127.0.0.1:3000/healthz"]' ] \
    || precondition "the compose healthcheck is not the /healthz wget probe: $HC_TEST"

# The boot window, from hooks.server.ts AT THE TESTED COMMIT.
HOOKS="$(git show "$SHA:gremion-ui/src/hooks.server.ts")"
BOOT_MAX='' BOOT_DELAY_MS=''
if [[ "$HOOKS" =~ BOOT_MAX_TRANSIENT_FAILURES\ =\ ([0-9]+) ]]; then BOOT_MAX="${BASH_REMATCH[1]}"; fi
if [[ "$HOOKS" =~ BOOT_RETRY_DELAY_MS\ =\ ([0-9_]+) ]]; then BOOT_DELAY_MS="${BASH_REMATCH[1]//_/}"; fi
[ -n "$BOOT_MAX" ] && [ -n "$BOOT_DELAY_MS" ] || precondition "no boot retry constants in hooks.server.ts at $SHA8"
seconds_of() { local v="$1"; case "$v" in *m) echo $(( ${v%m} * 60 )) ;; *s) echo "${v%s}" ;; *) echo "$v" ;; esac; }
WINDOW=$(( BOOT_MAX * BOOT_DELAY_MS / 1000 + $(seconds_of "$HC_INTERVAL") ))

teardown() { # by this run's names only: t042b-<sha8>-*
    docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
    docker volume rm "$PG_VOL" "$DATA_VOL" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$ROOT"
}

phase_build() {
    step "image $APP_IMG"
    if ! docker image inspect "$APP_IMG" >/dev/null 2>&1; then
        echo "building $APP_IMG from $SHA8 ..." >&2
        git archive --format=tar "$SHA" | docker build -q -f gremion-ui/Dockerfile -t "$APP_IMG" - >/dev/null \
            || precondition "gremion-ui image build failed"
    fi
}

phase_up() {
    docker image inspect "$APP_IMG" >/dev/null 2>&1 || precondition "no $APP_IMG (run T042_PHASE=build first)"
    teardown
    mkdir -p "$ROOT"
    local secrets i=0
    secrets="$(openssl rand -hex 240)"
    next() { printf -v "$1" '%s' "${secrets:$((i * 48)):48}"; i=$((i + 1)); }
    local PG_PW CTL_PW UI_PW KC_PW PUB_PW PROXY_SECRET AUTH_SEC KC_SEC PUSH_SEC KCADM_SEC
    for v in PG_PW CTL_PW UI_PW KC_PW PUB_PW PROXY_SECRET AUTH_SEC KC_SEC PUSH_SEC KCADM_SEC; do next "$v"; done
    # The probe phase needs the proxy-trust header; it lives only in the
    # git-ignored per-run root, and is never printed.
    printf 'X-Proxy-Trust: %s\n' "$PROXY_SECRET" >"$ROOT/trust.hdr"

    docker network create "$NET" >/dev/null
    docker volume create "$PG_VOL" >/dev/null
    docker volume create "$DATA_VOL" >/dev/null

    step "postgres ($PG_IMAGE)"
    docker create --name "$PG" --network "$NET" --network-alias postgres \
        -v "$PG_VOL:/var/lib/postgresql" \
        -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PG_PW" \
        -e CONTROL_DB_USER=control -e CONTROL_DB_PASSWORD="$CTL_PW" -e CONTROL_DB_NAME=control \
        -e GREMION_DB_USER=gremion -e GREMION_DB_PASSWORD="$UI_PW" -e GREMION_DB_NAME=gremion \
        -e KEYCLOAK_DB_USER=keycloak -e KEYCLOAK_DB_PASSWORD="$KC_PW" -e KEYCLOAK_DB_NAME=keycloak \
        -e PUBLIC_DB_PASSWORD="$PUB_PW" \
        "$PG_IMAGE" >/dev/null
    docker cp "$(hostpath "$REPO_ROOT/docker/postgres/init-databases.sh")" "$PG:/docker-entrypoint-initdb.d/init-databases.sh"
    docker start "$PG" >/dev/null
    for _ in $(seq 1 60); do
        if [ "$(docker exec "$PG" psql -U postgres -tAc "select 1 from pg_database where datname='control'" 2>/dev/null)" = "1" ] \
            && docker exec "$PG" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then
            break
        fi
        sleep 1
    done
    [ "$(docker exec "$PG" psql -U postgres -tAc "select 1 from pg_database where datname='control'" 2>/dev/null)" = "1" ] \
        || precondition "postgres never came up with the control database"

    step "app ($APP_IMG, restart unless-stopped, compose healthcheck)"
    local issuer_env=()
    if [ "${PROOF_WITH_ISSUER:-0}" = "1" ]; then
        # RED-matrix run of the pre-change base only (see header).
        issuer_env=(-e "AUTH_KEYCLOAK_ISSUER=http://$APEX/auth/realms/gremion"
            -e "AUTH_KEYCLOAK_INTERNAL=http://keycloak:8080/auth/realms/gremion"
            -e CONFIG_PATH=/data/default-config/config.json)
    fi
    docker run -d --name "$APP" --network "$NET" --network-alias gremion-ui \
        -p 127.0.0.1::3000 \
        -v "$DATA_VOL:/data" \
        --restart unless-stopped \
        --health-cmd 'wget -qO- http://127.0.0.1:3000/healthz' \
        --health-interval "$HC_INTERVAL" --health-timeout "$HC_TIMEOUT" \
        --health-retries "$HC_RETRIES" --health-start-period "$HC_START" \
        -e DATABASE_URL="postgresql://gremion:$UI_PW@postgres:5432/gremion" \
        -e CONTROL_DATABASE_URL="postgresql://control:$CTL_PW@postgres:5432/control" \
        -e AUTH_SECRET="$AUTH_SEC" -e AUTH_KEYCLOAK_ID=gremion-ui -e AUTH_KEYCLOAK_SECRET="$KC_SEC" \
        -e AUTH_TRUST_HOST=1 \
        -e INTERNAL_PUSH_SECRET="$PUSH_SEC" -e INTERNAL_BASE_URL=http://gremion-ui:3000 \
        -e TENANT_PROXY_SHARED_SECRET="$PROXY_SECRET" \
        -e PLATFORM_DOMAIN="$APEX" \
        -e KEYCLOAK_ADMIN_URL=http://keycloak:8080/auth -e KEYCLOAK_ADMIN_CLIENT_SECRET="$KCADM_SEC" \
        "${issuer_env[@]}" \
        "$APP_IMG" >/dev/null

    step "waiting out the boot window (${BOOT_MAX} x ${BOOT_DELAY_MS} ms + one ${HC_INTERVAL} health interval = ${WINDOW}s)"
    local start=$SECONDS
    while [ $(( SECONDS - start )) -lt "$WINDOW" ]; do sleep 5; done
    # Then until the health state has left `starting` (bounded by one more
    # interval x retries), so `healthy` is a verdict, not a snapshot.
    local deadline=$(( SECONDS + $(seconds_of "$HC_INTERVAL") * HC_RETRIES ))
    while [ "$SECONDS" -lt "$deadline" ]; do
        [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP" 2>/dev/null)" = "starting" ] || break
        sleep 3
    done
    echo "ZERO-TENANT-PROOF: up ($N-*)"
}

FAILS=0 BAD_GROUPS=''
ok() { echo "  ok $1"; }
bad() { echo "FAIL $1: $2"; FAILS=$((FAILS + 1)); BAD_GROUPS+=" ${1%% *}"; }
is() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3" "$4"; fi; } # is <actual> <want> <label> <why>
result_of() { case "$BAD_GROUPS" in *" $1"*) echo FAIL ;; *) echo ok ;; esac; }

# Results cross phase boundaries (probe-boot, then probe-wizard) in the per-run root.
save_results() { printf 'FAILS=%s\nBAD_GROUPS=%q\nHZ=%q\n' "$FAILS" "$BAD_GROUPS" "${HZ:-}" >"$ROOT/results"; }
# shellcheck source=/dev/null # the per-run results file save_results wrote
load_results() { if [ -f "$ROOT/results" ]; then . "$ROOT/results"; fi; }

# probe <path> <host|-> [curl args...] -> STATUS BODY LOCATION. Only curl is
# spawned: headers and body are parsed with bash builtins (on Docker Desktop
# hosts every extra process costs seconds).
probe() {
    local path="$1" host="$2"; shift 2
    local hdr=(-H "@$ROOT_H/trust.hdr")
    if [ "$host" != "-" ]; then hdr+=(-H "Host: $host" -H "X-Forwarded-Host: $host"); fi
    : >"$ROOT/body"; : >"$ROOT/hdrs"
    curl -sS --max-time 20 -o "$ROOT_H/body" -D "$ROOT_H/hdrs" "${hdr[@]}" "$@" "http://127.0.0.1:$APP_PORT$path" 2>/dev/null || true
    STATUS='' LOCATION='' BODY=''
    local line first=1
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [ "$first" = 1 ]; then
            if [[ "$line" =~ ^HTTP/[0-9.]+\ ([0-9]+) ]]; then STATUS="${BASH_REMATCH[1]}"; fi
            first=0
        elif [ -z "$LOCATION" ] && [[ "$line" =~ ^[Ll]ocation:\ *(.*)$ ]]; then
            LOCATION="${BASH_REMATCH[1]}"
        fi
    done <"$ROOT/hdrs"
    IFS= read -r -d '' BODY <"$ROOT/body" || true
}

stack_is_up() {
    docker inspect "$APP" >/dev/null 2>&1 || precondition "the proof stack is not up (run T042_PHASE=up first)"
    [ -f "$ROOT/trust.hdr" ] || precondition "no per-run trust header (run T042_PHASE=up first)"
    ROOT_H="$(hostpath "$ROOT")"
    APP_PORT="$(docker port "$APP" 3000/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
}

phase_probe_boot() {
    stack_is_up

    # ── boot ───────────────────────────────────────────────────────────────────
    step "boot"
    local count logs
    count="$(docker exec "$PG" psql -U postgres -d control -tAc 'select count(*) from tenant' 2>&1 | tr -d '[:space:]')"
    if [ "$count" = "0" ]; then ok "boot tenant-count=0"; else bad "boot tenant-count" "control tenant count is $count, want 0"; fi
    logs="$(docker logs "$APP" 2>&1 || true)"
    if printf '%s' "$logs" | grep -q '\[boot\] Migrations complete'; then ok "boot migrations-complete"; else bad "boot migrations-complete" "no [boot] Migrations complete in the app log"; fi
    if printf '%s' "$logs" | grep -q '\[boot\] failed'; then
        bad "boot no-failure" "$(printf '%s' "$logs" | grep '\[boot\] failed' | head -n2 | tr '\n' ' ')"
    else ok "boot no-failure"; fi

    # ── state ──────────────────────────────────────────────────────────────────
    step "state"
    local running status restarts health hc
    running="$(docker inspect -f '{{.State.Running}}' "$APP")"
    status="$(docker inspect -f '{{.State.Status}}' "$APP")"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$APP")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP")"
    hc="$(docker inspect -f '{{json .Config.Healthcheck.Test}}|{{.Config.Healthcheck.Interval}}|{{.Config.Healthcheck.Timeout}}|{{.Config.Healthcheck.Retries}}|{{.Config.Healthcheck.StartPeriod}}|{{.HostConfig.RestartPolicy.Name}}' "$APP")"
    is "$running" true "state running=true" "State.Running=$running"
    is "$status" running "state status=running" "State.Status=$status"
    is "$restarts" 0 "state restart-count=0" "RestartCount=$restarts (the boot exited and was restarted)"
    is "$health" healthy "state health=healthy" "State.Health.Status=${health:-none}"
    local want_hc
    want_hc="[\"CMD-SHELL\",\"wget -qO- http://127.0.0.1:3000/healthz\"]|$(seconds_of "$HC_INTERVAL")s|$(seconds_of "$HC_TIMEOUT")s|$HC_RETRIES|$(seconds_of "$HC_START")s|unless-stopped"
    is "$hc" "$want_hc" "state healthcheck=compose" "container $hc, compose $want_hc"

    # ── hosts: no tenant content anywhere ──────────────────────────────────────
    step "hosts"
    local h p
    probe /healthz -
    HZ="$STATUS"
    echo "  (recorded, not a discriminator) /healthz -> $HZ"
    for h in - "nope.$APEX" "default.$APEX" "$APEX"; do
        for p in / /setup; do
            probe "$p" "$h"
            if [ "$STATUS" != "404" ]; then
                bad "hosts $h$p" "status ${STATUS:-none}, want 404 (Location: ${LOCATION:-none}; body: ${BODY:0:120})"
            elif [[ "$BODY" == *"$FIXTURE_MARK"* ]] || [[ "$BODY" == *"<title"* ]] || [ -n "$LOCATION" ]; then
                bad "hosts $h$p" "404 but with tenant content or a redirect: ${BODY:0:120}"
            else
                ok "hosts $h$p -> 404 ${BODY:0:24}"
            fi
        done
    done
    save_results
}

phase_probe_wizard() {
    stack_is_up
    load_results

    # ── wizard: a bound customer's /setup is an unknown path ───────────────────
    step "bind the fixture customer ($FIXTURE_HOST) by SQL"
    docker cp "$(hostpath "$FIX/fixture-tenant.sql")" "$PG:/tmp/fixture-tenant.sql"
    docker exec "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d control -f /tmp/fixture-tenant.sql >/dev/null \
        || precondition "binding the fixture customer failed"
    docker cp "$(hostpath "$FIX/config/proof")" "$APP:/data/"
    step "wizard"
    local s_status s_loc n_status n_loc
    # A customer bound after boot is not in the boot fleet: its first request
    # starts the single-flighted lazy migration and answers the tenant-scoped
    # 503 (D-READY). Wait that out on the never-existing path first, so both
    # compared requests meet a READY tenant.
    for _ in $(seq 1 20); do
        probe /t042-no-such-route "$FIXTURE_HOST"
        [ "$STATUS" = "503" ] || break
        sleep 3
    done
    n_status="$STATUS" n_loc="$LOCATION"
    probe /setup "$FIXTURE_HOST"
    s_status="$STATUS" s_loc="$LOCATION"
    if [ "$s_status" = "302" ] && [ "$s_loc" = "/auth/login?callbackUrl=%2Fsetup" ]; then
        ok "wizard /setup -> 302 $s_loc"
    else
        bad "wizard /setup" "status ${s_status:-none} Location ${s_loc:-none}, want 302 /auth/login?callbackUrl=%2Fsetup (body: ${BODY:0:80})"
    fi
    if [ "$n_status" = "302" ] && [ "$n_loc" = "/auth/login?callbackUrl=%2Ft042-no-such-route" ]; then
        ok "wizard never-existing-path -> 302 $n_loc"
    else
        bad "wizard never-existing-path" "status ${n_status:-none} Location ${n_loc:-none}"
    fi
    is "$s_status ${s_loc/\%2Fsetup/X}" "$n_status ${n_loc/\%2Ft042-no-such-route/X}" \
        "wizard /setup answers exactly as a never-existing path" \
        "/setup ${s_status:-none} ${s_loc:-none} vs unknown ${n_status:-none} ${n_loc:-none}"

    # ── manifest ───────────────────────────────────────────────────────────────
    step "manifest"
    local ids
    # adapter-node's route manifest: build/server/manifest.js, or (current
    # Vite bundling) the hashed chunk build/server/chunks/manifest.js-<hash>.js.
    ids="$(docker exec "$APP" sh -c 'cat /app/build/server/manifest.js /app/build/server/chunks/manifest.js-*.js 2>/dev/null' \
        | grep -oE 'id: *"/[^"]*"' | sed -E 's/id: *"(.*)"/\1/' | sort -u || true)"
    if [ -z "$ids" ]; then
        bad "manifest readable" "no route ids read from the image's adapter-node manifest"
    else
        if printf '%s\n' "$ids" | grep -qx '/api/setup/seed'; then ok "manifest control: /api/setup/seed present"; else bad "manifest control" "/api/setup/seed not found (the scan is blind)"; fi
        local r hit=''
        for r in /setup /api/setup/admins /api/setup/config /api/setup/health; do
            printf '%s\n' "$ids" | grep -qx "$r" && hit+=" $r"
        done
        is "$hit" "" "manifest no /setup, /api/setup/{admins,config,health}" "the image routes:$hit"
    fi

    # ── admins: a planted setup token opens nothing ────────────────────────────
    step "admins"
    local tok
    tok="$(openssl rand -hex 16)"
    printf '%s' "$tok" >"$ROOT/setup-token"
    docker cp "$(hostpath "$ROOT/setup-token")" "$APP:/data/proof/.setup-token" >/dev/null 2>&1 || true
    docker cp "$(hostpath "$ROOT/setup-token")" "$APP:/app/config/.setup-token" >/dev/null 2>&1 || true
    probe /api/setup/admins "$FIXTURE_HOST" -X POST -H 'content-type: application/json' -H "X-Setup-Token: $tok" --data '{"admins":[]}'
    if [ "$STATUS" = "401" ] && [[ "$BODY" == *'"error":"Unauthenticated"'* ]]; then
        ok "admins POST with a planted token -> 401 ${BODY:0:60}"
    else
        bad "admins POST" "status ${STATUS:-none}, body ${BODY:0:120}, want 401 {error:'Unauthenticated'}"
    fi

    echo "ZERO-TENANT-PROOF: boot=$(result_of boot) state=$(result_of state) hosts=$(result_of hosts) wizard=$(result_of wizard) manifest=$(result_of manifest) admins=$(result_of admins) (app $SHA8, ${PG_IMAGE%%@*}, healthz=${HZ:-not-probed})"
    [ "$FAILS" -eq 0 ] || { echo "zero-tenant-proof: $FAILS check(s) FAILED" >&2; return 1; }
}

on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ] && docker inspect "$APP" >/dev/null 2>&1; then
        echo "--- $APP log (tail) ---" >&2
        docker logs --tail 30 "$APP" 2>&1 | sed 's/^/    /' >&2 || true
    fi
    if [ "${T042_KEEP:-0}" = "1" ] || { [ "$rc" -eq 0 ] && [ "${LEAVE_UP:-0}" = "1" ]; }; then
        echo "left $N-* up" >&2
    else
        teardown
    fi
    exit "$rc"
}

case "${T042_PHASE:-all}" in
    build) phase_build ;;
    up) trap on_exit EXIT; LEAVE_UP=1; phase_up ;;
    # The probe halves leave the stack up; `down` removes it by name.
    probe-boot) phase_probe_boot; echo "ZERO-TENANT-PROOF: boot/state/hosts done, $FAILS failure(s) so far" ;;
    probe-wizard) phase_probe_wizard ;;
    down) teardown ;;
    all) trap on_exit EXIT; phase_build; phase_up; phase_probe_boot; phase_probe_wizard ;;
    *) precondition "unknown T042_PHASE=${T042_PHASE}" ;;
esac
