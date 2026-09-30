#!/usr/bin/env bash
# ============================================================
# customer-provision-proof.sh — TASK-043's RUNNING proof (brief section 1).
#
#   bash test/host/integration/customer-provision-proof.sh <phase>...
#
# Every phase is its own call (no single step outlives a supervisor's time
# box); state lives under ${OUT} (.scratch/, gitignored). STACK=t043-<sha8>
# names every container, network, volume and image tag this script creates;
# teardown removes them BY NAME. It never runs `docker compose down`, never
# prunes, never touches a gremion_* volume or a resource outside ${STACK}.
#
# PANEL (section 11, R29-I3, [D R29-I11]; TDD 15, 17b, 22):
#   panel-image    the control-panel image at the tested SHA (docker build)
#   panel-up       scratch Keycloak + control PostgreSQL (gremion-ui's control
#                  chain, one fixture customer, a SELECT-only reader)
#   panel-realm    the ops realm through `gremion-tenant init --realm-only
#                  --keycloak-container` (--panel-origin https://${PANEL_HOST});
#                  an operator through `gremion-tenant operator add --no-mail
#                  --keycloak-container` (section 11 steps 2-3)
#   panel-start    the panel from compose/control-panel/standalone.yml itself
#   panel-login    a REAL sign-in of that operator (temporary password,
#                  UPDATE_PASSWORD, CONFIGURE_TOTP with a computed TOTP) through
#                  the panel's loopback port with Host: ${PANEL_HOST}
#   panel-verify   test/host/integration/panel-verify.sh against the running
#                  panel: anonymous -> ops realm, customer iss / forged cookie
#                  403, foreign Host refused, loa1 -> step-up, loa2 200 with
#                  gremion-ui's CSP, the client's exact redirect URIs
#   panel-gate     TDD 15 on the running panel: a signed session whose iss is a
#                  customer realm is 403 on a page, a form action and a +server
#                  endpoint; an ops session without the operator role is 403
#   panel-isolated TDD 17b: the port binds 127.0.0.1 only (docker inspect);
#                  read-only rootfs, no capability; the HEALTHCHECK stays
#                  healthy with Keycloak and PostgreSQL stopped
#   panel-down     everything panel-up created, by name
#   (PROOF_STACK=t043-<sha8> names a panel run whose HEAD has moved since.)
#
# CUSTOMER (section 1): run against a RUNNING pooled stack -- this script
# never brings one up. Either a scratch stack from pooled-stack-proof.sh
# (POOLED_STACK + POOLED_ENV_DIR; customer-layout lays its GREMION_ROOT out
# like a host's) or a host after TASK-038's re-init (PROOF_GREMION_ROOT=/opt/gremion,
# POOLED_STACK=<stack>, POOLED_ENV_DIR=/opt/gremion/etc/env). The operator id
# of every mutating verb is PROOF_OPERATOR_ID (a platform-realm user id).
#   customer-layout  scratch only: etc/env, runtime/active-colour, etc/edge
#   customer-before  TRD-440 baseline (running containers, every project's
#                    config --services), pg_database lists, no gremion_platform
#   customer-create  `--enable board` refused by name before any write; then
#                    `gremion-tenant create proof-x --enable calendar,vault` and a
#                    second customer proof-y; every section 1 "Create" line
#   customer-rerun   a second create: phase A and B run nothing, the broker is
#                    not reloaded, the ledger and the database lists unchanged
#   customer-suspend suspend proof-x: status, realm disabled, the tenant host
#                    503 through the edge, broker module users evicted, the
#                    principal revoked; proof-y untouched
#   customer-resume  every one of those restored (a fresh principal)
#   customer-reconcile reconcile green; a planted platform@ sender fails
#                    smtp-server; --apply repairs; check-principals --no-allowances
#   customer-after   TRD-440: the container set and the services unchanged
# The first-administrator sign-in through the execute-actions mail needs a
# mailbox the proof can read on the vendor mail server; it is verified on the
# host (TASK-038, a real browser), not here.
#
# Every assertion reads a post-condition (docker inspect, an HTTP status and
# header, a database row, a Keycloak read-back), never an exit code alone.
# Zero checks run is a FAILURE. Secrets live in 0600 files under ${OUT};
# none reaches an argv of this script's children or its output.
# ============================================================
set -euo pipefail
# Git Bash: docker's container paths must not be rewritten, but a global
# MSYS_NO_PATHCONV also stops curl.exe's `-o /dev/null` from being mapped (curl
# exit 23). So only docker (and the gremion-tenant child) get it.
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT_H="$(host_path "$ROOT")"
if [[ -n "${PROOF_STACK:-}" ]]; then STACK="$PROOF_STACK"
else STACK="t043-$(git -C "$ROOT_H" rev-parse --short=8 HEAD)"; fi
OUT="${PROOF_OUT:-${ROOT}/.scratch/customer-provision-proof/${STACK}}"
SROOT="${OUT}/root"                       # the scratch GREMION_ROOT
PANEL_HOST="${PROOF_PANEL_HOST:-panel.proof.test}"
OPERATOR_EMAIL="ops@panel.proof.test"
PG_IMAGE="postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
KC_IMAGE="quay.io/keycloak/keycloak:26.6.1@sha256:dea26401d06341095cc4ea9d66896200b55de5ca1daa1d2fcbe58493afa6e0ad"
PANEL_IMAGE="ghcr.io/hello-n00del/gremion-control-panel:${STACK}"
NET="${STACK}-net"

RED=0
CHECKS=0
ok()   { printf '  ok   %s\n' "$*"; CHECKS=$(( CHECKS + 1 )); }
bad()  { printf '  FAIL %s\n' "$*" >&2; RED=1; CHECKS=$(( CHECKS + 1 )); }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
info() { printf '[customer-proof] %s\n' "$*"; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
ledger() { mkdir -p "$OUT/ledger"; cat >> "$OUT/ledger/$1"; }
gen()  { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
secret_file() { # <name> -- stdin to a 0600 file under ${OUT}/secrets
    mkdir -p "$OUT/secrets"; chmod 700 "$OUT/secrets" 2>/dev/null || true
    ( umask 077; cat > "$OUT/secrets/$1" )
}

command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"
command -v curl >/dev/null || die "curl not on PATH"

require_scratch() { [[ "$STACK" == t043-* ]] || die "phase '$1' creates or removes resources and runs only on a t043-* scratch stack (STACK=$STACK)"; }

free_port() {
    local c
    for _ in $(seq 1 200); do
        c=$(( 30000 + RANDOM % 10000 ))
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$c") 2>/dev/null \
           && ! docker ps --format '{{.Ports}}' | grep -q ":$c->"; then
            printf '%s' "$c"; return 0
        fi
    done
    die "no free port in 30000-39999"
}

# The per-run facts (ports; never a secret), written by panel-up.
state_set() { mkdir -p "$OUT"; printf '%s=%s\n' "$1" "$2" >> "$OUT/state.env"; }
state_get() { [[ -f "$OUT/state.env" ]] || die "no ${OUT}/state.env: run panel-up first"; sed -n "s/^$1=//p" "$OUT/state.env" | tail -n1; }

wait_http() { # <url> <seconds> [curl args...]
    local url="$1" max="$2" s=0; shift 2
    while (( s < max )); do
        curl -fsS -o /dev/null --max-time 5 "$@" "$url" 2>/dev/null && return 0
        sleep 3; s=$(( s + 3 ))
    done
    return 1
}
wait_health() { # <container> <seconds>
    local c="$1" max="$2" s=0 h
    while (( s < max )); do
        h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo gone)"
        [[ "$h" == healthy ]] && return 0
        [[ "$h" == gone || "$h" == exited || "$h" == dead ]] && return 1
        sleep 3; s=$(( s + 3 ))
    done
    return 1
}

# gremion-tenant against the scratch root and the release = this worktree.
gremion_tenant() {
    # Host-form paths: under MSYS_NO_PATHCONV a native jq.exe cannot open /c/...
    MSYS_NO_PATHCONV=1 GREMION_ROOT="$(host_path "$SROOT")" GREMION_RELEASE_DIR="$ROOT_H" KC_SERVER_URL="http://127.0.0.1:8080/auth" \
        KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD="$(cat "$OUT/secrets/kc-admin")" \
        bash "$ROOT/infra/host/bin/gremion-tenant" "$@"
}
kcadm() { docker exec "${STACK}-kc" /opt/keycloak/bin/kcadm.sh "$@"; }
kc_login() {
    KC_LOGIN_PASSWORD="$(cat "$OUT/secrets/kc-admin")" docker exec -e KC_LOGIN_PASSWORD "${STACK}-kc" sh -c \
        '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user admin --password "$KC_LOGIN_PASSWORD" >/dev/null'
}
session() { node "$ROOT_H/test/host/fixtures/customer-provision/panel-session.mjs" "$@"; }
panel_url() { printf 'http://127.0.0.1:%s' "$(state_get PANEL_PORT)"; }
panel_cid() { docker ps -q --filter "label=com.docker.compose.project=${STACK}-panel" --filter "label=com.docker.compose.service=control-panel" | head -n1; }

# ── panel ──────────────────────────────────────────────────────────────────
phase_panel_image() {
    require_scratch panel-image
    ( cd "$ROOT" && docker build -q -f apps/control-panel/Dockerfile -t "$PANEL_IMAGE" . ) > /dev/null
    docker image inspect "$PANEL_IMAGE" --format '{{.Id}}' | ledger panel-image.txt
    ok "panel-image: ${PANEL_IMAGE} built at $(git -C "$ROOT_H" rev-parse --short=8 HEAD) ($(tail -n1 "$OUT/ledger/panel-image.txt"))"
}

phase_panel_up() {
    require_scratch panel-up
    docker image inspect "$PANEL_IMAGE" >/dev/null 2>&1 || die "no ${PANEL_IMAGE}: run panel-image first"
    mkdir -p "$SROOT/etc/secrets/control-panel" "$OUT/ledger"
    : > "$OUT/state.env"
    gen | secret_file kc-admin
    gen | secret_file pg-admin
    gen | secret_file control-reader
    local p_kc p_panel
    p_kc="$(free_port)"; p_panel="$(free_port)"
    state_set KC_PORT "$p_kc"; state_set PANEL_PORT "$p_panel"

    docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
    POSTGRES_PASSWORD="$(cat "$OUT/secrets/pg-admin")" docker run -d --name "${STACK}-pg" --network "$NET" \
        -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD "$PG_IMAGE" >/dev/null
    KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$OUT/secrets/kc-admin")" docker run -d --name "${STACK}-kc" --network "$NET" \
        -p "127.0.0.1:${p_kc}:8080" -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD \
        "$KC_IMAGE" start-dev --http-relative-path=/auth \
        "--hostname=http://127.0.0.1:${p_kc}/auth" --hostname-backchannel-dynamic=true >/dev/null

    # The control registry: gremion-ui's own control chain, one fixture customer,
    # and the least-privilege read role the panel's CONTROL_DATABASE_URL uses.
    local s=0
    until docker exec "${STACK}-pg" pg_isready -qU postgres 2>/dev/null; do (( s++ < 40 )) || die "postgres never became ready"; sleep 2; done
    sleep 2
    docker exec "${STACK}-pg" psql -v ON_ERROR_STOP=1 -qU postgres -c 'CREATE DATABASE control' >/dev/null
    local f
    for f in "$ROOT"/gremion-ui/migrations-control/[0-9]*.sql; do
        docker exec -i "${STACK}-pg" psql -v ON_ERROR_STOP=1 -qU postgres -d control < "$f" >/dev/null \
            || die "control migration $(basename "$f") failed"
    done
    CONTROL_READER_PASSWORD="$(cat "$OUT/secrets/control-reader")" docker exec -i -e CONTROL_READER_PASSWORD "${STACK}-pg" \
        sh -c 'psql -v ON_ERROR_STOP=1 -qU postgres -d control -v pw="$CONTROL_READER_PASSWORD"' >/dev/null <<'SQL'
CREATE ROLE control_reader LOGIN PASSWORD :'pw';
GRANT SELECT ON tenant, tenant_domain TO control_reader;
INSERT INTO tenant (slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id, kc_client_ref,
                    auth_client_ref, nc_target, matrix_space, domain_profile, brand_ref, blueprint_ref,
                    conn_profile, backup_key_ref, audiences)
VALUES ('proof-rat', 'active', 'file:proof', 'proof-rat', 'https://rat.proof.test/auth/realms/proof-rat',
        'http://keycloak:8080/auth', 'gremion-admin', 'file:proof', 'file:proof', '{}', '{}', '{}', 'proof',
        'proof', '{}', 'file:proof', '{gremion-ui}');
INSERT INTO tenant_domain (host, tenant_id, is_primary) SELECT 'rat.proof.test', id, true FROM tenant WHERE slug = 'proof-rat';
SQL
    ok "panel-up: control registry migrated (gremion-ui/migrations-control), one fixture customer, a SELECT-only reader"
    printf '%s panel-up kc=%s panel=%s\n' "$(now)" "$p_kc" "$p_panel" | ledger run.log
}

phase_panel_realm() {
    require_scratch panel-realm
    local p_kc; p_kc="$(state_get KC_PORT)"
    wait_http "http://127.0.0.1:${p_kc}/auth/realms/master" 180 || die "keycloak never answered on 127.0.0.1:${p_kc}"
    # The ops realm, EXACTLY as the test env gets it (section 11 step 2).
    gremion_tenant init --realm-only --keycloak-container "${STACK}-kc" --panel-origin "https://${PANEL_HOST}" \
        > "$OUT/ledger/init-realm-only.log" 2>&1 || { cat "$OUT/ledger/init-realm-only.log" >&2; die "init --realm-only failed"; }
    [[ -s "$SROOT/etc/secrets/control-panel/client_secret" ]] || die "init --realm-only wrote no client secret"
    # (section 11 step 3) the operator, with a temporary password printed ONCE on stdout.
    { gremion_tenant operator add "$OPERATOR_EMAIL" --no-mail --keycloak-container "${STACK}-kc" \
        2> "$OUT/ledger/operator-add.err" || true; } | sed -n 's/^TEMPORARY-PASSWORD: //p' | secret_file operator-temp
    [[ -s "$OUT/secrets/operator-temp" ]] || { cat "$OUT/ledger/operator-add.err" >&2; die "operator add printed no temporary password"; }
    printf 'Proof-%s-%s\n' "$(gen)" "Aa1!" | secret_file operator-new
    gen | ( umask 077; cat > "$SROOT/etc/secrets/control-panel/auth_secret" )
    ok "panel-realm: the ops realm by init --realm-only, an operator by operator add --no-mail (temporary password captured to a 0600 file)"
}

phase_panel_start() {
    require_scratch panel-start
    local p_kc p_panel
    p_kc="$(state_get KC_PORT)"; p_panel="$(state_get PANEL_PORT)"
    [[ -s "$SROOT/etc/secrets/control-panel/auth_secret" ]] || die "run panel-realm first"
    # The standalone file ITSELF (section 11 (b), R29-I11), with a proof env.
    ( umask 077; cat > "$OUT/panel.env" ) <<EOF
IMAGE_TAG=${STACK}
PANEL_NETWORK=${NET}
PANEL_HOST=${PANEL_HOST}
PANEL_TRAEFIK_ENTRYPOINT=websecure
PANEL_CERT_RESOLVER=proof-none
PANEL_PORT=${p_panel}
PANEL_OIDC_ISSUER=http://127.0.0.1:${p_kc}/auth/realms/platform
PANEL_OIDC_INTERNAL_BASE=http://${STACK}-kc:8080/auth
PANEL_NODE_EXTRA_CA_CERTS=
PANEL_SECRETS_DIR=$(host_path "$SROOT/etc/secrets/control-panel")
CONTROL_DATABASE_URL=postgresql://control_reader:$(cat "$OUT/secrets/control-reader")@${STACK}-pg:5432/control
PLATFORM_DATABASE_URL=
PANEL_EXECUTOR=none
EOF
    ( cd "$ROOT" && docker compose -p "${STACK}-panel" -f compose/control-panel/standalone.yml \
        --env-file "$(host_path "$OUT/panel.env")" up -d --no-build --pull never ) > "$OUT/ledger/panel-compose-up.log" 2>&1 \
        || { tail -n 15 "$OUT/ledger/panel-compose-up.log" >&2; die "the standalone panel did not come up"; }
    local cid; cid="$(panel_cid)"
    [[ -n "$cid" ]] || die "no control-panel container in ${STACK}-panel"
    wait_health "$cid" 120 || { docker logs --tail 30 "$cid" >&2; die "the panel never became healthy"; }
    ok "panel-start: compose/control-panel/standalone.yml up, the panel healthy on 127.0.0.1:${p_panel}"
}

phase_panel_login() {
    local out
    out="$(session login --base "$(panel_url)" --host "$PANEL_HOST" --user "$OPERATOR_EMAIL" \
        --temp-password-file "$(host_path "$OUT/secrets/operator-temp")" \
        --new-password-file "$(host_path "$OUT/secrets/operator-new")" \
        --cookie-out "$(host_path "$OUT/secrets/loa2.cookie")" \
        --totp-secret-out "$(host_path "$OUT/secrets/operator-totp")" 2> "$OUT/ledger/panel-login.err")" \
        || { cat "$OUT/ledger/panel-login.err" >&2; bad "panel-login: the operator's real sign-in failed"; return; }
    printf '%s %s\n' "$(now)" "$out" | ledger panel-login.log
    if [[ "$(jq -r .status <<< "$out")" == 200 && "$(jq -r .path <<< "$out")" == / ]]; then
        ok "panel-login: the operator signed in (password change + TOTP enrolment + OTP) and / answered 200"
    else
        bad "panel-login: the sign-in ended at $(jq -r .path <<< "$out") with $(jq -r .status <<< "$out")"
    fi
    # The acr the panel recorded is the one Keycloak issued: read the token back.
    local sname; sname="$(jq -r .sessionCookie <<< "$out")"
    state_set SESSION_COOKIE "$sname"
}

mint() { # <out file> <iss> <acr> <roles>
    session mint --secret-file "$(host_path "$SROOT/etc/secrets/control-panel/auth_secret")" \
        --cookie-name "$(state_get SESSION_COOKIE)" --iss "$2" --acr "$3" --roles "$4" \
        --uid 5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33 --cookie-out "$(host_path "$1")" >/dev/null
}

phase_panel_verify() {
    local p_kc ops_iss
    p_kc="$(state_get KC_PORT)"; ops_iss="http://127.0.0.1:${p_kc}/auth/realms/platform"
    [[ -s "$OUT/secrets/loa2.cookie" ]] || die "no loa2 cookie: run panel-login first"
    # An ops session at loa1 cannot be produced on demand (the realm demands
    # loa2 of the panel); it is the panel's own signed session with acr loa1.
    mint "$OUT/secrets/loa1.cookie" "$ops_iss" loa1 operator
    kc_login
    kcadm get clients -r platform -q clientId=control-panel > "$OUT/client.json"
    bash "$ROOT/test/host/integration/panel-verify.sh" "$(panel_url)" --host-header "$PANEL_HOST" \
        --loa1-cookie "$OUT/secrets/loa1.cookie" --loa2-cookie "$OUT/secrets/loa2.cookie" \
        --client-json "$OUT/client.json" --customer-issuer "http://127.0.0.1:${p_kc}/auth/realms/proof-rat" \
        > "$OUT/ledger/panel-verify.log" 2>&1 || true
    cat "$OUT/ledger/panel-verify.log"
    local line; line="$(grep '^PANEL-VERIFY:' "$OUT/ledger/panel-verify.log" || true)"
    # 10 checks on an http base (the HSTS check needs https, which the edge adds on the host).
    if [[ "$line" =~ pass=([0-9]+)\ fail=0$ ]] && (( BASH_REMATCH[1] >= 10 )); then ok "panel-verify: ${line}"
    else bad "panel-verify: ${line:-no summary line}"; fi
    # The redirect URIs name the panel's host exactly.
    if [[ "$(jq -c '.[0].redirectUris' "$OUT/client.json")" == "[\"https://${PANEL_HOST}/*\"]" ]]; then
        ok "panel-verify: the control-panel client redirects to https://${PANEL_HOST}/* only"
    else bad "panel-verify: control-panel redirectUris $(jq -c '.[0].redirectUris' "$OUT/client.json")"; fi
}

phase_panel_gate() {
    local p_kc code base host_h
    p_kc="$(state_get KC_PORT)"; base="$(panel_url)"; host_h="Host: ${PANEL_HOST}"
    mint "$OUT/secrets/customer.cookie" "http://127.0.0.1:${p_kc}/auth/realms/proof-rat" loa2 operator
    mint "$OUT/secrets/norole.cookie" "http://127.0.0.1:${p_kc}/auth/realms/platform" loa2 ""
    local spec method path
    local -a body
    for spec in "GET /" "POST /customers/new" "GET /api/customers" "GET /customers/proof-rat"; do
        read -r method path <<< "$spec"
        body=(); [[ "$method" == POST ]] && body=(--data 'slug=proof-x')
        # Same-origin (Origin: https://PANEL_HOST): SvelteKit's CSRF check passes, so a 403 is the gate's.
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" -H "$host_h" -H @"$OUT/secrets/customer.cookie" \
            -H "Origin: https://${PANEL_HOST}" -H 'Content-Type: application/x-www-form-urlencoded' \
            ${body[@]+"${body[@]}"} "${base}${path}" 2>/dev/null || echo 000)"
        if [[ "$code" == 403 ]]; then ok "panel-gate: a customer-realm session (signed, loa2, operator role) -> 403 on ${spec}"
        else bad "panel-gate: a customer-realm session -> ${code} on ${spec} (want 403)"; fi
    done
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H "$host_h" -H @"$OUT/secrets/norole.cookie" "${base}/" || echo 000)"
    if [[ "$code" == 403 ]]; then ok "panel-gate: an ops session without the operator role -> 403"
    else bad "panel-gate: an ops session without the operator role -> ${code} (want 403)"; fi
    # The customer list the loa2 operator sees holds the fixture customer.
    if curl -sS --max-time 20 -H "$host_h" -H @"$OUT/secrets/loa2.cookie" "${base}/" | grep -q 'proof-rat'; then
        ok "panel-gate: the loa2 operator's customer list reads the control registry (fixture customer proof-rat shown)"
    else bad "panel-gate: the loa2 operator's customer list does not show proof-rat"; fi
    if curl -sS --max-time 20 -H "$host_h" -H @"$OUT/secrets/loa2.cookie" "${base}/customers/new" | grep -q 'PLATFORM_DATABASE_URL'; then
        ok "panel-gate: \"Neuer Mandant\" is visibly disabled with its reason (no platform database, Q6)"
    else bad "panel-gate: \"Neuer Mandant\" shows no disabled reason"; fi
}

phase_panel_isolated() {
    local cid binds
    cid="$(panel_cid)"; [[ -n "$cid" ]] || die "no panel container"
    binds="$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}} {{end}}{{end}}' "$cid" | xargs)"
    if [[ -n "$binds" && "$binds" =~ ^(127\.0\.0\.1( |$))+$ ]]; then ok "panel-isolated: every published binding is 127.0.0.1 (${binds})"
    else bad "panel-isolated: published bindings '${binds}' are not loopback-only"; fi
    if [[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}' "$cid")" == "true [ALL] node" ]]; then
        ok "panel-isolated: read-only root filesystem, every capability dropped, user node"
    else bad "panel-isolated: hardening $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.Config.User}}' "$cid")"; fi
    # The HEALTHCHECK never reaches Keycloak or a database.
    docker stop -t 5 "${STACK}-kc" "${STACK}-pg" >/dev/null
    local body; body="$(docker exec "$cid" wget -qO- http://127.0.0.1:3000/healthz 2>&1 || true)"
    docker restart "$cid" >/dev/null
    if wait_health "$cid" 90 && [[ "$body" == *'"ok":true'* ]]; then
        ok "panel-isolated: healthy (and /healthz ok) with Keycloak and PostgreSQL stopped, also after a restart"
    else bad "panel-isolated: not healthy with Keycloak and PostgreSQL stopped (${body})"; fi
    docker start "${STACK}-pg" "${STACK}-kc" >/dev/null
}

phase_panel_down() {
    require_scratch panel-down
    local c
    for c in $(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-panel"); do docker rm -f "$c" >/dev/null; done
    for c in "${STACK}-kc" "${STACK}-pg"; do docker rm -f -v "$c" >/dev/null 2>&1 || true; done
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker network rm "${STACK}-panel_default" >/dev/null 2>&1 || true
    docker image rm "$PANEL_IMAGE" >/dev/null 2>&1 || true
    local left
    left="$(docker ps -aq --filter "name=^${STACK}-" | grep -c . || true)$(docker network ls -q --filter "name=^${STACK}-" | grep -c . || true)"
    if [[ "$left" == 00 ]]; then ok "panel-down: no container or network under ${STACK} remains"
    else bad "panel-down left resources (containers/networks: $left)"; fi
}

# ── customer (section 1), against a RUNNING pooled stack ───────────────────
PSTACK="${POOLED_STACK:-}"
PENV="${POOLED_ENV_DIR:-}"
X=proof-x                 # the customer under proof
Y=proof-y                 # the second customer (unaffected by X's suspend)
XT="${X//-/_}"
need_pooled() {
    [[ -n "$PSTACK" && -d "$PENV" && -f "$PENV/state.env" ]] || die "set POOLED_STACK and POOLED_ENV_DIR (a running pooled stack's env files)"
    [[ "${PROOF_OPERATOR_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
        || die "set PROOF_OPERATOR_ID (a platform-realm user id, lowercase uuid)"
}
penv() { sed -n "s/^$1=//p" "$PENV/state.env" | tr -d '"\r' | tail -n1; }
croot() { if [[ -n "${PROOF_GREMION_ROOT:-}" ]]; then printf '%s' "$PROOF_GREMION_ROOT"; else penv GREMION_ROOT; fi; }
svc() { docker ps -q --filter "label=com.docker.compose.project=${PSTACK}-$1" --filter "label=com.docker.compose.service=$2" | head -n1; }
q() { # <database> <sql> -- one value per line from the state postgres
    docker exec -i "$(svc state postgres)" psql -v ON_ERROR_STOP=1 -tAqU postgres -d "$1" -c "$2" | tr -d '\r'
}
qm() { # <module> <sql> -- the module's own server
    docker exec -i "$(svc state "$1-postgres")" psql -v ON_ERROR_STOP=1 -tAqU "$1" -d postgres -c "$2" | tr -d '\r'
}
skc() { # kcadm in the state keycloak (the admin password by a name-only -e)
    local cid; cid="$(svc state keycloak)"
    KC_LOGIN_PASSWORD="$(penv KEYCLOAK_ADMIN_PASSWORD)" docker exec -e KC_LOGIN_PASSWORD "$cid" sh -c \
        '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user "$0" --password "$KC_LOGIN_PASSWORD" >/dev/null' \
        "$(penv KEYCLOAK_ADMIN)"
    docker exec "$cid" /opt/keycloak/bin/kcadm.sh "$@"
}
tenant() { # gremion-tenant against the laid-out root, as the operator
    MSYS_NO_PATHCONV=1 GREMION_ROOT="$(host_path "$(croot)")" GREMION_RELEASE_DIR="$ROOT_H" \
        GREMION_OPERATOR_ID="$PROOF_OPERATOR_ID" TENANT_DNS_PREFLIGHT="${PROOF_DNS_PREFLIGHT:-off}" \
        bash "$ROOT/infra/host/bin/gremion-tenant" "$@"
}
accounts() { # the rendered NATS accounts file(s)
    docker run --rm --name "${STACK}-accounts" -v "${PSTACK}_nats_accounts:/a:ro" --entrypoint sh "$PG_IMAGE" -c 'cat /a/*' | tr -d '\r'
}
dbs_kernel() { q postgres "SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' ORDER BY 1"; }
dbs_module() { qm "$1" "SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' ORDER BY 1"; }
edge_status() { # <host> -- the tenant host through the edge Traefik
    local port; port="$(penv EDGE_HTTPS_PORT)"; port="${port:-443}"
    curl -ksS -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$1:${port}:127.0.0.1" "https://$1:${port}/" 2>/dev/null || echo 000
}
customer_id() { q control "SELECT id FROM tenant WHERE slug = '$1'"; }
host_of() { printf 'rat.%s.%s' "$1" "$(penv PLATFORM_DOMAIN)"; }
trd440() { # the container count and every project's service list
    local p
    printf 'running=%s\n' "$(docker ps -q | grep -c . || true)"
    for p in state app-blue app-green ops mail; do
        [[ -f "$PENV/$p.env" ]] || continue
        printf '%s: %s\n' "$p" "$( (cd "$ROOT" && docker compose --env-file "$(host_path "$PENV/$p.env")" config --services 2>/dev/null) | sort | tr '\n' ' ')"
    done
}

phase_customer_layout() {
    need_pooled
    [[ -z "${PROOF_GREMION_ROOT:-}" ]] || die "customer-layout lays out a SCRATCH root; PROOF_GREMION_ROOT names a real one"
    local r; r="$(croot)"; [[ -d "$r" ]] || die "the pooled stack's GREMION_ROOT ${r} is absent"
    mkdir -p "$r/etc/env" "$r/runtime" "$r/etc/edge"
    local f
    for f in state app-blue app-green mail ops; do [[ -f "$PENV/$f.env" ]] && cp "$PENV/$f.env" "$r/etc/env/$f.env"; done
    [[ -f "$r/runtime/active-colour" ]] || echo blue > "$r/runtime/active-colour"
    ok "customer-layout: ${r} carries etc/env, runtime/active-colour ($(cat "$r/runtime/active-colour")) and etc/edge"
}

phase_customer_before() {
    need_pooled
    mkdir -p "$OUT/ledger"
    trd440 > "$OUT/ledger/trd440-before.txt"
    [[ "$(sed -n 's/^running=//p' "$OUT/ledger/trd440-before.txt")" -gt 0 ]] || die "no container runs: this is not a running pooled stack"
    dbs_kernel > "$OUT/ledger/dbs-kernel-before.txt"
    for m in calendar vault; do dbs_module "$m" > "$OUT/ledger/dbs-$m-before.txt"; done
    if [[ -z "$(q postgres "SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'")" ]]; then
        ok "customer-before: no gremion_platform yet (Q15: create must bootstrap it)"
    else
        info "gremion_platform already exists (a rerun or a host after init): the bootstrap line is proven by the first run only"
    fi
    ok "customer-before: TRD-440 baseline and the database lists recorded"
}

phase_customer_create() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json" out rc id kdb n
    [[ -f "$cfg" ]] || die "the customer config fixture ${cfg} is absent"
    # R29-I1: board is refused BY NAME, before any write.
    rc=0; out="$(tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "it@$(host_of "$X")" \
        --council-admin "rat@$(host_of "$X")" --enable calendar,board 2>&1)" || rc=$?
    if (( rc != 0 )) && [[ "$out" == *board* ]] && [[ -z "$(customer_id "$X")" ]]; then
        ok "customer-create: --enable board refused by name (exit ${rc}), no control row written"
    else bad "customer-create: --enable board was not refused before any write (exit ${rc})"; fi

    tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "it@$(host_of "$X")" \
        --council-admin "rat@$(host_of "$X")" --enable calendar,vault > "$OUT/ledger/create-x.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/create-x.log" >&2; bad "customer-create: gremion-tenant create ${X} failed"; return; }
    tenant create "$Y" --host "$(host_of "$Y")" --config "$cfg" --it-admin "it@$(host_of "$Y")" \
        --council-admin "rat@$(host_of "$Y")" > "$OUT/ledger/create-y.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/create-y.log" >&2; bad "customer-create: gremion-tenant create ${Y} failed"; return; }
    ok "customer-create: gremion-tenant create ${X} (calendar, vault) and ${Y} exited 0"

    if [[ -n "$(q postgres "SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'")" ]]; then ok "customer-create: gremion_platform exists (bootstrapped, Q15)"; else bad "customer-create: no gremion_platform"; fi
    n="$(q gremion_platform "SELECT count(*) FROM plt.module_version")"
    if [[ "$n" -ge "$(find "$ROOT/modules" -maxdepth 2 -name module.json | grep -c .)" ]]; then ok "customer-create: ${n} plt.module_version row(s), one per catalogue module (Q20)"; else bad "customer-create: plt.module_version holds ${n} row(s)"; fi

    local yid
    id="$(customer_id "$X")"; kdb="t_${id//-/}__kernel"; yid="$(customer_id "$Y")"
    [[ -n "$id" && -n "$yid" ]] || { bad "customer-create: no control row for ${X} or ${Y}"; return; }
    # X's new databases (Y's kernel database is set aside: Y enabled nothing).
    comm -13 "$OUT/ledger/dbs-kernel-before.txt" <(dbs_kernel) | grep -v "^t_${yid//-/}__" > "$OUT/ledger/dbs-kernel-new-x.txt" || true
    if [[ "$(cat "$OUT/ledger/dbs-kernel-new-x.txt")" == "$kdb" ]]; then ok "customer-create: the kernel server gained exactly ${kdb}"
    else bad "customer-create: the kernel server gained [$(tr '\n' ' ' < "$OUT/ledger/dbs-kernel-new-x.txt")], want ${kdb}"; fi
    for m in calendar vault; do
        if [[ "$(comm -13 "$OUT/ledger/dbs-$m-before.txt" <(dbs_module "$m"))" == "t_${id//-/}__${m}" ]]; then ok "customer-create: ${m}-postgres gained exactly t_…__${m}"
        else bad "customer-create: ${m}-postgres did not gain exactly t_${id//-/}__${m}"; fi
    done
    # The kernel database: gremion-ui's own ledger shape, no seed, one body.
    if [[ "$(q "$kdb" "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name = 'schema_migrations'")" == "applied_at,filename" ]]; then ok "customer-create: schema_migrations is gremion-ui's (filename, applied_at), no sha256 (Q3)"; else bad "customer-create: schema_migrations has another shape"; fi
    if [[ "$(q "$kdb" "SELECT count(*) FROM schema_migrations WHERE filename LIKE '%seed%'")" == 0 ]]; then ok "customer-create: no *_seed.sql applied (GREMION_DISABLE_SEEDS)"; else bad "customer-create: a seed file was applied"; fi
    if [[ "$(q "$kdb" "SELECT count(*) FROM org_units")/$(q "$kdb" "SELECT count(*) FROM committees")" == "1/0" ]]; then ok "customer-create: org_units = 1 (the council), committees = 0"; else bad "customer-create: org_units/committees are not 1/0"; fi
    # The realm: one group, two administrators, the customer's own sender.
    if [[ "$(skc get groups -r "$X" --fields name | jq 'length')" == 1 ]]; then ok "customer-create: realm ${X} holds one group (the first body)"; else bad "customer-create: realm ${X} group count"; fi
    local users; users="$(skc get users -r "$X" --fields username,requiredActions | jq -c '[.[] | select(.username | startswith("service-account-") | not)] | length')"
    if [[ "$users" == 2 ]]; then ok "customer-create: two administrators in ${X}"; else bad "customer-create: ${users} user(s) in ${X}, want 2"; fi
    local smtp; smtp="$(skc get "realms/$X" --fields smtpServer | jq -c '.smtpServer | [.user, .from, .host, .port, .starttls]')"
    if [[ "$smtp" == "[\"kc-${XT}@$(penv PLATFORM_DOMAIN)\",\"kc-${XT}@$(penv PLATFORM_DOMAIN)\",\"mail.$(penv PLATFORM_DOMAIN)\",\"587\",\"true\"]" ]]; then ok "customer-create: the realm sends as kc-${XT}@ through mail.<domain>:587 STARTTLS (R-E5b)"; else bad "customer-create: realm SMTP ${smtp}"; fi
    # The control row, the ledger, the broker, the router.
    if [[ "$(q control "SELECT count(*) FROM tenant_domain WHERE tenant_id = '${id}' AND is_primary")" == 1 ]]; then ok "customer-create: one primary tenant_domain row binds $(host_of "$X")"; else bad "customer-create: tenant_domain rows"; fi
    if [[ "$(q gremion_platform "SELECT count(DISTINCT step_kind) || '/' || count(*) FROM plt.provisioning_step WHERE customer_id = '${id}' AND status = 'done'")" == "8/8" ]]; then ok "customer-create: eight done ledger rows, one per kind (Q2)"; else bad "customer-create: the ledger is not eight done rows"; fi
    local acc; acc="$(accounts)"
    if grep -q '# kernel@' <<< "$acc" && grep -q '# calendar@' <<< "$acc" && ! grep -q '# vault@' <<< "$acc"; then
        ok "customer-create: the broker account holds kernel and calendar users, none for vault (no flow, Q4)"
    else bad "customer-create: the broker account's users are not kernel+calendar"; fi
    if grep -q "tenant-${X}-kc:" "$(croot)/etc/edge/tenant-${X}.yml" 2>/dev/null; then ok "customer-create: etc/edge/tenant-${X}.yml carries the realm router (Q16, Q17)"; else bad "customer-create: no router file with the realm router"; fi
    if [[ "$(edge_status "$(host_of "$X")")" != 503 && "$(edge_status "$(host_of "$X")")" != 000 ]]; then ok "customer-create: $(host_of "$X") is served through the edge"; else bad "customer-create: $(host_of "$X") is not served"; fi
}

phase_customer_rerun() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json" id before after b
    id="$(customer_id "$X")"
    before="$(q gremion_platform "SELECT count(*) FROM plt.provisioning_step WHERE customer_id = '${id}'")"
    tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "it@$(host_of "$X")" \
        --council-admin "rat@$(host_of "$X")" --enable calendar,vault > "$OUT/ledger/rerun-x.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/rerun-x.log" >&2; bad "customer-rerun: the second create failed"; return; }
    after="$(q gremion_platform "SELECT count(*) FROM plt.provisioning_step WHERE customer_id = '${id}'")"
    if [[ "$before" == "$after" ]]; then ok "customer-rerun: the ledger is unchanged (${after} rows)"; else bad "customer-rerun: the ledger grew ${before} -> ${after}"; fi
    b="$(grep -h '^{"phase":"b"' "$OUT/ledger/rerun-x.log" | tail -n1)"
    if [[ "$(jq -c '[.reloaded, .ran]' <<< "${b:-{\}}")" == '[false,[]]' ]]; then ok "customer-rerun: phase B ran nothing and did not reload the broker"; else bad "customer-rerun: phase B was ${b:-silent}"; fi
    if [[ "$(grep -h '^{"phase":"a"' "$OUT/ledger/rerun-x.log" | tail -n1 | jq -c '.ran')" == '[]' ]]; then ok "customer-rerun: phase A ran nothing"; else bad "customer-rerun: phase A ran steps"; fi
}

phase_customer_suspend() {
    need_pooled
    tenant suspend "$X" > "$OUT/ledger/suspend-x.log" 2>&1 || { tail -n 20 "$OUT/ledger/suspend-x.log" >&2; bad "customer-suspend: suspend failed"; return; }
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${X}'")" == suspended ]]; then ok "customer-suspend: status suspended"; else bad "customer-suspend: status"; fi
    if [[ "$(skc get "realms/$X" --fields enabled | jq -r .enabled)" == false ]]; then ok "customer-suspend: realm ${X} disabled (no sign-in, no token)"; else bad "customer-suspend: realm still enabled"; fi
    if [[ "$(edge_status "$(host_of "$X")")" == 503 ]]; then ok "customer-suspend: $(host_of "$X") answers 503 (no tenant content)"; else bad "customer-suspend: $(host_of "$X") answers $(edge_status "$(host_of "$X")")"; fi
    if grep -q '# calendar@' <<< "$(accounts)"; then bad "customer-suspend: the calendar broker user is still rendered"; else ok "customer-suspend: the module broker users are evicted"; fi
    if [[ "$(bash "$ROOT/infra/host/bin/gremion-vendor-mail" principals list --tenant "$XT" 2>/dev/null | grep -c "kc-${XT}@" || true)" == 0 ]]; then ok "customer-suspend: the principal kc-${XT}@ is revoked (R-E5a)"; else bad "customer-suspend: the principal still exists"; fi
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${Y}'")" == active && "$(edge_status "$(host_of "$Y")")" != 503 ]]; then ok "customer-suspend: ${Y} is untouched"; else bad "customer-suspend: ${Y} was affected"; fi
}

phase_customer_resume() {
    need_pooled
    tenant resume "$X" > "$OUT/ledger/resume-x.log" 2>&1 || { tail -n 20 "$OUT/ledger/resume-x.log" >&2; bad "customer-resume: resume failed"; return; }
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${X}'")" == active ]]; then ok "customer-resume: status active"; else bad "customer-resume: status"; fi
    if [[ "$(skc get "realms/$X" --fields enabled | jq -r .enabled)" == true ]]; then ok "customer-resume: realm enabled"; else bad "customer-resume: realm still disabled"; fi
    if [[ "$(edge_status "$(host_of "$X")")" != 503 ]]; then ok "customer-resume: $(host_of "$X") serves again"; else bad "customer-resume: still 503"; fi
    if grep -q '# calendar@' <<< "$(accounts)"; then ok "customer-resume: the calendar broker user is back"; else bad "customer-resume: no calendar broker user"; fi
    if [[ "$(bash "$ROOT/infra/host/bin/gremion-vendor-mail" principals list --tenant "$XT" 2>/dev/null | grep -c "kc-${XT}@" || true)" == 1 ]]; then ok "customer-resume: a fresh principal kc-${XT}@ exists"; else bad "customer-resume: no principal"; fi
}

phase_customer_reconcile() {
    need_pooled
    if tenant reconcile "$X" > "$OUT/ledger/reconcile-1.log" 2>&1; then ok "customer-reconcile: ${X} reconciles green"
    else tail -n 20 "$OUT/ledger/reconcile-1.log" >&2; bad "customer-reconcile: ${X} is not green"; fi
    skc update "realms/$X" -s "smtpServer.from=platform@$(penv PLATFORM_DOMAIN)" >/dev/null
    if tenant reconcile "$X" > "$OUT/ledger/reconcile-2.log" 2>&1; then bad "customer-reconcile: a platform@ sender passed"
    elif grep -q 'smtp-server' "$OUT/ledger/reconcile-2.log"; then ok "customer-reconcile: a platform@ sender fails smtp-server"
    else bad "customer-reconcile: the failure does not name smtp-server"; fi
    if tenant reconcile "$X" --apply > "$OUT/ledger/reconcile-3.log" 2>&1; then ok "customer-reconcile: --apply repaired it by host rotation (Q7)"
    else tail -n 20 "$OUT/ledger/reconcile-3.log" >&2; bad "customer-reconcile: --apply did not repair"; fi
    if bash "$ROOT/infra/host/bin/gremion-vendor-mail" check-principals --host --no-allowances > "$OUT/ledger/check-principals.log" 2>&1; then
        ok "customer-reconcile: check-principals --no-allowances is green over two customers (Q14)"
    else bad "customer-reconcile: check-principals failed"; fi
}

phase_customer_after() {
    need_pooled
    trd440 > "$OUT/ledger/trd440-after.txt"
    if diff -q "$OUT/ledger/trd440-before.txt" "$OUT/ledger/trd440-after.txt" >/dev/null; then
        ok "customer-after: TRD-440 -- running containers and every project's services unchanged by two customers"
    else bad "customer-after: TRD-440 moved: $(diff "$OUT/ledger/trd440-before.txt" "$OUT/ledger/trd440-after.txt" | tr '\n' ' ')"; fi
}

run_phase() {
    case "$1" in
        customer-layout) phase_customer_layout ;;
        customer-before) phase_customer_before ;;
        customer-create) phase_customer_create ;;
        customer-rerun) phase_customer_rerun ;;
        customer-suspend) phase_customer_suspend ;;
        customer-resume) phase_customer_resume ;;
        customer-reconcile) phase_customer_reconcile ;;
        customer-after) phase_customer_after ;;
        panel-image) phase_panel_image ;;
        panel-up) phase_panel_up ;;
        panel-realm) phase_panel_realm ;;
        panel-start) phase_panel_start ;;
        panel-login) phase_panel_login ;;
        panel-verify) phase_panel_verify ;;
        panel-gate) phase_panel_gate ;;
        panel-isolated) phase_panel_isolated ;;
        panel-down) phase_panel_down ;;
        *) die "unknown phase '$1'" ;;
    esac
}

[[ $# -gt 0 ]] || die "usage: customer-provision-proof.sh <phase>... (see the header)"
PHASES="$*"
info "STACK=${STACK} ledger=${OUT}/ledger"
for ph in "$@"; do run_phase "$ph"; done
printf '%s phases [%s] checks=%s RED=%s\n' "$(now)" "$PHASES" "$CHECKS" "$RED" | ledger run.log
(( CHECKS > 0 )) || { echo "[customer-proof] RED: zero checks ran" >&2; exit 1; }
if (( RED )); then echo "[customer-proof] RED" >&2; exit 1; fi
echo "[customer-proof] GREEN (${CHECKS} checks)"
