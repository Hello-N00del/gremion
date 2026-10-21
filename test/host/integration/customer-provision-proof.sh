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
# (pooled-stack-proof.sh only brings up t040-<sha8> stacks, so the customer
# phases (TASK-043/TASK-044) run with POOLED_STACK=t040-<sha8>; the scratch-
# fixture gate accepts any tNNN-<sha8> stack naming its own platform host;
# POOLED_STACK + POOLED_ENV_DIR; customer-layout lays its GREMION_ROOT out
# like a host's) or a host after TASK-038's re-init (PROOF_GREMION_ROOT=/opt/gremion,
# POOLED_STACK=<stack>, POOLED_ENV_DIR=/opt/gremion/etc/env). The operator id
# of every mutating verb is PROOF_OPERATOR_ID (a platform-realm user id).
#   customer-layout  scratch only: etc/env, runtime/active-colour, etc/edge
#   customer-before  TRD-440 baseline (running containers, every project's
#                    config --services), pg_database lists, no gremion_platform
#   customer-init    `gremion-tenant init` (TASK-044: the gremion_platform
#                    catalogue rows and the ops realm that seed_gate_fixtures and
#                    the level-1 gate need); a rerun is a no-op when the catalogue
#                    is loaded. Run it after customer-before, before any create.
#   customer-create  = the four sub-phases below, in order (each fits a 4-minute
#                    tool call on its own; run them separately from a supervisor)
#     customer-create-refuse  `--enable board` and `--enable vault` refused by
#                    name before any write (R29-I1; R30 A1, PRD-PLAT-012 / PRD-REC-003)
#     customer-create-x       the gate fixtures, then
#                    `gremion-tenant create proof-x --enable calendar,votes` (calendar:
#                    a database and a broker user; votes: neither)
#     customer-create-y       a second customer proof-y
#     customer-create-check   every section 1 "Create" line (post-conditions)
#   customer-rerun   a second create: phase A and B run nothing, the broker is
#                    not reloaded, the ledger and the database lists unchanged
#   customer-suspend suspend proof-x: status, realm disabled, the tenant host
#                    503 through the edge, broker module users evicted, the
#                    principal revoked, the realm carries no authenticating
#                    sender; a SECOND suspend exits 0 and changes nothing
#                    (TASK-043c); proof-y untouched. FIRST it records the
#                    stored-data fingerprint of proof-x (R30 A2, PRD-OPS-004:
#                    per table of its kernel and module databases a row count
#                    and an md5 over the ordered rows, plus the realm's user
#                    count) in ledger/fingerprint-before-suspend.txt
#   customer-resume  every one of those restored (a fresh principal); right
#                    after resume the fingerprint again, judged EQUAL by
#                    fixtures/customer-provision/data-fingerprint.mjs
#   (create and resume also read Traefik's STATE of both routers of each
#   customer: enabled, no error -- TASK-043c; presence is not enough)
#   customer-reconcile reconcile green; a planted platform@ sender fails
#                    smtp-server; --apply repairs; check-principals --no-allowances
#   customer-admins  brief section 1 "Admins sign in" (PRD-IDN-005): the realm's
#                    discovery issuer through https://<host>/auth/realms/<slug>
#                    equals tenant.issuer; for the it-admin and the
#                    council-admin: the realm role, the execute-actions mail
#                    READ FROM STALWART (IMAPS in the Stalwart container's own
#                    network namespace, the roles@ mailbox -- the proof's admin
#                    addresses are roles+<slug>-<role>@<PLATFORM_DOMAIN>
#                    sub-addresses, so they land where the proof can read them),
#                    sender kc-<token>@, link on the customer's host;
#                    UPDATE_PASSWORD + CONFIGURE_TOTP through that link; the
#                    code flow of gremion-ui through the realm router; 200 on /
#                    with the dashboard PageTitle. Needs mail.env with
#                    ROLES_IMAP_PASSWORD (roles@ provisioned) and a Keycloak that
#                    reaches mail.<PLATFORM_DOMAIN>:587.
#   customer-after   TRD-440: the container set and the services unchanged
#
# ADMINS REHEARSAL (scratch, plain `docker run` only; no pooled stack): the
# customer-admins drivers against a REAL Keycloak 26.6.1 configured like the
# pooled one (no --hostname, KC_HOSTNAME_STRICT=false, KC_PROXY_HEADERS=
# xforwarded, the gremion login theme) and an SMTP sink that keeps the raw
# message. Scratch deviations: the realm is made by kcadm (not by the
# provisioner), sslRequired=external over plain http, the sink instead of
# Stalwart (so the IMAPS read is not rehearsed), the callback of a stand-in
# client instead of gremion-ui (so the PageTitle is not rehearsed).
#   rehearsal-up     network, SMTP sink, Keycloak (${STACK}-rh-*)
#   rehearsal-run    a realm WITHOUT frontendUrl mails a link on the internal
#                    address and mail-link refuses it (the r4 defect, live);
#                    with the realm-doc frontendUrl: mail-link, activate
#                    (UPDATE_PASSWORD + CONFIGURE_TOTP), signin (password + OTP,
#                    the callback carries a code and iss = the realm URL)
#   rehearsal-down   everything rehearsal-up created, by name
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
        ok "panel-login: the operator signed in (temporary password, UPDATE_PASSWORD, CONFIGURE_TOTP, profile) and / answered 200 (the gate admits only iss=ops, acr=loa2, operator)"
    else
        bad "panel-login: the sign-in ended at $(jq -r .path <<< "$out") with $(jq -r .status <<< "$out")"
    fi
    # The acr the panel recorded is the one Keycloak issued: read the token back.
    local sname; sname="$(jq -r .sessionCookie <<< "$out")"
    state_set SESSION_COOKIE "$sname"
}

mint() { # <out file> <iss> <acr> <roles> [sign-in epoch seconds; default now]
    local -a at=(); [[ -n "${5:-}" ]] && at=(--auth-at "$5")
    session mint --secret-file "$(host_path "$SROOT/etc/secrets/control-panel/auth_secret")" \
        --cookie-name "$(state_get SESSION_COOKIE)" --iss "$2" --acr "$3" --roles "$4" ${at[@]+"${at[@]}"} \
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
    # Absolute session lifetime (review r2 HIGH): a valid ops loa2 operator
    # session signed in two hours ago is never served, however active it is --
    # a GET is sent back to the ops realm, a form POST is 403 and the cookie cleared.
    mint "$OUT/secrets/old.cookie" "http://127.0.0.1:${p_kc}/auth/realms/platform" loa2 operator "$(( $(date +%s) - 7200 ))"
    local loc
    loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 -H "$host_h" -H @"$OUT/secrets/old.cookie" "${base}/" 2>/dev/null || true)"
    if [[ "$loc" =~ ^302\ .*/realms/platform/protocol/openid-connect/auth ]]; then ok "panel-gate: an ops loa2 session signed in 2 h ago -> GET 302 to the ops realm (absolute lifetime)"
    else bad "panel-gate: an ops loa2 session signed in 2 h ago -> GET '${loc}' (want 302 to the ops realm)"; fi
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H "$host_h" -H @"$OUT/secrets/old.cookie" \
        -H "Origin: https://${PANEL_HOST}" -H 'Content-Type: application/x-www-form-urlencoded' --data 'slug=proof-x' "${base}/customers/new" 2>/dev/null || echo 000)"
    if [[ "$code" == 403 ]]; then ok "panel-gate: an ops loa2 session signed in 2 h ago -> POST 403"
    else bad "panel-gate: an ops loa2 session signed in 2 h ago -> POST ${code} (want 403)"; fi
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
need_pooled() { # [no-operator]
    [[ -n "$PSTACK" && -d "$PENV" && -f "$PENV/state.env" ]] || die "set POOLED_STACK and POOLED_ENV_DIR (a running pooled stack's env files)"
    # customer-layout precedes the operator: `gremion-tenant init` (the ops
    # realm) and `operator add` (the user whose id PROOF_OPERATOR_ID is) both
    # run against the root it lays out.
    [[ "${1:-}" == no-operator ]] && return 0
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
        GREMION_SCRATCH_FIXTURES="$(scratch_stack)" GREMION_PRODUCTION_STACK=none \
        bash "$ROOT/infra/host/bin/gremion-tenant" "$@"
}
# TASK-044 Q6: the stack name that lets the container gate accept the proof's
# `scratch-fixture:` isolation rows -- ONLY a tNNN-<sha8> pooled stack, never a
# host (PROOF_GREMION_ROOT) or any other name. Empty otherwise.
scratch_stack() { if [[ -z "${PROOF_GREMION_ROOT:-}" && "$PSTACK" =~ ^t[0-9]{3}[a-z]?-[0-9a-f]{8}$ ]]; then printf '%s' "$PSTACK"; fi; }
# seed_gate_fixtures <modules,csv> -- the rows the REAL level-1 gate needs for a
# create with modules (TASK-044 section 9): a passing cross-customer isolation
# row per module on this release tip (scratch-fixture.sql) and the operator's
# DPIA decisions (dpia.json, carried by `create --dpia-json`). Scratch only.
seed_gate_fixtures() {
    [[ -n "$(scratch_stack)" ]] || die "gate fixtures are seeded only on a scratch pooled stack (POOLED_STACK=${PSTACK})"
    local tip m dpia='{}'
    [[ -n "$(q postgres "SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'")" ]]         || die "gate fixtures need gremion_platform and the loaded catalogue (run gremion-tenant init first; --enable needs plt.module_version rows anyway)"
    tip="$(git -C "$ROOT_H" rev-parse HEAD)"
    [[ "$tip" =~ ^[0-9a-f]{40}$ ]] || die "no release tip: ${ROOT_H} is not a git checkout"
    docker exec -i "$(svc state postgres)" psql -v ON_ERROR_STOP=1 -qU postgres -d gremion_platform -v "tip=${tip}" -v "modules=$1" -f - \
        < "$ROOT_H/test/host/fixtures/customer-provision/scratch-fixture.sql" > /dev/null
    for m in ${1//,/ }; do
        [[ "$(q gremion_platform "SELECT count(*) FROM plt.isolation_test_result r JOIN plt.module m USING (module_id) WHERE m.module_key = '${m}' AND r.release_tip_sha = '${tip}' AND r.passed")" -ge 1 ]]             || die "gate fixtures: no passing isolation row for ${m} on ${tip} after seeding (is ${m} in plt.module?)"
    done
    for m in ${1//,/ }; do
        dpia="$(jq -c --arg m "$m" '. + {($m): {requiresDpia: "no", reasonCodes: ["scratch_proof"], documentRef: "scratch-fixture: TOM annex (customer-provision-proof)"}}' <<< "$dpia")"
    done
    printf '%s\n' "$dpia" > "$OUT/ledger/dpia.json"
}
accounts() { # the rendered NATS accounts file(s)
    docker run --rm --name "${STACK}-accounts" -v "${PSTACK}_nats_accounts:/a:ro" --entrypoint sh "$PG_IMAGE" -c 'cat /a/*' | tr -d '\r'
}
dbs_kernel() { q postgres "SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' ORDER BY 1"; }
dbs_module() { qm "$1" "SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' ORDER BY 1"; }
edge_status() { # <host> -- the tenant host through the edge Traefik
    # ONE three-digit code, 000 for no answer. (`curl ... || echo 000` printed
    # "404000" or "000000" whenever curl exited non-zero after -w, so a
    # comparison against 000 could never match: r2 guard-efficacy finding.)
    local port c; port="$(penv EDGE_HTTPS_PORT)"; port="${port:-443}"
    c="$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$1:${port}:127.0.0.1" "https://$1:${port}/" 2>/dev/null)" || true
    [[ "$c" =~ ^[0-9]{3}$ ]] || c=000
    printf '%s' "$c"
}
# The POSITIVE shape of a host gremion-ui serves (review C-HIGH, r2;
# docs/runbooks/tenant-edge.md: "a bare Traefik 404 is a FALSE GREEN"): an
# anonymous GET / is redirected (302/303) into the app's sign-in
# (/auth/login?callbackUrl=..., relative or on the same host), or answers 200
# carrying gremion-ui's Content-Security-Policy. 404 (router not loaded, host
# unmatched), 000 (no answer: edge down, TLS or resolve failure), 503 and
# anything else are NOT served. Sets EDGE_SHAPE for the message; returns 0
# only when served. ONE helper for create, resume and Y-untouched.
EDGE_SHAPE=""
edge_served() { # <host>
    local port hfile code loc csp host_re
    port="$(penv EDGE_HTTPS_PORT)"; port="${port:-443}"
    hfile="$OUT/ledger/edge-headers.$$.txt"
    # the code curl received (it may still exit non-zero on an unclean close); 000 = no answer
    code="$(curl -ksS -o /dev/null -D "$hfile" -w '%{http_code}' --max-time 20 --resolve "$1:${port}:127.0.0.1" "https://$1:${port}/" 2>/dev/null)" || true
    [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
    loc="$(grep -i '^location:' "$hfile" 2>/dev/null | tail -n1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')" || loc=""
    csp="$(grep -ci "^content-security-policy: default-src 'self'; " "$hfile" 2>/dev/null)" || csp=0
    rm -f "$hfile"
    EDGE_SHAPE="${code} ${loc:-no-Location}"
    host_re="${1//./\\.}"
    case "$code" in
        302|303) [[ "$loc" =~ ^(https://${host_re}(:[0-9]+)?)?/auth/login(\?|$) ]] ;;
        200) [[ "${csp:-0}" -ge 1 ]] ;;
        *) return 1 ;;
    esac
}
# gremion-vendor-mail principals list for a token, as tenant() runs the host
# tools (review C MEDIUM, r2): prints the CLI's own KC-PRINCIPALS count and
# returns 0 ONLY when the list exited 0 and printed that summary line -- a
# failing list (no mail.env, wrong root, docker error) is never "0 principals".
principal_count() { # <token>
    local out rc=0 n
    out="$(MSYS_NO_PATHCONV=1 GREMION_ROOT="$(host_path "$(croot)")" GREMION_RELEASE_DIR="$ROOT_H" \
        bash "$ROOT/infra/host/bin/gremion-vendor-mail" principals list --tenant "$1" 2>"$OUT/ledger/principals-list.err")" || rc=$?
    # diagnostics go to stderr: stdout is the count the caller captures
    (( rc == 0 )) || { info "principals list --tenant $1 exited ${rc}: $(tail -n 3 "$OUT/ledger/principals-list.err" | tr '\n' ' ')" >&2; return 1; }
    n="$(tr -d '\r' <<< "$out" | sed -n 's/^KC-PRINCIPALS: \([0-9][0-9]*\)$/\1/p' | tail -n1)"
    [[ -n "$n" ]] || { info "principals list --tenant $1 printed no KC-PRINCIPALS summary" >&2; return 1; }
    printf '%s' "$n"
}
customer_id() { q control "SELECT id FROM tenant WHERE slug = '$1'"; }
host_of() { printf 'rat.%s.%s' "$1" "$(penv PLATFORM_DOMAIN)"; }
# The first administrators' addresses: sub-addresses of the vendor server's
# roles@ mailbox, so the execute-actions mail lands where customer-admins reads.
admin_addr() { printf '%s+%s-%s@%s' "${PROOF_ADMIN_MAILBOX:-roles}" "$1" "$2" "$(penv PLATFORM_DOMAIN)"; }
menv() { sed -n "s/^$1=//p" "$PENV/mail.env" 2>/dev/null | tr -d '"\r' | tail -n1; }
# A scratch stack's edge and mail server carry no real certificate (no ACME).
scratch_tls() { [[ "$PSTACK" == t040-* || "$PSTACK" == t043-* ]]; }
# imap_fetch <to address> <out file>: the newest message to that address in
# roles@'s INBOX, over IMAPS inside the Stalwart container's network namespace
# (the pinned curl image; the password rides in the curl config on stdin,
# never on an argv). Returns 1 when none arrived within ~60 s.
imap_fetch() {
    local dom stal img pw uid tries=0
    local -a k=()
    dom="$(penv PLATFORM_DOMAIN)"; stal="${PSTACK}-mail-stalwart"
    [[ -f "$PENV/mail.env" ]] || die "no ${PENV}/mail.env: the vendor mail project is not part of this stack"
    docker inspect "$stal" >/dev/null 2>&1 || die "no container ${stal}: the vendor mail project is not running"
    img="$(menv PROBE_CURL_IMAGE)"
    [[ -n "$img" ]] || img="$(sed -n 's/^PROBE_CURL_IMAGE=//p' "$ROOT/infra/host/templates/env/mail.env.tmpl" | tr -d '\r')"
    [[ "$img" == *@sha256:* ]] || die "PROBE_CURL_IMAGE is not pinned by digest"
    pw="$(menv ROLES_IMAP_PASSWORD)"
    [[ -n "$pw" ]] || die "mail.env has no ROLES_IMAP_PASSWORD: provision roles@ first (gremion-mail-bringup)"
    scratch_tls && k=(-k)
    imap() { # <curl config body> -- one IMAP request, config on stdin
        printf '%s\nuser = "roles@%s:%s"\nresolve = "mail.%s:993:127.0.0.1"\n' "$1" "$dom" "$pw" "$dom" \
            | docker run --rm -i --name "${STACK}-imap-$$-${tries}" --network "container:${stal}" "$img" -sS ${k[@]+"${k[@]}"} -K - 2>/dev/null
    }
    # UID SEARCH, not SEARCH: the numbers must be UIDs for the ;UID= fetch
    # (sequence numbers drift once a message is expunged; review r4 LOW)
    while (( tries < 20 )); do
        uid="$(imap "url = \"imaps://mail.${dom}:993/INBOX\"
request = \"UID SEARCH TO \\\"$1\\\"\"" | tr -d '\r' | awk '/SEARCH/ { print $NF }' | tail -n1)" || uid=""
        if [[ "$uid" =~ ^[0-9]+$ ]]; then
            ( umask 077; imap "url = \"imaps://mail.${dom}:993/INBOX;UID=${uid}\"" > "$2" )
            [[ -s "$2" ]] && return 0
        fi
        tries=$(( tries + 1 )); sleep 3
    done
    return 1
}
# A file the HOST writes into etc/edge (the router files of `create`, the
# switch file) reaches Traefik's file provider through inotify. Docker
# Desktop's Windows bind mounts deliver none into a container (measured,
# test/host/integration/edge-proto.sh assert_file_watch): a file present at
# Traefik's start is read, one written later never is. On a SCRATCH stack
# only, after waiting for the watch, the harness re-writes each *.yml from
# INSIDE the engine (cp + mv in a throwaway container on the same mount, the
# bytes unchanged), which the watch does see; the nudge is recorded in
# ledger/edge-nudge.log. A host (Linux) never takes this path.
traefik_has() { # <api path>, e.g. http/routers/tenant-x.kc@file
    curl -fsS --max-time 3 "http://127.0.0.1:$(penv TRAEFIK_API_PORT)/api/$1" >/dev/null 2>&1
}
edge_nudge() {
    docker run --rm --name "${STACK}-edge-nudge-$$" -v "$(host_path "$(croot)/etc/edge"):/e" --entrypoint sh "$PG_IMAGE" \
        -c 'for f in /e/*.yml; do [ -f "$f" ] || continue; cp -p "$f" /e/.nudge.tmp && mv -f /e/.nudge.tmp "$f"; done'
}
edge_wait() { # <api path> -- 0 once Traefik reports it
    local s=0
    while (( s < 20 )); do traefik_has "$1" && return 0; sleep 2; s=$(( s + 2 )); done
    scratch_tls || return 1
    printf '%s %s not reported 20 s after the host wrote etc/edge: nudged from inside the engine\n' "$(now)" "$1" | ledger edge-nudge.log
    edge_nudge
    s=0
    while (( s < 30 )); do traefik_has "$1" && return 0; sleep 2; s=$(( s + 2 )); done
    return 1
}
# routers_enabled <slug>... -- TASK-043c P1. Traefik's STATE of both routers of
# each customer (tenant-<slug>@file and tenant-<slug>.kc@file): enabled, no
# error. A router whose chained @docker middleware does not exist is REPORTED
# but status "disabled" (the 043b run: "middleware edge-ratelimit-app@docker
# does not exist"), so presence proves nothing. Polled up to ~40 s (the docker
# provider converges after the file provider); the judge is
# fixtures/customer-provision/router-state.mjs (zero routers is a failure). The
# bodies are appended to ledger/edge-routers.txt; the violations are printed on
# stdout and the return is non-zero when any remain.
routers_enabled() { # <slug>...
    local slug rt body json next tries=0 out rc port
    port="$(penv TRAEFIK_API_PORT)"
    while :; do
        json='{}'
        for slug in "$@"; do
            for rt in "tenant-${slug}" "tenant-${slug}.kc"; do
                body="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/http/routers/${rt}@file" 2>/dev/null)" || body=""
                # a body jq cannot parse records THIS router as null ("not reported
                # by Traefik"); resetting the whole object dropped every router
                # collected so far, and the judge then passed a subset
                # (into a temporary: a failed substitution would empty $json)
                if next="$(jq -c --arg k "$rt" --argjson v "${body:-null}" '. + {($k): $v}' <<< "$json" 2>/dev/null)"; then json="$next"
                else json="$(jq -c --arg k "$rt" '. + {($k): null}' <<< "$json")"; fi
            done
        done
        rc=0
        out="$(node "$ROOT_H/test/host/fixtures/customer-provision/router-state.mjs" <<< "$json")" || rc=$?
        (( rc == 0 || tries >= 20 )) && break
        tries=$(( tries + 1 )); sleep 2
    done
    printf '%s %s\n' "$(now)" "$json" | ledger edge-routers.txt
    printf '%s' "$out"
    return "$rc"
}
# data_fingerprint <slug> -- TASK-043c R30 addendum A2 (PRD-OPS-004): suspend
# must not alter stored data. Prints one line per table (relkind r, outside
# pg_catalog / information_schema / pg_toast) of the customer's kernel database
# and of every ENABLED module that has a database (module.json
# runtime.database.postgresService; votes has none): "<scope>:<schema>.<table>
# TAB <row count> TAB <md5 over the rows ordered by their text form | ->", then
# "realm-users TAB <n>" (Keycloak users/count). The judge is
# fixtures/customer-provision/data-fingerprint.mjs (equal is the only pass; an
# empty fingerprint fails). Every read is checked explicitly (`|| return 1`):
# a caller runs this inside an `if`, where errexit is off.
FP_SQL="$(cat <<'SQL'
SELECT format('SELECT %L || E''\t'' || count(*) || E''\t'' || coalesce(md5(string_agg(t::text, E''\n'' ORDER BY t::text)), ''-'') FROM %I.%I t',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
 ORDER BY n.nspname, c.relname
SQL
)"
fp_db() { # <container> <user> <database> <scope> -- the table lines of one database
    local cid="$1" user="$2" db="$3" scope="$4" rows
    [[ -n "$cid" ]] || { info "fingerprint: no container for ${scope}" >&2; return 1; }
    rows="$(printf '%s \\gexec\n' "$FP_SQL" | docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -tAqU "$user" -d "$db" | tr -d '\r')" \
        || { info "fingerprint: reading ${scope} (${db}) failed" >&2; return 1; }
    [[ -n "$rows" ]] || { info "fingerprint: ${scope} (${db}) has no table" >&2; return 1; }
    sed '/^$/d; s/^/'"${scope}"':/' <<< "$rows"
}
data_fingerprint() { # <slug>
    local slug="$1" id hex mods m psvc sid n
    id="$(customer_id "$slug")" || return 1
    [[ -n "$id" ]] || { info "fingerprint: no control row for ${slug}" >&2; return 1; }
    hex="${id//-/}"
    printf '# fingerprint %s %s %s\n' "$slug" "$id" "$(now)"
    fp_db "$(svc state postgres)" postgres "t_${hex}__kernel" kernel || return 1
    mods="$(q gremion_platform "SELECT m.module_key FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = '${id}' AND e.state = 'enabled' ORDER BY 1")" || return 1
    for m in $mods; do
        psvc="$(jq -r '.runtime.database.postgresService // empty' "$ROOT/modules/${m}/module.json")" || return 1
        if [[ -z "$psvc" ]]; then printf '# %s: no database (module.json runtime.database null)\n' "$m"; continue; fi
        sid="${psvc%-postgres}"
        fp_db "$(svc state "$psvc")" "$sid" "t_${hex}__${m}" "$m" || return 1
    done
    n="$(skc get users/count -r "$slug" | tr -d '\r[:space:]')" || return 1
    [[ "$n" =~ ^[0-9]+$ ]] || { info "fingerprint: realm ${slug} user count unreadable (${n:-empty})" >&2; return 1; }
    printf 'realm-users\t%s\n' "$n"
}
trd440() { # the container count and every project's service list
    # every measurement must succeed (review C, r2): a failed render on both
    # sides compared equal; each project renders from its own directory
    local p dir out
    out="$(docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}')" || die "TRD-440: docker ps failed"
    # A scratch stack shares its engine with other lanes: their containers come
    # and go (measured: another lane's container stopped between before and
    # after, running 24 -> 23, this stack's 20 -> 20), so only this stack's
    # containers are counted there. A host counts every container.
    if scratch_tls; then out="$(awk -v p="${PSTACK}" 'index($1, p) == 1 || index($2, p) == 1' <<< "$out")"; fi
    printf 'running=%s\n' "$(grep -c . <<< "$out" || true)"
    for p in state app-blue app-green ops mail; do
        [[ -f "$PENV/$p.env" ]] || continue
        case "$p" in ops) dir="$ROOT/compose/observability" ;; mail) dir="$ROOT/infra/host/mail" ;; *) dir="$ROOT" ;; esac
        out="$(cd "$dir" && docker compose --env-file "$(host_path "$PENV/$p.env")" config --services)" || die "TRD-440: config --services failed for ${p}"
        [[ -n "$out" ]] || die "TRD-440: ${p} renders no service"
        printf '%s: %s\n' "$p" "$(sort <<< "$out" | tr '\n' ' ')"
    done
}

phase_customer_layout() {
    need_pooled no-operator
    [[ -z "${PROOF_GREMION_ROOT:-}" ]] || die "customer-layout lays out a SCRATCH root; PROOF_GREMION_ROOT names a real one"
    local r; r="$(croot)"; [[ -d "$r" ]] || die "the pooled stack's GREMION_ROOT ${r} is absent"
    # A fresh ${OUT} (no panel phase before it) has no ledger directory yet:
    # the switch.log redirect below failed and gremion-switch never ran.
    mkdir -p "$r/etc/env" "$r/runtime" "$r/etc/edge" "$r/logs" "$OUT/ledger"
    local f
    for f in state app-blue app-green mail ops; do [[ -f "$PENV/$f.env" ]] && cp "$PENV/$f.env" "$r/etc/env/$f.env"; done
    [[ -f "$r/runtime/active-colour" ]] || echo blue > "$r/runtime/active-colour"
    ok "customer-layout: ${r} carries etc/env, runtime/active-colour ($(cat "$r/runtime/active-colour")) and etc/edge"
    # The switch file a host's first deploy writes (etc/edge/active.yml: the
    # colour-bound service app@file every tenant router targets), by the
    # repo's own gremion-switch; --no-evict: no app process caches a tenant yet.
    # Without it every tenant router points at a service that does not exist.
    GREMION_ROOT="$(host_path "$r")" TRAEFIK_API="http://127.0.0.1:$(penv TRAEFIK_API_PORT)" \
        bash "$ROOT/infra/host/bin/gremion-switch" "$(cat "$r/runtime/active-colour")" --no-evict \
        > "$OUT/ledger/switch.log" 2>&1 || info "gremion-switch: $(tail -n1 "$OUT/ledger/switch.log")"
    if edge_wait "http/services/app@file"; then ok "customer-layout: etc/edge/active.yml written by gremion-switch; Traefik reports app@file"
    else bad "customer-layout: Traefik does not report app@file after gremion-switch (see ledger/switch.log)"; fi
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

# `gremion-tenant init`: the platform catalogue rows (plt.module_version, plt.module)
# and the ops realm. seed_gate_fixtures and the level-1 gate need them; before
# TASK-044's fix no phase ran it. Skipped when the catalogue is already loaded.
phase_customer_init() {
    need_pooled
    mkdir -p "$OUT/ledger"
    if [[ -n "$(q postgres "SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'")" ]]         && [[ "$(q gremion_platform "SELECT count(*) FROM plt.module_version")" -ge 1 ]]; then
        ok "customer-init: gremion_platform already carries the module catalogue (a rerun): init not repeated"
        return
    fi
    tenant init --panel-origin "https://${PANEL_HOST}" > "$OUT/ledger/init.log" 2>&1         || { tail -n 25 "$OUT/ledger/init.log" >&2; bad "customer-init: gremion-tenant init failed"; return; }
    if [[ "$(q gremion_platform "SELECT count(*) FROM plt.module_version")" -ge 1 ]]; then ok "customer-init: gremion-tenant init loaded the catalogue (plt.module_version rows present)"
    else bad "customer-init: init exited 0 but plt.module_version is empty"; fi
}

phase_customer_create_refuse() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json" out rc
    [[ -f "$cfg" ]] || die "the customer config fixture ${cfg} is absent"
    # R29-I1: board is refused BY NAME, before any write. "No write" is the
    # control registry and the ledger UNCHANGED across the refused call (not
    # "no row for X": a rerun after a failed create already has one).
    local snap_before snap_after
    snap() { printf '%s|%s' "$(q control "SELECT string_agg(slug || ':' || status, ',' ORDER BY slug) FROM tenant")" \
        "$(q postgres "SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'" | grep -q 1 && q gremion_platform "SELECT count(*) || ':' || coalesce(max(occurred_at)::text, '-') FROM plt.provisioning_step")"; }
    # R30 A1 (PRD-PLAT-012 / PRD-REC-003): vault is refused the same way.
    local denied
    for denied in board vault; do
        snap_before="$(snap)"
        rc=0; out="$(tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "$(admin_addr "$X" it)" \
            --council-admin "$(admin_addr "$X" rat)" --enable "calendar,${denied}" 2>&1)" || rc=$?
        snap_after="$(snap)"
        if (( rc != 0 )) && [[ "$out" == *"module ${denied} cannot be enabled"* ]] && [[ "$snap_before" == "$snap_after" ]]; then
            ok "customer-create: --enable ${denied} refused by name (exit ${rc}); the control registry and the ledger unchanged"
        else bad "customer-create: --enable ${denied} was not refused before any write (exit ${rc}; before ${snap_before}; after ${snap_after})"; fi
    done

}

phase_customer_create_x() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json"
    [[ -f "$cfg" ]] || die "the customer config fixture ${cfg} is absent"
    # TASK-044 section 9: the real gate. Without these rows the create below is REFUSED (NO_ISOLATION_RESULT).
    seed_gate_fixtures calendar,votes
    ok "customer-create: gate fixtures seeded (scratch-fixture: isolation rows, DPIA decisions in ledger/dpia.json)"
    tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "$(admin_addr "$X" it)" \
        --council-admin "$(admin_addr "$X" rat)" --enable calendar,votes --dpia-json "$OUT/ledger/dpia.json" > "$OUT/ledger/create-x.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/create-x.log" >&2; bad "customer-create: gremion-tenant create ${X} failed"; return; }
    ok "customer-create-x: gremion-tenant create ${X} (calendar, votes) exited 0"
}

phase_customer_create_y() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json"
    [[ -f "$cfg" ]] || die "the customer config fixture ${cfg} is absent"
    tenant create "$Y" --host "$(host_of "$Y")" --config "$cfg" --it-admin "$(admin_addr "$Y" it)" \
        --council-admin "$(admin_addr "$Y" rat)" > "$OUT/ledger/create-y.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/create-y.log" >&2; bad "customer-create: gremion-tenant create ${Y} failed"; return; }
    ok "customer-create: gremion-tenant create ${Y} exited 0"
}

phase_customer_create_check() {
    need_pooled
    local id kdb n
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
    if [[ "$(comm -13 "$OUT/ledger/dbs-calendar-before.txt" <(dbs_module calendar))" == "t_${id//-/}__calendar" ]]; then ok "customer-create: calendar-postgres gained exactly t_…__calendar"
    else bad "customer-create: calendar-postgres did not gain exactly t_${id//-/}__calendar"; fi
    # votes has no database (module.json database: null); vault was refused (R30 A1)
    # (read first: a failed read must not compare as "gained nothing")
    local vdbs
    if vdbs="$(dbs_module vault)" && [[ -z "$(comm -13 "$OUT/ledger/dbs-vault-before.txt" <(printf '%s\n' "$vdbs" | sed '/^$/d'))" ]]; then ok "customer-create: vault-postgres gained no database (vault refused, R30 A1)"
    else bad "customer-create: vault-postgres gained a database although vault is denied, or could not be read"; fi
    # The kernel database: gremion-ui's own ledger shape, no seed, one body.
    if [[ "$(q "$kdb" "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name = 'schema_migrations'")" == "applied_at,filename" ]]; then ok "customer-create: schema_migrations is gremion-ui's (filename, applied_at), no sha256 (Q3)"; else bad "customer-create: schema_migrations has another shape"; fi
    if [[ "$(q "$kdb" "SELECT count(*) FROM schema_migrations WHERE filename LIKE '%seed%'")" == 0 ]]; then ok "customer-create: no *_seed.sql applied (GREMION_DISABLE_SEEDS)"; else bad "customer-create: a seed file was applied"; fi
    # gremion-ui's 0010_org_units.sql RENAMED committees to org_units: a
    # committee is an org_units row of kind 'committee' (0038 kind catalogue).
    # The old `FROM committees` errored, so this check could never pass.
    local units; units="$(q "$kdb" "SELECT count(*) || ':' || coalesce(string_agg(kind, ','), '') || '/' || count(*) FILTER (WHERE kind = 'committee') FROM org_units")"
    if [[ "$units" == "1:council/0" ]]; then ok "customer-create: org_units = 1 (kind council), committees (org_units of kind committee) = 0"; else bad "customer-create: org_units count:kinds/committees ${units:-unreadable}, want 1:council/0"; fi
    # The realm: one group FOR THE FIRST BODY, two administrators, the
    # customer's own sender. The base realm template (realm-doc composes every
    # realm from it) carries its own groups (login, admin since ab45a0e5); they
    # are set aside, and the one remaining group is named like the council row.
    local base_groups body_name realm_groups
    base_groups="$(jq -c '[.groups[]?.name] | sort' "$ROOT/docker/keycloak/realm-export.base.json")"
    body_name="$(q "$kdb" "SELECT name FROM org_units WHERE kind = 'council'")"
    realm_groups="$(skc get groups -r "$X" --fields name | jq -c --argjson base "$base_groups" '[.[].name] - $base')"
    if [[ -n "$body_name" && "$realm_groups" == "[\"${body_name}\"]" ]]; then ok "customer-create: realm ${X} holds one group for the first body (${body_name}) beside the base template's ${base_groups}"
    else bad "customer-create: realm ${X} groups beyond the base template's ${base_groups}: ${realm_groups:-unreadable}, want [\"${body_name}\"]"; fi
    local users; users="$(skc get users -r "$X" --fields username,requiredActions | jq -c '[.[] | select(.username | startswith("service-account-") | not)] | length')"
    if [[ "$users" == 2 ]]; then ok "customer-create: two administrators in ${X}"; else bad "customer-create: ${users} user(s) in ${X}, want 2"; fi
    # 'smtpServer(*)': on Keycloak 26.6 a bare `--fields smtpServer` returns
    # the map EMPTY (measured), so every field read back as null
    local smtp; smtp="$(skc get "realms/$X" --fields 'smtpServer(*)' | jq -c '.smtpServer | [.user, .from, .host, .port, .starttls]')"
    if [[ "$smtp" == "[\"kc-${XT}@$(penv PLATFORM_DOMAIN)\",\"kc-${XT}@$(penv PLATFORM_DOMAIN)\",\"mail.$(penv PLATFORM_DOMAIN)\",\"587\",\"true\"]" ]]; then ok "customer-create: the realm sends as kc-${XT}@ through mail.<domain>:587 STARTTLS (R-E5b)"; else bad "customer-create: realm SMTP ${smtp}"; fi
    # The control row, the ledger, the broker, the router.
    if [[ "$(q control "SELECT count(*) FROM tenant_domain WHERE tenant_id = '${id}' AND is_primary")" == 1 ]]; then ok "customer-create: one primary tenant_domain row binds $(host_of "$X")"; else bad "customer-create: tenant_domain rows"; fi
    if [[ "$(q gremion_platform "SELECT count(DISTINCT step_kind) || '/' || count(*) FROM plt.provisioning_step WHERE customer_id = '${id}' AND status = 'done'")" == "8/8" ]]; then ok "customer-create: eight done ledger rows, one per kind (Q2)"; else bad "customer-create: the ledger is not eight done rows"; fi
    # R33 item 4: the post-condition behind handToReader -- every tenant secret
    # file is 0600 AND owned by the reader uid (a root:root file is EACCES to the readers).
    local tsd="${PROOF_TENANT_SECRETS_DIR:-$ROOT/secrets/tenants}" tsf tsbad=0 tsn=0 want_uid="${TENANT_SECRETS_UID:-1000}"
    while IFS= read -r tsf; do
        tsn=$(( tsn + 1 ))
        [[ "$(stat -c '%a %u' "$tsf")" == "600 ${want_uid}" ]] || { tsbad=1; info "secret ${tsf}: $(stat -c '%a %u' "$tsf"), want 600 ${want_uid}"; }
    done < <(find "$tsd" -type f 2>/dev/null)
    if (( tsn > 0 && tsbad == 0 )); then ok "customer-create: ${tsn} tenant secret file(s) are mode 0600 and owned by uid ${want_uid}"; else bad "customer-create: tenant secret files under ${tsd}: ${tsn} found, ownership/mode wrong (want 600 ${want_uid})"; fi
    local acc; acc="$(accounts)"
    if grep -q '# kernel@' <<< "$acc" && grep -q '# calendar@' <<< "$acc" && ! grep -q '# votes@' <<< "$acc"; then
        ok "customer-create: the broker account holds kernel and calendar users, none for votes (no flow, Q4)"
    else bad "customer-create: the broker account's users are not kernel+calendar"; fi
    if grep -qF "    tenant-${X}.kc:" "$(croot)/etc/edge/tenant-${X}.yml" 2>/dev/null; then ok "customer-create: etc/edge/tenant-${X}.yml carries the realm router (Q16, Q17)"; else bad "customer-create: no router file with the realm router"; fi
    local rt
    for rt in "tenant-${X}.kc" "tenant-${Y}.kc"; do
        edge_wait "http/routers/${rt}@file" || info "Traefik does not report the router ${rt}@file"
    done
    # TASK-043c P1: the STATE, not the presence (the 043b run: all four routers
    # reported, all four disabled by an undeclared @docker middleware).
    local rs
    if rs="$(routers_enabled "$X" "$Y")"; then ok "customer-create: Traefik reports tenant-${X}, tenant-${X}.kc, tenant-${Y} and tenant-${Y}.kc enabled with no error"
    else bad "customer-create: Traefik routers are not enabled: ${rs}"; fi
    if edge_served "$(host_of "$X")"; then ok "customer-create: $(host_of "$X") is served by gremion-ui through the edge (${EDGE_SHAPE})"
    else bad "customer-create: $(host_of "$X") is not served (${EDGE_SHAPE}; want 302/303 into /auth/login or 200 with gremion-ui's CSP)"; fi
}

phase_customer_create() {
    phase_customer_create_refuse
    phase_customer_create_x
    phase_customer_create_y
    phase_customer_create_check
}

phase_customer_rerun() {
    need_pooled
    local cfg="$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json" id before after b
    id="$(customer_id "$X")"
    before="$(q gremion_platform "SELECT count(*) FROM plt.provisioning_step WHERE customer_id = '${id}'")"
    tenant create "$X" --host "$(host_of "$X")" --config "$cfg" --it-admin "$(admin_addr "$X" it)" \
        --council-admin "$(admin_addr "$X" rat)" --enable calendar,votes > "$OUT/ledger/rerun-x.log" 2>&1 \
        || { tail -n 25 "$OUT/ledger/rerun-x.log" >&2; bad "customer-rerun: the second create failed"; return; }
    after="$(q gremion_platform "SELECT count(*) FROM plt.provisioning_step WHERE customer_id = '${id}'")"
    if [[ "$before" == "$after" ]]; then ok "customer-rerun: the ledger is unchanged (${after} rows)"; else bad "customer-rerun: the ledger grew ${before} -> ${after}"; fi
    # `|| true`: a missing phase-B line must reach the bad() branch below, not abort under errexit/pipefail
    b="$({ grep -h '^{"phase":"b"' "$OUT/ledger/rerun-x.log" || true; } | tail -n1)"
    if [[ "$(jq -c '[.reloaded, .ran]' <<< "${b:-{\}}")" == '[false,[]]' ]]; then ok "customer-rerun: phase B ran nothing and did not reload the broker"; else bad "customer-rerun: phase B was ${b:-silent}"; fi
    if [[ "$(grep -h '^{"phase":"a"' "$OUT/ledger/rerun-x.log" | tail -n1 | jq -c '.ran')" == '[]' ]]; then ok "customer-rerun: phase A ran nothing"; else bad "customer-rerun: phase A ran steps"; fi
}

phase_customer_suspend() {
    need_pooled
    # R30 A2 (PRD-OPS-004): the stored-data fingerprint BEFORE suspend; customer-resume
    # compares it with the one taken right after resume. No fingerprint, no suspend:
    # without the baseline the "suspend alters no stored data" line cannot be proven.
    rm -f "$OUT/ledger/fingerprint-before-suspend.txt" "$OUT/ledger/fingerprint-after-resume.txt"
    if data_fingerprint "$X" > "$OUT/ledger/fingerprint-before-suspend.txt"; then
        ok "customer-suspend: stored-data fingerprint of ${X} recorded before suspend ($(grep -c $'\t[0-9]*\t' "$OUT/ledger/fingerprint-before-suspend.txt" || true) table(s), $(sed -n 's/^realm-users\t//p' "$OUT/ledger/fingerprint-before-suspend.txt") realm user(s))"
    else rm -f "$OUT/ledger/fingerprint-before-suspend.txt"; bad "customer-suspend: the stored-data fingerprint of ${X} could not be taken"; return; fi
    tenant suspend "$X" > "$OUT/ledger/suspend-x.log" 2>&1 || { tail -n 20 "$OUT/ledger/suspend-x.log" >&2; bad "customer-suspend: suspend failed"; return; }
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${X}'")" == suspended ]]; then ok "customer-suspend: status suspended"; else bad "customer-suspend: status"; fi
    if [[ "$(skc get "realms/$X" --fields enabled | jq -r .enabled)" == false ]]; then ok "customer-suspend: realm ${X} disabled (no sign-in, no token)"; else bad "customer-suspend: realm still enabled"; fi
    if [[ "$(edge_status "$(host_of "$X")")" == 503 ]]; then ok "customer-suspend: $(host_of "$X") answers 503 (no tenant content)"; else bad "customer-suspend: $(host_of "$X") answers $(edge_status "$(host_of "$X")")"; fi
    if grep -q '# calendar@' <<< "$(accounts)"; then bad "customer-suspend: the calendar broker user is still rendered"; else ok "customer-suspend: the module broker users are evicted"; fi
    local n
    if n="$(principal_count "$XT")" && [[ "$n" == 0 ]]; then ok "customer-suspend: the principal kc-${XT}@ is revoked (R-E5a; principals list rc 0, KC-PRINCIPALS: 0)"
    else bad "customer-suspend: the principal is not provably revoked (principals list: ${n:-failed})"; fi
    # TASK-043c P2: the realm carries no authenticating sender (Keycloak 26.6.1
    # refused the old blank-sender payload and the principal had already been
    # deleted: the 043b run), and a SECOND suspend converges and changes nothing.
    local smtp
    smtp="$(skc get "realms/$X" --fields 'smtpServer(*)' | jq -c '(.smtpServer // {}) | [.user, .from, .auth]')" || smtp=""
    if [[ -n "$smtp" ]] && jq -e '(.[0] // "") == "" and (.[1] // "") == "" and ((.[2] // "") | tostring) != "true"' <<< "$smtp" >/dev/null; then ok "customer-suspend: realm ${X} carries no authenticating sender (smtpServer user/from/auth: ${smtp})"
    else bad "customer-suspend: realm ${X} still carries a sender (smtpServer user/from/auth: ${smtp:-unreadable})"; fi
    if tenant suspend "$X" > "$OUT/ledger/suspend-x-2.log" 2>&1; then
        if grep -q 'changed=no action=revoked' "$OUT/ledger/suspend-x-2.log" && n="$(principal_count "$XT")" && [[ "$n" == 0 ]] \
           && [[ "$(q control "SELECT status FROM tenant WHERE slug = '${X}'")" == suspended ]]; then ok "customer-suspend: a second suspend exits 0 and changes nothing (REALM-SMTP changed=no, no principal, still suspended)"
        else bad "customer-suspend: the second suspend exited 0 but did not converge to a no-op (see ledger/suspend-x-2.log)"; fi
    else tail -n 20 "$OUT/ledger/suspend-x-2.log" >&2; bad "customer-suspend: a second suspend failed (it must be idempotent)"; fi
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${Y}'")" == active ]] && edge_served "$(host_of "$Y")"; then ok "customer-suspend: ${Y} is untouched (active, served: ${EDGE_SHAPE})"
    else bad "customer-suspend: ${Y} was affected (${EDGE_SHAPE})"; fi
}

phase_customer_resume() {
    need_pooled
    tenant resume "$X" > "$OUT/ledger/resume-x.log" 2>&1 || { tail -n 20 "$OUT/ledger/resume-x.log" >&2; bad "customer-resume: resume failed"; return; }
    # R30 A2 (PRD-OPS-004): taken right after resume, before any request reaches
    # the host; equal to the one customer-suspend took is the only pass.
    local fpv fprc=0
    if [[ ! -s "$OUT/ledger/fingerprint-before-suspend.txt" ]]; then
        bad "customer-resume: no stored-data fingerprint from before suspend (run customer-suspend in the same \${OUT})"
    elif ! data_fingerprint "$X" > "$OUT/ledger/fingerprint-after-resume.txt"; then
        bad "customer-resume: the stored-data fingerprint of ${X} could not be taken after resume"
    else
        fpv="$(node "$ROOT_H/test/host/fixtures/customer-provision/data-fingerprint.mjs" compare \
            "$(host_path "$OUT/ledger/fingerprint-before-suspend.txt")" "$(host_path "$OUT/ledger/fingerprint-after-resume.txt")")" || fprc=$?
        printf '%s rc=%s %s\n' "$(now)" "$fprc" "$(tr '\n' ';' <<< "$fpv")" | ledger fingerprint-compare.txt
        if (( fprc == 0 )); then ok "customer-resume: the stored data of ${X} is unchanged across suspend and resume (every table's row count and checksum, the realm's user count)"
        else bad "customer-resume: suspend/resume altered stored data of ${X}: $(tr '\n' ';' <<< "$fpv")"; fi
    fi
    if [[ "$(q control "SELECT status FROM tenant WHERE slug = '${X}'")" == active ]]; then ok "customer-resume: status active"; else bad "customer-resume: status"; fi
    if [[ "$(skc get "realms/$X" --fields enabled | jq -r .enabled)" == true ]]; then ok "customer-resume: realm enabled"; else bad "customer-resume: realm still disabled"; fi
    if edge_served "$(host_of "$X")"; then ok "customer-resume: $(host_of "$X") is served by gremion-ui again (${EDGE_SHAPE})"
    else bad "customer-resume: $(host_of "$X") is not served (${EDGE_SHAPE})"; fi
    local rs
    if rs="$(routers_enabled "$X" "$Y")"; then ok "customer-resume: Traefik reports both routers of ${X} and of ${Y} enabled with no error"
    else bad "customer-resume: Traefik routers are not enabled: ${rs}"; fi
    if grep -q '# calendar@' <<< "$(accounts)"; then ok "customer-resume: the calendar broker user is back"; else bad "customer-resume: no calendar broker user"; fi
    local n
    if n="$(principal_count "$XT")" && [[ "$n" == 1 ]]; then ok "customer-resume: a fresh principal kc-${XT}@ exists (KC-PRINCIPALS: 1)"
    else bad "customer-resume: no provable principal (principals list: ${n:-failed})"; fi
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
    # Against the laid-out root, as principal_count() runs the host tools: without
    # GREMION_ROOT it read /opt/gremion/etc/env/mail.env ("mail env file not found").
    # Git Bash ONLY: the tool's `mktemp -d` work directory is an MSYS /tmp path,
    # which a native jq.exe cannot open and Docker Desktop mounts as an EMPTY VM
    # directory (measured: "Could not open file /tmp/tmp.X/principals.json",
    # node ENOENT). TMPDIR in host form (C:/...) under ${OUT} serves both; the
    # tool's own trap removes the directory. A Linux host never takes this path.
    local -a tmpenv=()
    if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
        mkdir -p "$OUT/tmp"; chmod 700 "$OUT/tmp" 2>/dev/null || true
        tmpenv=(TMPDIR="$(host_path "$OUT/tmp")")
    fi
    if env ${tmpenv[@]+"${tmpenv[@]}"} MSYS_NO_PATHCONV=1 GREMION_ROOT="$(host_path "$(croot)")" GREMION_RELEASE_DIR="$ROOT_H" \
        bash "$ROOT/infra/host/bin/gremion-vendor-mail" check-principals --host --no-allowances > "$OUT/ledger/check-principals.log" 2>&1; then
        ok "customer-reconcile: check-principals --no-allowances is green over two customers (Q14)"
    else bad "customer-reconcile: check-principals failed"; fi
}

# Brief section 1 "Admins sign in" (PRD-IDN-005, Q16).
phase_customer_admins() {
    need_pooled
    local dom host realm_url port tiss disc role krole addr uid out DASHBOARD_TITLE
    local -a tls=()
    # read from the tested source, so a renamed dashboard cannot pass on a stale literal
    # A fresh ${OUT} (no panel phase before it) has no secrets directory:
    # imap_fetch's `> $OUT/secrets/admin-<role>.eml` failed on every try
    # (measured: 40 x "No such file or directory"), read as "no mail arrived".
    mkdir -p "$OUT/secrets"; chmod 700 "$OUT/secrets" 2>/dev/null || true
    DASHBOARD_TITLE="$(sed -n 's/.*<PageTitle title="\([^"]*\)".*/\1/p' "$ROOT/gremion-ui/src/routes/+page.svelte" | head -n1)"
    [[ -n "$DASHBOARD_TITLE" ]] || die "customer-admins: no PageTitle in gremion-ui/src/routes/+page.svelte"
    dom="$(penv PLATFORM_DOMAIN)"; host="$(host_of "$X")"; realm_url="https://${host}/auth/realms/${X}"
    port="$(penv EDGE_HTTPS_PORT)"; port="${port:-443}"
    scratch_tls && tls=(--insecure yes)
    # Q16: the realm's discovery through the customer's OWN host (the realm router).
    tiss="$(q control "SELECT issuer FROM tenant WHERE slug = '${X}'")"
    disc="$(curl -ksS --max-time 20 --resolve "${host}:${port}:127.0.0.1" \
        "https://${host}:${port}/auth/realms/${X}/.well-known/openid-configuration" 2>/dev/null | jq -r '.issuer // empty' 2>/dev/null)" || disc=""
    if [[ -n "$disc" && "$disc" == "$realm_url" && "$tiss" == "$realm_url" ]]; then
        ok "customer-admins: discovery through https://${host}/auth/realms/${X} names issuer ${disc} = tenant.issuer"
    else bad "customer-admins: discovery issuer '${disc:-none}', tenant.issuer '${tiss:-none}', want ${realm_url}"; fi
    for role in it rat; do
        [[ "$role" == it ]] && krole=it-admin || krole=council-admin
        addr="$(admin_addr "$X" "$role")"
        uid="$(skc get users -r "$X" -q "email=${addr}" --fields id | jq -r '.[0].id // empty')"
        if [[ -n "$uid" ]] && skc get "users/${uid}/role-mappings/realm" -r "$X" | jq -e --arg r "$krole" 'any(.[]; .name == $r)' >/dev/null; then
            ok "customer-admins: ${addr} holds the realm role ${krole}"
        else bad "customer-admins: ${addr} is absent or lacks the realm role ${krole}"; fi
        if ! imap_fetch "$addr" "$OUT/secrets/admin-${role}.eml"; then
            bad "customer-admins: no execute-actions mail to ${addr} reached roles@ on Stalwart"; continue
        fi
        if out="$(session mail-link --mail-file "$(host_path "$OUT/secrets/admin-${role}.eml")" --from "kc-${XT}@${dom}" \
                --realm-url "$realm_url" --link-out "$(host_path "$OUT/secrets/admin-${role}.link")" 2> "$OUT/ledger/admin-${role}-mail.err")"; then
            printf '%s %s\n' "$(now)" "$out" | ledger admin-mail.log
            ok "customer-admins: the execute-actions mail to ${addr} is from kc-${XT}@${dom} and links under ${realm_url}"
        else bad "customer-admins: the mail to ${addr}: $(tail -n1 "$OUT/ledger/admin-${role}-mail.err")"; continue; fi
        printf 'Admin-%s-%s\n' "$(gen)" "Aa1!" | secret_file "admin-${role}-pw"
        if out="$(session activate --link-file "$(host_path "$OUT/secrets/admin-${role}.link")" --resolve "${host}=https://127.0.0.1:${port}" \
                ${tls[@]+"${tls[@]}"} --new-password-file "$(host_path "$OUT/secrets/admin-${role}-pw")" \
                --totp-secret-out "$(host_path "$OUT/secrets/admin-${role}-totp")" 2> "$OUT/ledger/admin-${role}-activate.err")"; then
            printf '%s %s\n' "$(now)" "$(jq -c 'del(.trace)' <<< "$out")" | ledger admin-activate.log
            ok "customer-admins: ${krole} completed UPDATE_PASSWORD and CONFIGURE_TOTP through the link ($(jq -c .kinds <<< "$out"))"
        else bad "customer-admins: ${krole} could not complete the actions: $(tail -n1 "$OUT/ledger/admin-${role}-activate.err")"; continue; fi
        # --title: the dashboard's PageTitle segment (gremion-ui routes/+page.svelte
        # `<PageTitle title="Übersicht" />`, rendered "<segment> – <product>")
        if out="$(session signin --app "https://${host}" --realm-url "$realm_url" --user "$addr" --title "$DASHBOARD_TITLE" \
                --password-file "$(host_path "$OUT/secrets/admin-${role}-pw")" --totp-secret-in "$(host_path "$OUT/secrets/admin-${role}-totp")" \
                --resolve "${host}=https://127.0.0.1:${port}" ${tls[@]+"${tls[@]}"} 2> "$OUT/ledger/admin-${role}-signin.err")"; then
            printf '%s %s\n' "$(now)" "$(jq -c 'del(.trace)' <<< "$out")" | ledger admin-signin.log
            ok "customer-admins: ${krole} signed in with password + TOTP through $(jq -r .authorize <<< "$out"); / answered 200 with the dashboard PageTitle"
        else bad "customer-admins: ${krole} sign-in: $(tail -n1 "$OUT/ledger/admin-${role}-signin.err") ${out}"; fi
    done
}

# ── admins rehearsal (scratch; plain docker run) ───────────────────────────
RH_NET="${STACK}-rh-net"
RH_KC="${STACK}-rh-kc"
RH_SINK="${STACK}-rh-sink"
RH_REALM=proof-r
RH_HOST=rat.proof-r.test
NODE_IMAGE="node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8"
rh_set() { mkdir -p "$OUT"; printf '%s=%s\n' "$1" "$2" >> "$OUT/rehearsal.env"; }
rh_get() { [[ -f "$OUT/rehearsal.env" ]] || die "no ${OUT}/rehearsal.env: run rehearsal-up first"; sed -n "s/^$1=//p" "$OUT/rehearsal.env" | tail -n1; }
rkc() { docker exec -i "$RH_KC" /opt/keycloak/bin/kcadm.sh "$@"; }

phase_rehearsal_up() {
    require_scratch rehearsal-up
    mkdir -p "$OUT/ledger"; : > "$OUT/rehearsal.env"
    gen | secret_file rh-kc-admin
    local p; p="$(free_port)"; rh_set RH_KC_PORT "$p"
    docker network inspect "$RH_NET" >/dev/null 2>&1 || docker network create "$RH_NET" >/dev/null
    docker run -d --name "$RH_SINK" --network "$RH_NET" --tmpfs /out \
        -v "$(host_path "$ROOT/test/host/fixtures/customer-provision/smtp-sink.mjs"):/sink.mjs:ro" "$NODE_IMAGE" node /sink.mjs >/dev/null
    # Configured like the pooled stack's Keycloak (docker-compose.yml, .prod.yml):
    # no --hostname, so every URL it builds follows the request -- or the
    # realm's frontendUrl.
    KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$OUT/secrets/rh-kc-admin")" docker run -d --name "$RH_KC" --network "$RH_NET" \
        -p "127.0.0.1:${p}:8080" -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD \
        -e KC_HOSTNAME_STRICT=false -e KC_PROXY_HEADERS=xforwarded -e KC_HTTP_RELATIVE_PATH=/auth -e KC_HTTP_ENABLED=true \
        -v "$(host_path "$ROOT/docker/keycloak/themes"):/opt/keycloak/themes:ro" "$KC_IMAGE" start-dev >/dev/null
    ok "rehearsal-up: ${RH_SINK} and ${RH_KC} (no --hostname, the gremion theme) on 127.0.0.1:${p}"
}

rh_mail_to() { # <address> <out file>: the newest message the sink stored for it
    local f
    for _ in $(seq 1 20); do
        f="$(docker exec "$RH_SINK" sh -c 'grep -l -i "^To: .*$0" /out/*.eml 2>/dev/null | sort | tail -n1' "$1" || true)"
        if [[ -n "$f" ]]; then ( umask 077; docker exec "$RH_SINK" cat "$f" > "$2" ); [[ -s "$2" ]] && return 0; fi
        sleep 1
    done
    return 1
}

phase_rehearsal_run() {
    require_scratch rehearsal-run
    local p realm_url addr uid out n_before RH_APP_URL
    p="$(rh_get RH_KC_PORT)"; realm_url="http://${RH_HOST}:${p}/auth/realms/${RH_REALM}"; RH_APP_URL="http://${RH_HOST}:${p}"
    addr="roles+${RH_REALM}-it@proof.test"
    local s=0
    until curl -fsS "http://127.0.0.1:${p}/auth/realms/master" >/dev/null 2>&1; do (( s++ < 60 )) || die "keycloak never answered"; sleep 3; done
    KC_LOGIN_PASSWORD="$(cat "$OUT/secrets/rh-kc-admin")" docker exec -e KC_LOGIN_PASSWORD "$RH_KC" sh -c \
        '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user admin --password "$KC_LOGIN_PASSWORD" >/dev/null'
    # The realm as the provisioner makes it, in the parts this flow touches:
    # the gremion login theme, the base OTP policy, the customer's own sender.
    rkc create realms -s "realm=${RH_REALM}" -s enabled=true -s sslRequired=external -s loginTheme=gremion \
        -s otpPolicyType=totp -s otpPolicyAlgorithm=HmacSHA1 -s otpPolicyDigits=6 -s otpPolicyPeriod=30 \
        -s "smtpServer.host=${RH_SINK}" -s smtpServer.port=2525 -s "smtpServer.from=kc-proof_r@proof.test" >/dev/null
    # Q16 shape: the stand-in client's callback is on the realm's OWN host, as
    # gremion-ui's is (review r4 HIGH: a separate app host hid a driver that
    # stopped on Keycloak's first page).
    rkc create clients -r "$RH_REALM" -s clientId=rehearsal-app -s publicClient=true -s standardFlowEnabled=true \
        -s "redirectUris=[\"${RH_APP_URL}/auth/callback/keycloak\"]" >/dev/null
    uid="$(rkc create users -r "$RH_REALM" -s "username=${addr}" -s "email=${addr}" -s enabled=true \
        -s 'requiredActions=["UPDATE_PASSWORD","CONFIGURE_TOTP"]' -i | tr -d '\r')"
    # 1. WITHOUT frontendUrl (the provisioner before r4): the admin call goes to
    #    the internal address, and so does the mailed link -- refused.
    printf '["UPDATE_PASSWORD","CONFIGURE_TOTP"]' | rkc update "users/${uid}/execute-actions-email" -r "$RH_REALM" -q lifespan=3600 -f - >/dev/null
    rh_mail_to "$addr" "$OUT/secrets/rh-mail-1.eml" || die "the sink stored no execute-actions mail"
    if out="$(session mail-link --mail-file "$(host_path "$OUT/secrets/rh-mail-1.eml")" --from kc-proof_r@proof.test \
            --realm-url "$realm_url" --link-out "$(host_path "$OUT/secrets/rh-link-1")" 2>&1)"; then
        bad "rehearsal: a realm without frontendUrl mailed a link under ${realm_url} (${out})"
    else ok "rehearsal: without frontendUrl the link names the admin call's address and mail-link refuses it ($(grep -o 'no execute-actions link.*' <<< "$out" | head -n1))"; fi
    # 2. WITH the realm doc's frontendUrl (realm-doc.ts frontendUrlFor).
    rkc update "realms/${RH_REALM}" -s "attributes.frontendUrl=http://${RH_HOST}:${p}/auth" >/dev/null
    n_before="$(docker exec "$RH_SINK" sh -c 'ls /out | wc -l' | tr -d ' \r')"
    printf '["UPDATE_PASSWORD","CONFIGURE_TOTP"]' | rkc update "users/${uid}/execute-actions-email" -r "$RH_REALM" -q lifespan=3600 -f - >/dev/null
    for _ in $(seq 1 20); do [[ "$(docker exec "$RH_SINK" sh -c 'ls /out | wc -l' | tr -d ' \r')" -gt "$n_before" ]] && break; sleep 1; done
    rh_mail_to "$addr" "$OUT/secrets/rh-mail-2.eml" || die "the sink stored no second mail"
    if out="$(session mail-link --mail-file "$(host_path "$OUT/secrets/rh-mail-2.eml")" --from kc-proof_r@proof.test \
            --realm-url "$realm_url" --link-out "$(host_path "$OUT/secrets/rh-link-2")" 2> "$OUT/ledger/rh-mail.err")"; then
        ok "rehearsal: with frontendUrl the real Keycloak mail parses: $(jq -c . <<< "$out")"
    else bad "rehearsal: mail-link on the frontendUrl mail: $(tail -n1 "$OUT/ledger/rh-mail.err")"; return; fi
    printf 'Admin-%s-%s\n' "$(gen)" "Aa1!" | secret_file rh-pw
    if out="$(session activate --link-file "$(host_path "$OUT/secrets/rh-link-2")" --resolve "${RH_HOST}=http://127.0.0.1:${p}" \
            --new-password-file "$(host_path "$OUT/secrets/rh-pw")" --totp-secret-out "$(host_path "$OUT/secrets/rh-totp")" \
            2> "$OUT/ledger/rh-activate.err")"; then
        ok "rehearsal: activate completed $(jq -c .kinds <<< "$out") and ended on: $(jq -r .page <<< "$out" | cut -c1-80)"
    else bad "rehearsal: activate: $(tail -n1 "$OUT/ledger/rh-activate.err") ${out}"; return; fi
    local az cb
    cb="$(jq -rn --arg u "${RH_APP_URL}/auth/callback/keycloak" '$u|@uri')"
    az="${realm_url}/protocol/openid-connect/auth?client_id=rehearsal-app&response_type=code&scope=openid&redirect_uri=${cb}&state=t043"
    if out="$(session signin --app "$RH_APP_URL" --authorize-url "$az" --stop-host "$RH_HOST" --realm-url "$realm_url" \
            --user "$addr" --password-file "$(host_path "$OUT/secrets/rh-pw")" --totp-secret-in "$(host_path "$OUT/secrets/rh-totp")" \
            --resolve "${RH_HOST}=http://127.0.0.1:${p}" 2> "$OUT/ledger/rh-signin.err")"; then
        ok "rehearsal: signin through the gremion theme with password + TOTP: $(jq -c . <<< "$out")"
    else bad "rehearsal: signin: $(tail -n1 "$OUT/ledger/rh-signin.err") ${out}"; fi
    printf '%s rehearsal-run\n' "$(now)" | ledger run.log
}

phase_rehearsal_down() {
    require_scratch rehearsal-down
    docker rm -f -v "$RH_KC" "$RH_SINK" >/dev/null 2>&1 || true
    docker network rm "$RH_NET" >/dev/null 2>&1 || true
    if [[ -z "$(docker ps -aq --filter "name=^${STACK}-rh-")$(docker network ls -q --filter "name=^${RH_NET}$")" ]]; then
        ok "rehearsal-down: no ${STACK}-rh-* container or network remains"
    else bad "rehearsal-down left resources"; fi
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
        customer-init) phase_customer_init ;;
        customer-create) phase_customer_create ;;
        customer-create-refuse) phase_customer_create_refuse ;;
        customer-create-x) phase_customer_create_x ;;
        customer-create-y) phase_customer_create_y ;;
        customer-create-check) phase_customer_create_check ;;
        customer-rerun) phase_customer_rerun ;;
        customer-suspend) phase_customer_suspend ;;
        customer-resume) phase_customer_resume ;;
        customer-reconcile) phase_customer_reconcile ;;
        customer-admins) phase_customer_admins ;;
        customer-after) phase_customer_after ;;
        rehearsal-up) phase_rehearsal_up ;;
        rehearsal-run) phase_rehearsal_run ;;
        rehearsal-down) phase_rehearsal_down ;;
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
