#!/usr/bin/env bash
# ============================================================
# The pooled stack's RUNNING proof (TASK-040; TRD-440, TRD-038, TRD-177,
# TRD-045). The static half is scripts/check-pooled-stack.mjs.
#
#   bash test/host/integration/pooled-stack-proof.sh all        # scratch stack, then teardown
#   bash test/host/integration/pooled-stack-proof.sh <phase>... # one phase per call
#
# Phases, in order (each is its own call so no single step outlives a
# supervisor's time box; state lives in the ledger directory):
#   prepare      env files, scratch root, externals, the proof overlays
#                (render-env: the env files and overlays alone, no engine)
#   names        every rendered name is under ${STACK}; state-up refuses without it
#   state-up     the state project (production profile)
#   state-wait   postgres + keycloak healthy, pgbouncer auth staged; records
#                the state snapshot (container IDs, volume CreatedAt)
#   app-up C     migrate one-shot (run --rm) then `up` of app-C
#   app-wait C   app-C healthy, /healthz reports "colour":"C", isolation
#   aux-up       the non-council ops and mail projects
#   mail-roles   the vendor mail server's principals and roles@ mailbox by the
#                repo's own infra/host/mail/provision-roles.sh (TASK-043's
#                customer half reads the execute-actions mail there)
#   mail-realm   bring-up step 2: gremion-vendor-mail realm-smtp (master ->
#                system@), which check-principals requires
#   limits      HostConfig.Memory and NanoCpus > 0 on every container
#   rss          idle RSS below 80 % of the limit on every container
#   isolation    project classification, network membership
#   probes       TCP probes: positive control from _state, then each non-council net
#   tenant-before / tenant / tenant-after
#                TRD-440: a second tenant adds no container and no project
#   switch       blue -> green: state IDs and volume CreatedAt unchanged
#   cold-state   stop the state tier, re-boot the app colour against it (not
#                ready while state is down), start state: /api/health ready
#   teardown     docker rm -f / network rm / volume rm, by the ${STACK} prefix
#
# Scratch safety (TASK-040 brief §5): STACK=t040-<sha8> names every project,
# network and volume; the env files are unique and gitignored (under
# .scratch/); every host port is 127.0.0.1 and freshly allocated. This script
# NEVER runs `docker compose down`, never prunes, and never touches a
# resource outside the ${STACK} prefix. Teardown removes containers by the
# compose project label, then networks and volumes by name prefix.
#
# On the live host (TASK-038, after the re-init) run ONLY the check phases
# against the real env files, and never prepare/up/teardown:
#   POOLED_STACK=<stack> POOLED_ENV_DIR=/opt/gremion/etc/env POOLED_SCOPE=host \
#     bash test/host/integration/pooled-stack-proof.sh limits rss isolation probes
# POOLED_SCOPE=host classifies EVERY compose project on the host (the R26-1
# sales site included); the scratch default classifies the ${STACK}-* ones.
#
# POOLED_CUSTOMER=1 (TASK-043's customer half, customer-provision-proof.sh
# customer-*): render-env adds the calendar and vault module servers to the
# state profiles, publishes the vendor mail server's submission port on
# 127.0.0.1:587 and its management API on the host's 127.0.0.1:8086 (the only
# STALWART_ADMIN_URL gremion-vendor-mail accepts), takes the six module
# server credentials from gremion-init-secrets (TASK-043b F5), and lets the
# state Keycloak reach mail.<PLATFORM_DOMAIN>:587
# through host-gateway, trusting the scratch mail certificate. SCRATCH
# DEVIATIONS (a scratch box has no public DNS, no ACME, no LE certificate): the
# mail server carries a self-signed certificate for mail.<PLATFORM_DOMAIN>
# instead of the [acme] block, and Keycloak's truststore names it.
#
# RUN AS ROOT ON LINUX (like production: gremion-tenant's require_root). The
# containers write their secrets into the bind-mounted scratch root as their
# own uid; a non-root invoker then cannot read, replace or remove them. Run it
# the way the host does, keeping HOME and PATH (toolchain, docker config):
#   sudo -E env "HOME=$HOME" "PATH=$PATH" bash test/host/integration/pooled-stack-proof.sh all
# On Docker Desktop (Windows, macOS) the invoking user is enough. A permission
# error on the scratch dirs prints this hint (perm_hint).
#
# LINUX HOST DEFAULTS (POOLED_CUSTOMER=1, Docker Engine): host-gateway is the
# docker0 address, not host loopback, so the state Keycloak cannot reach a mail
# server bound to 127.0.0.1:587. render-env then also publishes 587 on the
# host-gateway address (detected from the default bridge; PROOF_HOST_GATEWAY_IP
# overrides it; Docker Desktop is left alone, 127.0.0.1 works there).
# PROOF_OPS_BIND_IP moves the proof ops project's OPS_BIND_IP and
# OPS_INGEST_BIND_IP off 127.0.0.1 when another ops stack holds 3000/4317.
#
# Every assertion reads a post-condition (docker inspect, docker stats, a TCP
# connect, a database row), never an exit code alone. Zero containers, zero
# probe targets, a failed positive control, an unclassified project or an
# empty ledger file is a FAILURE, never a vacuous pass.
#
# Guard-efficacy runs (a stray unlimited container, a starved Keycloak limit)
# write their RED ledger under their own POOLED_OUT, never over the green
# ledger that records TRD-177/045/440/038. run.log names the phases each run
# executed and its RED verdict.
# ============================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT_H="$(host_path "$ROOT")"
# git only when the stack name is derived (the shim tests and the live host
# name it, and a bats container cannot read a Windows worktree's .git file).
if [[ -n "${POOLED_STACK:-}" ]]; then STACK="$POOLED_STACK"
else STACK="t040-$(git -C "$ROOT_H" rev-parse --short=8 HEAD)"; fi
SCOPE="${POOLED_SCOPE:-stack}"
IMAGE_TAG_PROOF="${POOLED_IMAGE_TAG:-t040-proof}"
OUT_REL=".scratch/pooled-stack-proof/${STACK}"
OUT="${POOLED_OUT:-${ROOT}/${OUT_REL}}"
ENV_DIR="${POOLED_ENV_DIR:-${OUT}/env}"
SROOT="${OUT}/root"              # the scratch GREMION_ROOT
PROBE_IMAGE="postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
TENANT_SLUG="${POOLED_TENANT_SLUG:-t040-b}"   # its config is always the t040-b fixture
# The host cold-state registers for the default tenant (the scratch
# PLATFORM_DOMAIN): /api/health resolves a tenant like every edge request.
PROOF_HOST="proof.example.org"

RED=0
FAILS=0   # a counter, so a phase can tell whether ITS checks failed
ok()   { printf '  ok   %s\n' "$*"; }
# bad() must run in the proof's own shell: inside a command substitution
# ($(...)) or a pipeline it only sets a subshell's RED and the run stays GREEN.
bad()  { printf '  FAIL %s\n' "$*" >&2; RED=1; FAILS=$(( FAILS + 1 )); }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
info() { printf '[pooled-proof] %s\n' "$*"; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
ledger() { # <file> -- appends stdin to the dated ledger file
    mkdir -p "$OUT/ledger"
    cat >> "$OUT/ledger/$1"
}

command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"

is_scratch() { [[ "$STACK" == t040-* ]]; }
require_scratch() { is_scratch || die "phase '$1' brings resources up or down and runs only on a t040-* scratch stack (STACK=$STACK)"; }

# perm_hint [path...] -- prints the run-as-root hint when a permission problem
# is plausibly the cause: Linux, not root, and a path (or, if it does not exist
# yet, its nearest existing ancestor) that this user cannot both read and write.
# Prints nothing otherwise, so it is safe to append to any die message.
perm_hint() {
    [[ "$(uname -s)" == Linux && "$(id -u)" != 0 ]] || return 0
    local p
    for p in "$@"; do
        while [[ -n "$p" && ! -e "$p" && "$p" != / && "$p" != . ]]; do p="$(dirname "$p")"; done
        [[ -e "$p" && ( ! -r "$p" || ! -w "$p" ) ]] || continue
        # shellcheck disable=SC2016  # the $HOME / $PATH are LITERAL text of the command to copy
        printf ' (permission denied on %s: on Linux this proof runs as root, like production -- sudo -E env "HOME=$HOME" "PATH=$PATH" bash test/host/integration/pooled-stack-proof.sh ...)' "$p"
        return 0
    done
}
# need_writable <dir>... -- each exists (made if absent) and is writable, or die with the hint.
need_writable() {
    local d
    for d in "$@"; do
        { mkdir -p "$d" 2>/dev/null && [[ -w "$d" ]]; } || die "cannot write ${d}$(perm_hint "$d")"
    done
}

# scratch_rm <path> -- removes a scratch tree, and ONLY one: the path must
# resolve (symlinks and .. followed) to somewhere strictly under ${ROOT}/.scratch
# with ${STACK} as a whole path component. Anything else is refused (bad(), no
# removal): a mis-set POOLED_OUT must never delete outside the scratch area. A
# path that does not exist is a no-op.
scratch_rm() {
    local p="$1" base real
    [[ -n "$p" ]] || { bad "scratch_rm: refusing an empty path"; return 1; }
    [[ -e "$p" || -L "$p" ]] || return 0
    if [[ -L "$p" ]]; then bad "scratch_rm: refusing ${p}: a symlink"; return 1; fi
    base="$(cd "$ROOT/.scratch" 2>/dev/null && pwd -P)" || { bad "scratch_rm: refusing ${p}: ${ROOT}/.scratch does not exist"; return 1; }
    real="$(cd "$p" 2>/dev/null && pwd -P)" || { bad "scratch_rm: refusing ${p}: not a directory"; return 1; }
    if [[ "$real" != "$base"/* || "/${real#"$base"/}/" != *"/${STACK}/"* ]]; then
        bad "scratch_rm: refusing ${p} (${real}): outside ${base}/**/${STACK}/"
        return 1
    fi
    rm -rf -- "$real" || { bad "scratch_rm: could not remove ${real}$(perm_hint "$real")"; return 1; }
    ok "scratch_rm: removed ${real}"
}

# precreate_bind_dirs -- every host directory a compose file bind-mounts, made
# HERE by the invoking user. A missing bind source is created by the Docker
# daemon, root-owned, before customer-layout can (docker-compose.app.yml mounts
# etc/secrets/control-panel, etc/secrets/tenant-create and data/module-exports;
# the edge file provider reads etc/edge).
precreate_bind_dirs() {
    mkdir -p "$SROOT/etc/edge" "$SROOT/secrets/tenants" "$SROOT/etc/secrets/control-panel"              "$SROOT/etc/secrets/tenant-create" "$SROOT/data/module-exports"
}

# host_gateway_ip -- the address host-gateway resolves to for a container, when
# it is NOT host loopback (Docker Engine on Linux: the default bridge's gateway).
# PROOF_HOST_GATEWAY_IP wins. Docker Desktop and non-Linux hosts print nothing
# (127.0.0.1 reaches the host there). Detection failing on Linux is a die, never
# a silent skip: the Keycloak -> mail leg would fail much later.
host_gateway_ip() {
    local ip="${PROOF_HOST_GATEWAY_IP:-}"
    if [[ -z "$ip" ]]; then
        [[ "$(uname -s)" == Linux ]] || return 0
        if [[ "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)" == *"Docker Desktop"* ]]; then return 0; fi
        ip="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null | tr -d '\r' || true)"
        [[ -n "$ip" ]] || die "cannot detect the docker0 gateway (docker network inspect bridge); set PROOF_HOST_GATEWAY_IP"
    fi
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "host-gateway address '${ip}' is not an IPv4 literal"
    [[ "$ip" == 127.0.0.1 ]] || printf '%s' "$ip"
}

# compose <project-suffix> <args...> -- the host's own command shape:
# `docker compose --env-file <project>.env <verb>` from the project's directory.
compose() {
    local p="$1"; shift
    local dir="$ROOT"
    case "$p" in ops) dir="$ROOT/compose/observability" ;; mail) dir="$ROOT/infra/host/mail" ;; esac
    ( cd "$dir" && docker compose --env-file "$(host_path "$ENV_DIR/${p}.env")" "$@" )
}

# compose_config <project-suffix> <config args...> -- `compose config` whose
# failure is never silent. Callers run it as `x="$(compose_config ...)" ||
# exit $?`: a bare `$(compose config 2>/dev/null | ...)` under pipefail either
# ended the proof with status 1 and no word, or (as a printf argument) turned
# a render error into a count of 0. On failure it dies naming the project and
# the first 5 lines of compose's own stderr -- never more, and never the
# render: a config error can quote env values. The stderr file lives under
# $OUT only until it is read.
compose_config() {
    local p="$1" err out rc=0 msg; shift
    mkdir -p "$OUT"; err="$OUT/.compose-config-${p}.err"
    out="$(compose "$p" config "$@" 2>"$err")" || rc=$?
    if (( rc != 0 )); then
        msg="$(head -n 5 "$err" | tr -d '\r')"; rm -f "$err"
        die "compose config of ${STACK}-${p} failed (exit ${rc}): ${msg:-compose wrote nothing on stderr}"
    fi
    rm -f "$err"
    printf '%s\n' "$out"
}

# Every container of this stack's five projects, by the compose label.
stack_containers() {
    local p
    for p in state app-blue app-green ops mail; do
        docker ps -q --filter "label=com.docker.compose.project=${STACK}-${p}"
    done | sed '/^$/d'
}

free_port() {
    local c
    for _ in $(seq 1 200); do
        c=$(( 20000 + RANDOM % 10000 ))
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$c") 2>/dev/null \
           && ! docker ps --format '{{.Ports}}' | grep -q ":$c->"; then
            printf '%s' "$c"; return 0
        fi
    done
    die "no free port in 20000-29999"
}
gen() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

wait_health() { # <container id> <seconds>
    local cid="$1" max="$2" s=0 h
    while (( s < max )); do
        h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo gone)"
        [[ "$h" == healthy ]] && return 0
        [[ "$h" == gone || "$h" == exited || "$h" == dead ]] && return 1
        sleep 3; s=$(( s + 3 ))
    done
    return 1
}
svc_cid() { # <project suffix> <service>
    docker ps -q --filter "label=com.docker.compose.project=${STACK}-$1" --filter "label=com.docker.compose.service=$2" | head -n1
}

# The app images run as uid 1000 (node); a fresh external volume is root-owned.
chmod_app_volumes() {
    docker run --rm --name "${STACK}-chown" -v "${STACK}_config_data:/c" -v "${STACK}_tenant_config_data:/d"         --entrypoint sh "$PROBE_IMAGE" -c 'chown -R 1000:1000 /c /d'
}

# ── prepare ────────────────────────────────────────────────────────────────
# Where the env files point compose at the overlays in $OUT. POOLED_OUT may put
# $OUT outside the repository, so the overlay entry is never a hard-wired repo
# path: compose resolves a relative COMPOSE_FILE entry against the directory it
# runs in (ROOT, or infra/host/<project> for ops and mail -- see compose()), so
# an $OUT under ROOT is named relative to that directory, and any other $OUT by
# its host path. A host path can carry a drive letter (cygpath -m: C:/...),
# which a ':' list would split, so those env files use ';'. The lists are
# double-quoted: compose's env-file parser strips the quotes, and state.env is
# also sourced by bash (state-wait, tenant, tenant-after), where an unquoted ';'
# would end the assignment and run the next entry as a command.
OVL_REL=""; OVL_HOST=""; OVL_SEP=":"
locate_overlays() {
    local out_abs root_abs
    out_abs="$(cd "$OUT" && pwd -P)"; root_abs="$(cd "$ROOT" && pwd -P)"
    if [[ "$out_abs" == "$root_abs"/* ]]; then OVL_REL="${out_abs#"$root_abs"/}"
    else OVL_HOST="$(host_path "$out_abs")"; [[ "$OVL_HOST" != *:* ]] || OVL_SEP=";"; fi
}
# overlay_ref <overlay file> <path from the project's directory back to ROOT>
overlay_ref() {
    if [[ -n "$OVL_REL" ]]; then printf '%s%s/%s' "$2" "$OVL_REL" "$1"
    else printf '%s/%s' "$OVL_HOST" "$1"; fi
}

# The six module servers' <ID>_PG_USER/<ID>_PG_PASSWORD lines of state.env.
# POOLED_CUSTOMER (TASK-043b F5): from a FRESH gremion-init-secrets render of
# the product's own state.env.tmpl, never this script's gen() -- generating
# them here hid a template that lacked the keys `gremion-tenant init` needs.
# A key the render does not carry dies here by name. The render (secrets) is
# removed once read; its log names files and keys only. ~3 min on Git Bash.
# Callers run it as `x="$(module_pg_keys)" || exit $?`.
module_pg_keys() {
    local id u p f="$OUT/init-secrets/etc/env/state.env"
    if [[ "${POOLED_CUSTOMER:-0}" != 1 ]]; then
        for id in BOARD CALENDAR CONTENT FINANCE NEWSLETTER VAULT; do printf '%s_PG_PASSWORD=%s\n' "$id" "$(gen)"; done
        return 0
    fi
    rm -rf "$OUT/init-secrets"; mkdir -p "$OUT/init-secrets" "$OUT/ledger"
    bash "$ROOT/infra/host/bin/gremion-init-secrets" --root "$(host_path "$OUT/init-secrets")" --stack "$STACK" \
        > "$OUT/ledger/init-secrets.log" 2>&1 \
        || { rm -rf "$OUT/init-secrets"; tail -n 5 "$OUT/ledger/init-secrets.log" >&2; die "gremion-init-secrets failed (ledger/init-secrets.log)"; }
    for id in BOARD CALENDAR CONTENT FINANCE NEWSLETTER VAULT; do
        u="$(sed -n "s/^${id}_PG_USER=//p" "$f" | tr -d '\r' | tail -n1)"
        p="$(sed -n "s/^${id}_PG_PASSWORD=//p" "$f" | tr -d '\r' | tail -n1)"
        [[ -n "$u" && -n "$p" && "$p" != CHANGE_ME* ]] \
            || { rm -rf "$OUT/init-secrets"; die "TASK-043b F5: a fresh gremion-init-secrets render of state.env.tmpl carries no usable ${id}_PG_USER/${id}_PG_PASSWORD"; }
        printf '%s_PG_USER=%s\n%s_PG_PASSWORD=%s\n' "$id" "$u" "$id" "$p"
    done
    p=""
    rm -rf "$OUT/init-secrets"
    printf '%s F5: the six <ID>_PG_USER/_PG_PASSWORD keys came from a fresh gremion-init-secrets render of state.env.tmpl\n' "$(now)" >> "$OUT/ledger/init-secrets.log"
}

# The env files and the proof overlays, and nothing else: no docker engine
# (bar free_port's `docker ps`) and no file under the repository. prepare
# starts with it; on its own it is the render-env phase.
phase_render_env() {
    require_scratch render-env
    need_writable "$ENV_DIR" "$OUT"
    locate_overlays
    local SROOT_H; SROOT_H="$(host_path "$SROOT")"
    local s="$OVL_SEP"
    local ops_bind="${PROOF_OPS_BIND_IP:-127.0.0.1}"
    [[ "$ops_bind" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "PROOF_OPS_BIND_IP '${ops_bind}' is not an IPv4 literal"
    # Linux Docker Engine: host-gateway is docker0, not loopback (see the header).
    local gw_ip=""
    if [[ "${POOLED_CUSTOMER:-0}" == 1 ]]; then gw_ip="$(host_gateway_ip)" || exit $?; fi

    local pw_pg pw_kcdb pw_kc pw_gr pw_ctl pw_pub pw_bnc sec_proxy sec_auth sec_push
    pw_pg="$(gen)"; pw_kcdb="$(gen)"; pw_kc="$(gen)"; pw_gr="$(gen)"; pw_ctl="$(gen)"; pw_pub="$(gen)"
    pw_bnc="$(gen)"; sec_proxy="$(gen)"; sec_auth="$(gen)"; sec_push="$(gen)"
    local p_http p_https p_api p_it p_mailapi
    p_http="$(free_port)"; p_https="$(free_port)"; p_api="$(free_port)"; p_it="$(free_port)"; p_mailapi="$(free_port)"
    # POOLED_CUSTOMER: the management API on the host's own 127.0.0.1:8086
    # (infra/host/mail/docker-compose.yml, mail.env.tmpl). gremion-vendor-mail's
    # principals.mjs refuses any other STALWART_ADMIN_URL (LOOPBACK_8086), so a
    # random port failed `create`'s mail step: "STALWART_ADMIN_URL must be
    # http://<loopback>:8086". Like :587, one customer proof per engine.
    if [[ "${POOLED_CUSTOMER:-0}" == 1 ]]; then
        ! (exec 3<>/dev/tcp/127.0.0.1/8086) 2>/dev/null || die "127.0.0.1:8086 is taken: the customer proof needs the vendor mail API there"
        p_mailapi=8086
    fi
    # TASK-043: gremion_platform's owner and the panel's reader, ONE value for
    # both colours (one role each); docker-compose.app.yml requires both.
    local pw_plat pw_panel pw_kapi pw_oac
    pw_plat="$(gen)"; pw_panel="$(gen)"; pw_kapi="$(gen)"; pw_oac="$(gen)"
    local profiles=production
    [[ "${POOLED_CUSTOMER:-0}" == 1 ]] && profiles="production,calendar,vault"
    local mod_keys
    mod_keys="$(module_pg_keys)" || exit $?

    cat > "$ENV_DIR/state.env" <<EOF
COMPOSE_PROJECT_NAME=${STACK}-state
COMPOSE_FILE="docker-compose.yml${s}docker-compose.prod.yml${s}test/host/fixtures/pooled-stack/docker-compose.state-pins.yml${s}$(overlay_ref state.proof.yml '')"
COMPOSE_PATH_SEPARATOR="${s}"
COMPOSE_PROFILES=${profiles}
STACK=${STACK}
${mod_keys}
GREMION_ROOT=${SROOT_H}
PLATFORM_DOMAIN=proof.example.org
DOMAIN=proof.example.org
IMAGE_TAG=${IMAGE_TAG_PROOF}
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
EDGE_HTTP_PORT=${p_http}
EDGE_HTTPS_PORT=${p_https}
TRAEFIK_API_PORT=${p_api}
INTERNALTEST_PORT=${p_it}
EDGE_V4_SUBNET=10.231.0.0/24
EDGE_V6_SUBNET=fd5a:231:0::/64
STATE_V4_SUBNET=10.231.1.0/24
STATE_V6_SUBNET=fd5a:231:1::/64
ACME_EMAIL=acme@proof.example.org
ACME_CA_SERVER=https://127.0.0.1:1/directory
TRAEFIK_CERT_RESOLVER=le-http
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${pw_pg}
KEYCLOAK_DB_PASSWORD=${pw_kcdb}
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=${pw_kc}
GREMION_DB_PASSWORD=${pw_gr}
CONTROL_DB_PASSWORD=${pw_ctl}
PUBLIC_DB_PASSWORD=${pw_pub}
PGBOUNCER_AUTH_PASSWORD=${pw_bnc}
TENANT_PROXY_SHARED_SECRET=${sec_proxy}
EOF
    local c v4 v6 n=2
    for c in blue green; do
        v4="10.231.${n}.0/24"; v6="fd5a:231:${n}::/64"; n=$(( n + 1 ))
        cat > "$ENV_DIR/app-${c}.env" <<EOF
STACK=${STACK}
COLOUR=${c}
COMPOSE_PROJECT_NAME=${STACK}-app-${c}
COMPOSE_FILE=docker-compose.app.yml:test/host/fixtures/pooled-stack/docker-compose.pins.yml
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=production
APP_V4_SUBNET=${v4}
APP_V6_SUBNET=${v6}
PLATFORM_DOMAIN=proof.example.org
IMAGE_TAG=${IMAGE_TAG_PROOF}
GREMION_DB_PASSWORD=${pw_gr}
CONTROL_DB_PASSWORD=${pw_ctl}
PUBLIC_DB_PASSWORD=${pw_pub}
AUTH_SECRET=${sec_auth}
AUTH_KEYCLOAK_SECRET=$(gen)
KEYCLOAK_ADMIN_CLIENT_SECRET=$(gen)
INTERNAL_PUSH_SECRET=${sec_push}
TENANT_PROXY_SHARED_SECRET=${sec_proxy}
TENANT_SECRETS_DIR=${SROOT_H}/secrets/tenants
# not yet in app.env.tmpl (TASK-028 wait): migrate and gremion-ui need it
AUTH_KEYCLOAK_ISSUER=https://proof.example.org/auth/realms/gremion
# TASK-043 (app.env.tmpl): tenant-create's and the control panel's mounts
# under etc/secrets, gremion_platform's owner, the panel's read-only role
GREMION_ROOT=${SROOT_H}
PLATFORM_DB_PASSWORD=${pw_plat}
PANEL_DB_PASSWORD=${pw_panel}
KERNEL_API_DB_PASSWORD=${pw_kapi}
UI_OAC_DB_PASSWORD=${pw_oac}
GREMION_MIGRATION_DUMP_DIR=${SROOT_H}/migration-dumps
EOF
    done
    cat > "$ENV_DIR/ops.env" <<EOF
STACK=${STACK}
COMPOSE_PROJECT_NAME=${STACK}-ops
COMPOSE_FILE="docker-compose.yml${s}$(overlay_ref ops.proof.yml ../../)"
COMPOSE_PATH_SEPARATOR="${s}"
COMPOSE_PROFILES=production
OPS_V4_SUBNET=10.231.8.0/24
OPS_V6_SUBNET=fd5a:231:8::/64
GREMION_ROOT_DIR=${SROOT_H}
OPS_BIND_IP=${ops_bind}
OPS_INGEST_BIND_IP=${ops_bind}
OPS_UID=65534
OPS_GID=65534
PROM_RETENTION_TIME=1d
PLATFORM_DOMAIN=proof.example.org
ALERT_SMTP_HOST=mail.proof.example.org
ALERT_SMTP_PORT=587
ALERT_SMTP_USER=alerts@proof.example.org
ALERT_EMAIL_FROM=alerts@proof.example.org
EOF
    # Every key of mail.env.tmpl (the vendor mail tooling's load_env refuses an
    # empty generated secret), the images by the template's own digests. The
    # template's pin is load-bearing: v0.16.x parses its config as JSON only and
    # never reads this project's config.toml (mail.env.tmpl, spike S4), so the
    # v0.16.21 tag this file named booted an UNCONFIGURED server: no domain, no
    # admin credential, no listener of ours.
    local tmpl_mail="$ROOT/infra/host/templates/env/mail.env.tmpl" k
    tkey() { sed -n "s/^$1=//p" "$tmpl_mail" | tr -d '\r' | tail -n1; }
    for k in STALWART_IMAGE PROBE_CURL_IMAGE VENDOR_MAIL_NODE_IMAGE; do
        [[ "$(tkey "$k")" == *@sha256:* ]] || die "mail.env.tmpl: ${k} is not pinned by digest"
    done
    cat > "$ENV_DIR/mail.env" <<EOF
STACK=${STACK}
GREMION_ROOT=${SROOT_H}
COMPOSE_PROJECT_NAME=${STACK}-mail
COMPOSE_FILE="docker-compose.yml${s}$(overlay_ref mail.proof.yml ../../../)"
COMPOSE_PATH_SEPARATOR="${s}"
COMPOSE_PROFILES=mail
PLATFORM_DOMAIN=proof.example.org
ACME_EMAIL=acme@proof.example.org
MAIL_BIND_IP=127.0.0.1
MAIL_BIND_IP6=::1
MAIL_TRANSPORT=stalwart
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
MAIL_V4_SUBNET=10.231.9.0/24
MAIL_V6_SUBNET=fd5a:231:9::/64
APP_BLUE_V4_SUBNET=10.231.2.0/24
APP_GREEN_V4_SUBNET=10.231.3.0/24
MAIL_LOG_RETENTION_DAYS=2
STALWART_IMAGE=$(tkey STALWART_IMAGE)
PROBE_CURL_IMAGE=$(tkey PROBE_CURL_IMAGE)
VENDOR_MAIL_NODE_IMAGE=$(tkey VENDOR_MAIL_NODE_IMAGE)
DKIM_SELECTOR_A=$(tkey DKIM_SELECTOR_A)
DKIM_SELECTOR_B=$(tkey DKIM_SELECTOR_B)
MAIL_ACCOUNT_QUOTA=$(tkey MAIL_ACCOUNT_QUOTA)
MAIL_RATE_LIMIT_RCPT=$(tkey MAIL_RATE_LIMIT_RCPT)
STALWART_API_PORT=${p_mailapi}
STALWART_ADMIN_URL=http://127.0.0.1:${p_mailapi}
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=$(gen)
STALWART_API_KEY=$(gen)
VENDOR_SMTP_PASSWORD=$(gen)
ALERT_SMTP_PASSWORD=$(gen)
PLATFORM_SMTP_PASSWORD=$(gen)
ROLES_IMAP_PASSWORD=$(gen)
MAIL_DNS_RESOLVER=127.0.0.1
KEYCLOAK_PROBE_REALM=master
KEYCLOAK_PROBE_USER=probe
EOF
    chmod 600 "$ENV_DIR/mail.env" 2>/dev/null || true

    # The proof overlays: loopback-only, freshly allocated host ports (the
    # host's edge/mail binds and ops' fixed ports would collide on a dev box).
    # They change ports only -- never a network, a volume, a limit or a
    # service -- and publish NOTHING on a ${STACK}_state service: measured on
    # Docker 29, a published postgres answered from the ops network.
    cat > "$OUT/state.proof.yml" <<'EOF'
services:
  traefik:
    ports: !override
      - "127.0.0.1:${EDGE_HTTP_PORT}:80"
      - "127.0.0.1:${EDGE_HTTPS_PORT}:443"
      - "127.0.0.1:${TRAEFIK_API_PORT}:8080"
      - "127.0.0.1:${INTERNALTEST_PORT}:8081"
  legal:
    ports: !reset []
EOF
    if [[ "${POOLED_CUSTOMER:-0}" == 1 ]]; then
        # The state Keycloak reaches mail.<domain>:587 the way a host's does --
        # through the host's own published submission port -- and trusts the
        # scratch mail certificate (a host's is an LE one). No network is added.
        cat >> "$OUT/state.proof.yml" <<'EOF'
  keycloak:
    extra_hosts:
      - "mail.proof.example.org:host-gateway"
    environment:
      KC_TRUSTSTORE_PATHS: /opt/keycloak/conf/truststores/scratch-mail.pem
    volumes:
      - ${GREMION_ROOT}/etc/mail/tls/tls.crt:/opt/keycloak/conf/truststores/scratch-mail.pem:ro
EOF
    fi
    # TASK-039: the ops project's two published services (Grafana on
    # OPS_BIND_IP, Alloy's OTLP ingest on OPS_INGEST_BIND_IP) publish nothing
    # here; test/host/integration/observability-proof.sh proves those binds.
    cat > "$OUT/ops.proof.yml" <<'EOF'
services:
  grafana:
    ports: !reset []
  alloy:
    ports: !reset []
EOF
    # The management API on a fresh loopback port (STALWART_ADMIN_URL: the
    # vendor mail tooling's only way in); with POOLED_CUSTOMER the submission
    # port on 127.0.0.1:587, where host-gateway lands. The scratch certificate.
    # shellcheck disable=SC2016  # ${STALWART_API_PORT} / ${GREMION_ROOT} are compose interpolations, written literally
    {
        printf 'services:\n  stalwart:\n    ports: !override\n'
        printf '      - "127.0.0.1:${STALWART_API_PORT}:8080"\n'
        [[ "${POOLED_CUSTOMER:-0}" == 1 ]] && printf '      - "127.0.0.1:587:587"\n'
        # host-gateway on Linux is docker0, not loopback: publish 587 there too
        # (the state Keycloak reaches mail.<domain>:587 through it).
        [[ -z "$gw_ip" ]] || printf '      - "%s:587:587"\n' "$gw_ip"
        printf '    volumes:\n      - ${GREMION_ROOT}/etc/mail/tls:/opt/stalwart/etc/tls:ro\n'
    } > "$OUT/mail.proof.yml"
    ok "render-env ${STACK}: env files in ${ENV_DIR}, overlays in ${OUT}"
}

# The vendor mail server's config.toml from the project's own template, with
# the values of mail.env (the admin credential provision-roles.sh and the
# vendor tooling authenticate with) and the scratch deviations of TASK-015's
# ops/vendor-mail/test/scratch-stalwart.sh: no [acme] block (it would ask the
# real Let's Encrypt for a name no one owns), a self-signed certificate for
# mail.<domain> instead, generated DKIM keys. The certificate is what the
# state Keycloak trusts under POOLED_CUSTOMER.
render_mail_config() {
    local menv="$ENV_DIR/mail.env" dom sa sb pw tls="$SROOT/etc/mail/tls" dkim="$SROOT/etc/secrets/mail"
    mkey() { sed -n "s/^$1=//p" "$menv" | tr -d '\r' | tail -n1; }
    dom="$(mkey PLATFORM_DOMAIN)"; sa="$(mkey DKIM_SELECTOR_A)"; sb="$(mkey DKIM_SELECTOR_B)"; pw="$(mkey STALWART_ADMIN_PASSWORD)"
    [[ -n "$dom" && -n "$sa" && -n "$sb" && -n "$pw" ]] || die "mail.env lacks PLATFORM_DOMAIN, a DKIM selector or STALWART_ADMIN_PASSWORD"
    mkdir -p "$tls" "$dkim"
    # host-form paths: a native openssl.exe (Git Bash) cannot open /c/... under MSYS_NO_PATHCONV
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$(host_path "$tls")/tls.key" -out "$(host_path "$tls")/tls.crt" -days 3 \
        -subj "/CN=mail.${dom}" -addext "subjectAltName=DNS:mail.${dom}" 2>/dev/null \
        || die "openssl could not make the scratch mail certificate"
    openssl genrsa -out "$(host_path "$dkim")/${sa}.private" 2048 2>/dev/null || die "openssl could not make a DKIM key"
    cp "$dkim/${sa}.private" "$dkim/${sb}.private"
    chmod 644 "$tls/"* "$dkim/"* 2>/dev/null || true
    # shellcheck disable=SC2016  # the ${...} are LITERAL template placeholders
    awk -v D="$dom" -v PW="$pw" -v SA="$sa" -v SB="$sb" -v RL="$(mkey MAIL_RATE_LIMIT_RCPT)" -v LR="$(mkey MAIL_LOG_RETENTION_DAYS)" '
/^\[acme\."le"\]/ { skip = 1; next }
skip && /^# Two selectors/ { skip = 0 }
skip { next }
/^\[certificate\.default\]/ {
    print; print "cert = \"%{file:/opt/stalwart/etc/tls/tls.crt}%\""
    print "private-key = \"%{file:/opt/stalwart/etc/tls/tls.key}%\""; next }
{ gsub(/\$\{MAIL_HOSTNAME\}/, "mail." D); gsub(/\$\{PLATFORM_DOMAIN\}/, D); gsub(/\$\{ACME_EMAIL\}/, "acme@" D)
  gsub(/\$\{DKIM_SELECTOR_A\}/, SA); gsub(/\$\{DKIM_SELECTOR_B\}/, SB)
  gsub(/\$\{MAIL_RATE_LIMIT_RCPT\}/, RL); gsub(/\$\{MAIL_LOG_RETENTION_DAYS\}/, LR)
  gsub(/\$\{STALWART_ADMIN_USER\}/, "admin"); gsub(/\$\{STALWART_ADMIN_PASSWORD\}/, PW); print }' \
        "$ROOT/infra/host/mail/config.toml.tmpl" | tr -d '\r' > "$SROOT/etc/mail/config.toml"
    pw=""
    # shellcheck disable=SC2016  # the LITERAL two characters a surviving placeholder starts with
    ! grep -q '\${' "$SROOT/etc/mail/config.toml" || die "the scratch mail config render left a placeholder"
    grep -q '^\[acme' "$SROOT/etc/mail/config.toml" && die "the scratch mail config still carries an [acme] block"
    return 0
}

phase_prepare() {
    require_scratch prepare
    need_writable "$ENV_DIR" "$SROOT" "$OUT/ledger"
    precreate_bind_dirs

    # Subnets: a dedicated 10.231.0.0/16 and fd5a:231::/48, refused if taken.
    local taken
    # shellcheck disable=SC2046  # one argument per network id, on purpose
    taken="$(docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | grep -E ' 10\.231\.' | grep -v "^${STACK}" || true)"
    [[ -z "$taken" ]] || die "10.231.0.0/16 already in use on this engine: $taken"

    phase_render_env
    local pw_bnc; pw_bnc="$(sed -n 's/^PGBOUNCER_AUTH_PASSWORD=//p' "$ENV_DIR/state.env")"
    [[ -n "$pw_bnc" ]] || die "render-env wrote no PGBOUNCER_AUTH_PASSWORD"

    # Files the renders bind-mount (all gitignored or under the scratch root).
    [[ -f "$ROOT/legal/legal.env" ]] || { mkdir -p "$ROOT/legal"; cp "$ROOT/legal/legal.env.example" "$ROOT/legal/legal.env"; }
    [[ -f "$ROOT/secrets/ipcrypt_key.txt" ]] || { gen > "$ROOT/secrets/ipcrypt_key.txt"; touch "$OUT/.created-ipcrypt"; }
    [[ -f "$ROOT/docker/keycloak/certs/keycloak.crt" ]] || bash "$ROOT/docker/keycloak/certs/gen-internal-ca.sh" >/dev/null
    [[ -f "$ROOT/docker/keycloak/certs/internal-ca.pem" ]] || cp "$ROOT/docker/keycloak/certs/internal-ca.crt" "$ROOT/docker/keycloak/certs/internal-ca.pem"
    if [[ ! -f "$ROOT/docker/pgbouncer/userlist.txt" ]]; then
        printf '"pgbouncer_auth" "%s"\n' "$pw_bnc" > "$ROOT/docker/pgbouncer/userlist.txt"
        touch "$OUT/.created-userlist"
    else
        # reuse: the auth password is whatever the existing userlist carries
        sed -i "s/^PGBOUNCER_AUTH_PASSWORD=.*/PGBOUNCER_AUTH_PASSWORD=$(sed -n 's/^"pgbouncer_auth" "\(.*\)"$/\1/p' "$ROOT/docker/pgbouncer/userlist.txt")/" "$ENV_DIR/state.env"
    fi
    # ops (TASK-039, compose/observability): the files and directories
    # render-ops.sh would place under the host root. The compose file reads
    # its static configs from the release tree itself (relative paths).
    mkdir -p "$SROOT/runtime/ops/targets" "$SROOT/runtime/ops/prometheus-data" "$SROOT/runtime/ops/grafana-data" \
             "$SROOT/runtime/ops/grafana-logs" "$SROOT/runtime/ops/loki-data" "$SROOT/runtime/ops/tempo-data" \
             "$SROOT/runtime/ops/alloy-data" "$SROOT/runtime/textfile" "$SROOT/etc/secrets/ops" "$SROOT/etc/secrets/grafana" \
             "$SROOT/etc/mail" "$SROOT/etc/secrets/mail"
    rm -rf "$SROOT/runtime/ops/grafana-provisioning"
    cp -R "$ROOT/compose/observability/grafana/provisioning" "$SROOT/runtime/ops/grafana-provisioning"
    rm -f "$SROOT/runtime/ops/grafana-provisioning/alerting/policies.yaml"   # no sink: no policy (render-ops.sh)
    printf '[]\n' > "$SROOT/runtime/ops/targets/blackbox-third-party.yml"
    gen > "$SROOT/etc/secrets/ops/stalwart-api-key"; gen > "$SROOT/etc/secrets/ops/smtp-password"
    gen | tr -d '\n' > "$SROOT/etc/secrets/ops/otlp-ingest-token"
    chmod -R a+rwX "$SROOT/runtime" 2>/dev/null || true
    render_mail_config

    # The stack-scoped externals (bootstrap.sh stage_networks' set).
    docker network inspect "${STACK}_edge" >/dev/null 2>&1 \
        || docker network create --ipv6 --subnet 10.231.0.0/24 --subnet fd5a:231:0::/64 "${STACK}_edge" >/dev/null
    docker network inspect "${STACK}_state" >/dev/null 2>&1 \
        || docker network create --ipv6 --subnet 10.231.1.0/24 --subnet fd5a:231:1::/64 "${STACK}_state" >/dev/null
    info "externals: networks ready"
    local vol
    for vol in traefik_acme config_data tenant_config_data tenant_secrets mail_data nats_accounts nats_secrets; do
        docker volume inspect "${STACK}_${vol}" >/dev/null 2>&1 || docker volume create "${STACK}_${vol}" >/dev/null
    done
    info "externals: volumes ready"
    # The default tenant's config (CONFIG_PATH on the external config volume).
    # A real host carries the operator's; migrate's fleet refuses a config
    # without a brand identity (assertBrandIdentityComplete).
    printf '%s' '{"brand":{"product":"Gremion","org_short":"T040"},"deployment":{"mode":"multi"}}'         | docker run --rm -i --name "${STACK}-seed-config" -v "${STACK}_config_data:/c" --entrypoint sh "$PROBE_IMAGE"             -c 'cat > /c/config.json && chmod 666 /c/config.json'
    chmod_app_volumes

    ok "prepared ${STACK}: env files, externals, overlays (run the names phase before any up)"
    printf '%s prepared %s\n' "$(now)" "$STACK" | ledger run.log
}

# Names on `config` BEFORE any `up`: every rendered network and volume is
# under ${STACK}, and every project is ${STACK}-<suffix>.
phase_names() {
    local p json names
    for p in state app-blue app-green ops mail; do
        json="$(COMPOSE_PROFILES='*' compose_config "$p" --format json)" || exit $?
        names="$(jq -r '.name, (.networks // {} | to_entries[] | (.value.name // .key)), (.volumes // {} | to_entries[] | (.value.name // .key))' <<< "$json")" \
            || die "$p: jq could not read the compose config render"
        [[ -n "$names" ]] || die "$p renders nothing"
        while IFS= read -r n; do
            [[ "$n" == "${STACK}"* || "$n" == "default" ]] || die "$p renders a name outside ${STACK}: $n"
        done <<< "$names"
    done
    ok "names: every rendered project, network and volume of the five projects is under ${STACK}"
    : > "$OUT/.names-ok"
}

# ── state ──────────────────────────────────────────────────────────────────
phase_state_up() {
    require_scratch state-up
    [[ -f "$OUT/.names-ok" ]] || die "run the names phase first: no up before every rendered name is asserted"
    # TASK-024 (Q12): nats-auth init BEFORE the first state up -- the SYS
    # reload seed and a SYS-only accounts file, so nats boots with no
    # anonymous user. Idempotent, no network (--no-deps).
    compose app-blue run --rm --no-deps --pull never --entrypoint pnpm tenant-create exec nats-auth init \
        > "$OUT/ledger/nats-auth-init.log" 2>&1 \
        || { tail -15 "$OUT/ledger/nats-auth-init.log" >&2; die "nats-auth init failed"; }
    compose state up -d --pull never >/dev/null
    ok "state project up ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-state" | grep -c .) container(s))"
}

phase_state_wait() {
    local cid s
    for s in postgres keycloak nats; do
        cid="$(svc_cid state "$s")"; [[ -n "$cid" ]] || die "state/$s has no container"
        wait_health "$cid" 200 || die "state/$s did not become healthy"
    done
    # pgbouncer's auth_query role (docs/runbooks/pgbouncer.md), per database.
    # shellcheck source=/dev/null  # the per-run env file, written by prepare
    . "$ENV_DIR/state.env"
    cid="$(svc_cid state postgres)"
    docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qU postgres -d postgres >/dev/null <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}';
  END IF;
END \$\$;
EOF
    local db
    for db in postgres gremion control; do
        docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qU postgres -d "$db" >/dev/null < "$ROOT/docker/pgbouncer/pgbouncer-auth.sql"
    done
    # TRD-038 baseline: the state tier's container IDs and volume CreatedAt.
    { docker ps -q --no-trunc --filter "label=com.docker.compose.project=${STACK}-state" | sort
      docker volume ls -q --filter "name=^${STACK}" | sort | while read -r v; do
          printf '%s %s\n' "$v" "$(docker volume inspect -f '{{.CreatedAt}}' "$v")"; done
    } > "$OUT/state-snapshot.txt"
    [[ -s "$OUT/state-snapshot.txt" ]] || die "empty state snapshot"
    ok "state healthy; snapshot of $(grep -c . "$OUT/state-snapshot.txt") state ID/volume line(s) taken"
}

# ── app colours ────────────────────────────────────────────────────────────
phase_app_up() {
    require_scratch app-up
    local c="$1"
    compose "app-$c" run --rm --pull never migrate > "$OUT/ledger/migrate-$c.log" 2>&1 \
        || { tail -20 "$OUT/ledger/migrate-$c.log" >&2; die "migrate failed on app-$c"; }
    local left
    left="$(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-app-$c" --filter "label=com.docker.compose.service=migrate" | grep -c . || true)"
    [[ "$left" == 0 ]] || bad "migrate left $left container(s) behind (--rm)"
    compose "app-$c" up -d --pull never >/dev/null
    ok "app-$c: migrate ran and left nothing; up"
}

# The same checks gremion-deploy's assert_stack_isolation makes, on the real
# containers: mounts and networks under ${STACK}, and the <svc>-<colour>
# alias on both shared networks. Call it directly, never as $(...): its bad()
# calls must reach the proof's RED. The container count lands in ISO_SEEN.
ISO_SEEN=0
isolation_of_colour() {
    local c="$1" cid name mounts nets svc eps n al t seen=0
    local allowed=" ${STACK}_edge ${STACK}_state ${STACK}-app-${c}_app "
    for cid in $(docker ps -q --filter "label=com.docker.compose.project=${STACK}-app-$c"); do
        seen=$(( seen + 1 ))
        name="$(docker inspect -f '{{.Name}}' "$cid")"
        mounts="$(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$cid")"
        for n in $mounts; do
            [[ "$n" == "${STACK}"_* || "$n" == "${STACK}-app-${c}"_* ]] || bad "$name mounts foreign volume $n"
        done
        nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid")"
        svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")"
        eps="$(docker inspect -f '{{range $net, $ep := .NetworkSettings.Networks}}{{$net}}={{range $ep.Aliases}}{{.}},{{end}} {{end}}' "$cid")"
        for n in $nets; do
            [[ "$allowed" == *" $n "* ]] || bad "$name on foreign network $n"
            [[ "$n" == "${STACK}_edge" || "$n" == "${STACK}_state" ]] || continue
            al=""; for t in $eps; do [[ "$t" == "${n}="* ]] && al="${t#*=}"; done
            [[ ",$al" == *",${svc}-${c},"* ]] || bad "$name on $n carries no ${svc}-${c} alias (has: $al)"
        done
    done
    (( seen > 0 )) || bad "app-$c runs no container"
    ISO_SEEN="$seen"
}

phase_app_wait() {
    local c="$1" s cid body
    for s in gremion-ui gremion-public; do
        cid="$(svc_cid "app-$c" "$s")"; [[ -n "$cid" ]] || { bad "app-$c/$s has no container"; continue; }
        wait_health "$cid" 180 || { bad "app-$c/$s did not become healthy"; docker logs --tail 30 "$cid" >&2 || true; }
    done
    cid="$(svc_cid "app-$c" gremion-ui)"
    body="$(docker exec "$cid" wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null || true)"
    printf '%s app-%s gremion-ui /healthz %s\n' "$(now)" "$c" "$body" | ledger healthz.log
    if [[ "$body" == *"\"colour\":\"$c\""* ]]; then ok "app-$c gremion-ui /healthz reports colour $c"
    else bad "app-$c gremion-ui /healthz does not report colour $c: $body"; fi
    local before="$FAILS"
    isolation_of_colour "$c"
    if (( FAILS == before )); then
        ok "app-$c: $ISO_SEEN container(s), every mount/network under ${STACK}, every shared-network alias <svc>-$c"
    else bad "app-$c: isolation of $ISO_SEEN container(s) failed (see above)"; fi
}

# ── the non-council projects ───────────────────────────────────────────────
phase_aux_up() {
    require_scratch aux-up
    # --pull never below: every pinned image of both projects must already be
    # local, and on a fresh Linux host they are not. A failed pull is loud.
    local pp
    for pp in ops mail; do
        if ! compose "$pp" pull >"$OUT/ledger/${pp}-pull.log" 2>&1; then
            tail -n 5 "$OUT/ledger/${pp}-pull.log" | tr -d '\r' >&2
            bad "${pp}: compose pull failed (see ${OUT}/ledger/${pp}-pull.log); not starting a project with missing images"
            return 0
        fi
    done
    compose ops up -d --pull never >/dev/null 2>"$OUT/ledger/ops-up.err" || { cat "$OUT/ledger/ops-up.err" >&2; bad "ops up failed"; }
    compose mail up -d --pull never >/dev/null 2>"$OUT/ledger/mail-up.err" || { cat "$OUT/ledger/mail-up.err" >&2; bad "mail up failed"; }
    sleep "${POOLED_AUX_SETTLE:-20}"
    local p cid st
    for p in ops mail; do
        for cid in $(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-$p"); do
            st="$(docker inspect -f '{{.Name}} {{.State.Status}} restarts={{.RestartCount}}' "$cid")"
            printf '%s %s %s\n' "$(now)" "$p" "$st" | ledger aux.log
            [[ "$st" == *" running restarts=0" ]] || bad "$p container not steadily running: $st"
        done
    done
    ok "ops ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-ops" | grep -c .)) and mail ($(docker ps -q --filter "label=com.docker.compose.project=${STACK}-mail" | grep -c .)) running"
}

# ── the vendor mail principals (TASK-043's customer half) ──────────────────
# provision-roles.sh hands curl its admin credential as `-K <(...)`. A native
# Windows curl (Git Bash on a Docker Desktop box) cannot open the /proc/<pid>/fd
# path of a process substitution ("cannot read config"). On such a host ONLY,
# curl becomes an exported function that copies that config into a 0600 file
# under ${OUT}/secrets for the one call and removes it after; on Linux the
# script runs untouched. The script itself runs without MSYS_NO_PATHCONV, so
# its native children (curl, jq) get Windows forms of its temp paths.
# shellcheck disable=SC2329  # invoked by provision-roles.sh's bash, exported below
curl_config_shim() {
    local -a a=(); local tmp="" rc=0
    while [[ $# -gt 0 ]]; do
        if [[ "$1" == -K && $# -ge 2 && "$2" != - ]]; then
            tmp="$(umask 077; mktemp "${PROOF_CURLK_DIR:?}/curl-k.XXXXXX")"
            cat "$2" > "$tmp"
            a+=(-K "$(cygpath -m "$tmp")"); shift 2
        else a+=("$1"); shift; fi
    done
    command curl "${a[@]}" || rc=$?
    [[ -z "$tmp" ]] || rm -f "$tmp"
    return "$rc"
}
phase_mail_roles() {
    require_scratch mail-roles
    local api s=0 out rc=0 line
    api="$(sed -n 's/^STALWART_ADMIN_URL=//p' "$ENV_DIR/mail.env" | tr -d '\r')"
    [[ -n "$api" ]] || die "mail.env carries no STALWART_ADMIN_URL (run prepare at this tip)"
    # a redirect, not `-o /dev/null`: under this script's global MSYS_NO_PATHCONV
    # a native curl.exe cannot open /dev/null and exits 23 on every try
    until curl -fsS --max-time 3 "${api}/healthz/live" >/dev/null 2>&1; do
        (( s++ < 40 )) || { bad "mail-roles: the management API at ${api} never answered"; docker logs --tail 20 "${STACK}-mail-stalwart" >&2 || true; return; }
        sleep 3
    done
    if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
        mkdir -p "$OUT/secrets"; chmod 700 "$OUT/secrets" 2>/dev/null || true
        export PROOF_CURLK_DIR="$OUT/secrets"
        # shellcheck disable=SC2329  # exported below (export -f) and invoked inside provision-roles.sh
        curl() { curl_config_shim "$@"; }
        export -f curl curl_config_shim
    fi
    out="$(env -u MSYS_NO_PATHCONV bash "$ROOT/infra/host/mail/provision-roles.sh" \
        --env "$(host_path "$ENV_DIR/mail.env")" --allow-unrestricted 2>&1)" || rc=$?
    unset -f curl 2>/dev/null || true
    # its lines name principals and verdicts, never a secret
    printf '%s rc=%s\n%s\n' "$(now)" "$rc" "$out" | ledger mail-roles.log
    line="$(grep -o 'MAIL-ROLES:.*' <<< "$out" | tail -n1 || true)"
    if (( rc == 0 )) && [[ "$line" == *"vendor-app-password=ok alerts-app-password=ok platform-app-password=ok"* ]]; then
        ok "mail-roles: provision-roles.sh converged (${line}); roles@ carries ROLES_IMAP_PASSWORD"
    else
        bad "mail-roles: provision-roles.sh exit ${rc}: $(tail -n 3 <<< "$out" | tr '\n' ' ')"
    fi
}

# Bring-up step 2 of ops/vendor-mail/RUNBOOK.md section 3, after mail-roles
# (step 1): the operator realm master sends as system@<PLATFORM_DOMAIN>
# (gremion-vendor-mail realm-smtp, no argument). Without it the vendor
# realm has no SMTP user and check-principals (customer-reconcile, Q14) fails
# "vendor realm master has no SMTP user" -- a step the scratch stack skipped,
# not a customer defect. The env files by MAIL_ENV/STATE_ENV_FILE (the root's
# etc/env is laid out later, by customer-layout).
phase_mail_realm() {
    require_scratch mail-realm
    local out rc=0 line dom
    dom="$(sed -n 's/^PLATFORM_DOMAIN=//p' "$ENV_DIR/mail.env" | tr -d '\r')"
    out="$(MAIL_ENV="$(host_path "$ENV_DIR/mail.env")" STATE_ENV_FILE="$(host_path "$ENV_DIR/state.env")" \
        GREMION_ROOT="$(host_path "$SROOT")" GREMION_RELEASE_DIR="$ROOT_H" \
        bash "$ROOT/infra/host/bin/gremion-vendor-mail" realm-smtp 2>&1)" || rc=$?
    # its lines name the realm, the sender and the verdict, never a secret
    printf '%s rc=%s\n%s\n' "$(now)" "$rc" "$out" | ledger mail-realm.log
    line="$(grep -o 'REALM-SMTP:.*' <<< "$out" | tail -n1 || true)"
    if (( rc == 0 )) && [[ "$line" == "REALM-SMTP: realm=master user=system@${dom} "* ]]; then
        ok "mail-realm: master sends as system@${dom} (${line})"
    else
        bad "mail-realm: realm-smtp exit ${rc}: $(tail -n 3 <<< "$out" | tr '\n' ' ')"
    fi
}

# ── TRD-177 ────────────────────────────────────────────────────────────────
phase_limits() {
    local cid n=0 line mem cpu name
    : > "$OUT/ledger/limits.tsv"
    printf 'container\tmemory_bytes\tnano_cpus\n' >> "$OUT/ledger/limits.tsv"
    while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        n=$(( n + 1 ))
        line="$(docker inspect -f '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' "$cid")"
        read -r name mem cpu <<< "$line"
        printf '%s\t%s\t%s\n' "${name#/}" "$mem" "$cpu" >> "$OUT/ledger/limits.tsv"
        [[ "$mem" =~ ^[0-9]+$ && "$mem" -gt 0 ]] || bad "${name#/}: HostConfig.Memory=$mem (no memory limit)"
        [[ "$cpu" =~ ^[0-9]+$ && "$cpu" -gt 0 ]] || bad "${name#/}: HostConfig.NanoCpus=$cpu (no CPU limit)"
    done < <(limit_scope_containers)
    (( n > 0 )) || { bad "limits: zero containers inspected -- refusing a vacuous pass"; return; }
    ok "limits: $n container(s) inspected (ledger/limits.tsv)"
}
# Scratch: every container whose compose project starts with ${STACK}- (so a
# stray ${STACK}-unlimited project is caught too). Host: every container.
limit_scope_containers() {
    if [[ "$SCOPE" == host ]]; then docker ps -q
    else docker ps --format '{{.ID}} {{.Label "com.docker.compose.project"}}' | awk -v p="${STACK}-" 'index($2, p) == 1 {print $1}'
    fi
}

phase_rss() {
    local want names stats rows n over
    # One `docker stats` over every running container, filtered by name, and
    # ONE awk for the arithmetic: measured on a loaded Docker Desktop host, a
    # stats call naming 16 containers stalls, and a per-row subshell pipeline
    # costs seconds per row.
    names="$(limit_scope_containers | xargs -r docker inspect -f '{{.Name}}' | sed 's#^/##' | tr -d '\r')"
    want="$(printf '%s\n' "$names" | grep -c . || true)"
    (( want > 0 )) || { bad "rss: zero containers"; return; }
    stats="$(docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' | tr -d '\r')"
    rows="$(awk -F'|' -v names="$names" '
        function bytes(s,   n, u, m) { gsub(/ /, "", s); n = s; sub(/[A-Za-z]+$/, "", n); u = s; sub(/^[0-9.]+/, "", u)
            m = 1; if (u == "KiB") m = 1024; else if (u == "MiB") m = 1048576; else if (u == "GiB") m = 1073741824
            else if (u == "kB") m = 1000; else if (u == "MB") m = 1000000; else if (u == "GB") m = 1000000000
            return n * m }
        BEGIN { k = split(names, a, "\n"); for (i = 1; i <= k; i++) if (a[i] != "") want[a[i]] = 1 }
        ($1 in want) { split($2, p, " / "); u = bytes(p[1]); l = bytes(p[2])
            pct = (l > 0) ? int(u * 100 / l) : -1
            printf "%s\t%s\t%s\t%d\n", $1, p[1], p[2], pct }' <<< "$stats")"
    { printf 'container\tusage\tlimit\tpercent_of_limit\n'; printf '%s\n' "$rows"; } > "$OUT/ledger/rss.tsv"
    n="$(printf '%s\n' "$rows" | grep -c . || true)"
    over="$(printf '%s\n' "$rows" | awk -F'\t' 'NF == 4 && ($4 < 0 || $4 >= 80) {print $1 " at " $4 "% of " $3}')"
    [[ -z "$over" ]] || bad "rss: idle RSS at or above 80 % of the limit (or no limit): $(printf '%s' "$over" | tr '\n' ';')"
    (( n == want )) || bad "rss: measured $n of $want container(s)"
    (( n > 0 )) || { bad "rss: docker stats returned nothing"; return; }
    ok "rss: $n of $want container(s) measured (ledger/rss.tsv)"
}

# ── TRD-045 ────────────────────────────────────────────────────────────────
# The listening port of each service that may sit on ${STACK}_state.
state_port() {
    case "$1" in
        postgres|*-postgres) echo 5432 ;;
        pgbouncer) echo 6432 ;;
        nats) echo 4222 ;;
        keycloak) echo 8080 ;;
        gremion-ui|gremion-public) echo 3000 ;;
        mailpit) echo 1025 ;;
        *) echo "" ;;
    esac
}
is_ipv4() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }
# probe_all <network> <targets file> -- ONE probe container on <network>
# connects to every "svc ip port" line and prints "svc ip:port OPEN|CLOSED".
# A target MUST be an IP literal: a service name would not resolve from a
# foreign network, and the negative probe would pass for the wrong reason.
probe_all() {
    local net="$1" file="$2" svc ip port script=""
    while read -r svc ip port; do
        [[ -n "$svc" ]] || continue
        is_ipv4 "$ip" || { bad "probe target '$ip' ($svc) is not an IP literal (a name-based probe proves nothing)"; return 2; }
        [[ "$port" =~ ^[0-9]+$ ]] || { bad "probe target $svc has no numeric port"; return 2; }
        script+="if nc -w 3 $ip $port </dev/null >/dev/null 2>&1; then echo '$svc $ip:$port OPEN'; else echo '$svc $ip:$port CLOSED'; fi; "
    done < "$file"
    [[ -n "$script" ]] || { bad "probe: empty target list"; return 2; }
    docker run --rm --name "${STACK}-probe-$RANDOM" --network "$net" --entrypoint sh "$PROBE_IMAGE" -c "$script" | tr -d '\r'
}
phase_isolation() {
    local stamp; stamp="$(now)"
    : > "$OUT/ledger/isolation.txt"
    printf '# TRD-045 isolation proof, %s, STACK=%s, scope=%s\n' "$stamp" "$STACK" "$SCOPE" >> "$OUT/ledger/isolation.txt"
    # 1. every compose project, enumerated by label, is classified
    local projects p nonc=() council=" ${STACK}-state ${STACK}-app-blue ${STACK}-app-green "
    projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | tr -d '\r' | sed '/^$/d' | sort -u)"
    [[ "$SCOPE" == host ]] || projects="$(printf '%s\n' "$projects" | awk -v p="${STACK}-" 'index($0, p) == 1')"
    [[ -n "$projects" ]] || { bad "isolation: no compose project found"; return; }
    while IFS= read -r p; do
        if [[ "$council" == *" $p "* ]]; then printf 'project %s council\n' "$p" >> "$OUT/ledger/isolation.txt"
        elif [[ "$p" == "${STACK}-ops" || "$p" == "${STACK}-mail" || "$SCOPE" == host ]]; then
            nonc+=("$p"); printf 'project %s non-council\n' "$p" >> "$OUT/ledger/isolation.txt"
        else bad "project $p is not classified (placement table: state, app-blue, app-green council; ops, mail non-council)"; fi
    done <<< "$projects"
    (( ${#nonc[@]} > 0 )) || bad "isolation: no non-council project is running -- nothing to prove"
    # 2. no non-council network shares a container with ${STACK}_state
    local statemembers net nets=() m
    statemembers=" $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}') "
    for p in "${nonc[@]}"; do
        # shellcheck disable=SC2016  # a Go template for docker inspect, not a shell expansion
        for net in $(docker ps -q --filter "label=com.docker.compose.project=$p" | xargs -r docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort -u); do
            [[ "$net" == "${STACK}_state" ]] && { bad "$p is ON ${STACK}_state"; continue; }
            nets+=("$net")
            for m in $(docker network inspect "$net" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
                [[ "$statemembers" == *" $m "* ]] && bad "network $net ($p) shares container ${m:0:12} with ${STACK}_state"
            done
            printf 'network %s (%s): no shared member with %s_state\n' "$net" "$p" "$STACK" >> "$OUT/ledger/isolation.txt"
        done
    done
    (( ${#nets[@]} > 0 )) || bad "isolation: the non-council projects are on no network"
    printf '%s\n' "${nets[@]}" > "$OUT/noncouncil-nets.txt"
    ok "isolation: ${#nonc[@]} non-council project(s) on ${#nets[@]} network(s), none sharing a member with ${STACK}_state (ledger/isolation.txt)"
}

# The TCP half of TRD-045, its own phase so each stays inside a time box.
phase_probes() {
    local nets=() net cid svc ip port
    [[ -s "$OUT/noncouncil-nets.txt" ]] || die "run the isolation phase first (no non-council network list)"
    mapfile -t nets < <(sed '/^$/d' "$OUT/noncouncil-nets.txt")
    printf '# TRD-045 probes, %s, STACK=%s\n' "$(now)" "$STACK" >> "$OUT/ledger/isolation.txt"
    # 3. TCP probes: positive control from _state, then every non-council network
    local targets=()
    for cid in $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
        svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid" 2>/dev/null || true)"
        [[ -n "$svc" ]] || continue   # a probe container of this run
        ip="$(docker network inspect "${STACK}_state" -f "{{with index .Containers \"$cid\"}}{{.IPv4Address}}{{end}}")"; ip="${ip%%/*}"
        port="$(state_port "$svc")"
        [[ -n "$port" ]] || { bad "state-network container $svc has no known listening port (unclassified target)"; continue; }
        targets+=("$svc $ip $port")
    done
    (( ${#targets[@]} > 0 )) || { bad "isolation: the target list is empty"; return; }
    local pubs
    for cid in $(docker network inspect "${STACK}_state" -f '{{range $id, $c := .Containers}}{{$id}} {{end}}'); do
        pubs="$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}' "$cid" 2>/dev/null || true)"
        [[ -z "${pubs// /}" ]] || bad "state-network container ${cid:0:12} publishes host port(s) $pubs -- a route from every other bridge network"
    done
    printf '%s\n' "${targets[@]}" > "$OUT/ledger/probe-targets.txt"
    local res line open closed
    # positive control: every target answers from ${STACK}_state
    res="$(probe_all "${STACK}_state" "$OUT/ledger/probe-targets.txt")" || { bad "positive control could not run"; return; }
    printf '%s\n' "$res" | sed "s/^/positive ${STACK}_state -> /" >> "$OUT/ledger/isolation.txt"
    open="$(printf '%s\n' "$res" | grep -c ' OPEN$' || true)"
    [[ "$open" == "${#targets[@]}" ]] || bad "positive control: only $open of ${#targets[@]} target(s) connected from ${STACK}_state (the probe cannot tell open from closed): $(printf '%s' "$res" | grep ' CLOSED$' | tr '\n' ';')"
    # negative: no target answers from any non-council network
    for net in "${nets[@]}"; do
        res="$(probe_all "$net" "$OUT/ledger/probe-targets.txt")" || { bad "negative probe on $net could not run"; continue; }
        printf '%s\n' "$res" | sed "s/^/negative $net -> /" >> "$OUT/ledger/isolation.txt"
        closed="$(printf '%s\n' "$res" | grep -c ' CLOSED$' || true)"
        [[ "$closed" == "${#targets[@]}" ]] || bad "non-council network $net REACHES: $(printf '%s' "$res" | grep ' OPEN$' | tr '\n' ';')"
    done
    [[ -s "$OUT/ledger/isolation.txt" ]] || bad "probes: empty ledger"
    ok "probes: ${#targets[@]} target(s), positive control from ${STACK}_state, ${#nets[@]} non-council network(s) (ledger/isolation.txt)"
}

# ── TRD-440 ────────────────────────────────────────────────────────────────
#
# Every reading is captured into a local FIRST and dies (exit 2) when its command
# failed: a docker engine that is down, or a `compose ls` that errors, used to
# come out of the printf-argument substitutions as running=0, an empty
# compose-ls and stack-containers 0 on BOTH sides, so TRD-440 read "unchanged"
# on a dead engine (R29-MD-A, review r3). Counting is awk, not `grep -c .`:
# grep exits 1 on zero lines, which under pipefail would abort a legitimate 0.
counts() {
    local p svcs running lsj names allps
    for p in state app-blue app-green ops mail; do
        # a render error is FATAL here, never services=0 on both sides of TRD-440
        svcs="$(compose_config "$p" --services)" || exit $?
        running="$(docker ps -q --filter "label=com.docker.compose.project=${STACK}-$p")" \
            || die "the running= reading failed for ${STACK}-$p (docker ps)"
        printf '%s services=%s running=%s\n' "$p" \
            "$(printf '%s\n' "$svcs" | awk 'NF{n++} END{print n+0}')" \
            "$(printf '%s\n' "$running" | awk 'NF{n++} END{print n+0}')"
    done
    lsj="$(docker compose ls -a --format json)" \
        || die "the compose-ls reading failed (docker compose ls)"
    names="$(printf '%s\n' "$lsj" | jq -r --arg p "${STACK}-" '[.[] | select(.Name | startswith($p)) | .Name] | sort | join(",")')" \
        || die "the compose-ls reading failed (jq could not read docker compose ls)"
    printf 'compose-ls %s\n' "$names"
    # Stack-scoped: every container whose compose project or name carries the
    # ${STACK} prefix (the whole engine's count moves with unrelated work).
    allps="$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}}')" \
        || die "the stack-containers reading failed (docker ps -a)"
    printf 'stack-containers %s\n' "$(printf '%s\n' "$allps" | tr -d '\r' | awk -v p="${STACK}" '(index($1, p) == 1 || index($2, p) == 1) {n++} END{print n+0}')"
}
phase_tenant() {
    require_scratch tenant
    # shellcheck source=/dev/null  # the per-run env file, written by prepare
    . "$ENV_DIR/state.env"
    [[ -s "$OUT/ledger/trd440-before.txt" ]] || die "run tenant-before first"
    # The provisioner runs as the product's own tenant-create one-shot (app
    # project, run --rm) on ${STACK}_state/_edge -- not from the host, because
    # reaching postgres from the host needs a published port, and a published
    # port on a _state service is itself an isolation breach (see isolation).
    local -a run=(run --rm --pull never
        -e "KEYCLOAK_ADMIN=${KEYCLOAK_ADMIN}" -e "KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}"
        -e "ADMIN_DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres-${STACK}:5432/postgres"
        -e "PLATFORM_DOMAIN=proof.example.org" -e "PLATFORM_SMTP_PASSWORD=$(gen)"
        -e "TENANT_PROVISIONER_SECRET_FILE=/run/secrets/tenants/.proof-provisioner"
        -v "$(host_path "$ROOT/test/host/fixtures/pooled-stack"):/fixture:ro"
        tenant-create)
    compose app-blue "${run[@]}" bootstrap-provisioner > "$OUT/ledger/trd440-bootstrap.log" 2>&1 \
        || { tail -15 "$OUT/ledger/trd440-bootstrap.log" >&2; bad "bootstrap-provisioner failed"; return; }
    compose app-blue "${run[@]}" provision "$TENANT_SLUG" --config "/fixture/tenant-t040-b.json" \
        > "$OUT/ledger/trd440-provision.log" 2>&1 \
        || { tail -25 "$OUT/ledger/trd440-provision.log" >&2; bad "provision $TENANT_SLUG failed"; return; }
    # The operator's step after provision (runbook tenant-lifecycle): the
    # tenant's own config at /data/<slug>/config.json on the external
    # tenant-config-data volume. The fleet (migrate) asserts its brand identity.
    docker run --rm -i --name "${STACK}-seed-tenant" -v "${STACK}_tenant_config_data:/d" --entrypoint sh "$PROBE_IMAGE"         -c "mkdir -p /d/${TENANT_SLUG} && cat > /d/${TENANT_SLUG}/config.json && chown -R 1000:1000 /d/${TENANT_SLUG}"         < "$ROOT/test/host/fixtures/pooled-stack/tenant-t040-b.json"
    ok "tenant: bootstrap-provisioner and provision $TENANT_SLUG ran; its config is in place (ledger/trd440-*.log)"
}

# Split so no call outlives a time box: each compose render is ~10 s here.
phase_tenant_before() {
    # The counts are captured BEFORE any file is created: a counts that dies
    # (docker error, render error) leaves neither a baseline nor a .part behind,
    # and an earlier baseline is removed first so a failed re-run can never leave
    # the previous run's numbers for the tenant phase to accept (R29-MD-A).
    rm -f "$OUT/ledger/trd440-before.txt" "$OUT/ledger/trd440-before.txt.part"
    local b; b="$(counts)" || exit $?
    printf '%s\n' "$b" > "$OUT/ledger/trd440-before.txt.part" && mv -f "$OUT/ledger/trd440-before.txt.part" "$OUT/ledger/trd440-before.txt"
    [[ -s "$OUT/ledger/trd440-before.txt" ]] || die "empty TRD-440 baseline"
    ok "tenant-before: baseline recorded"
}
phase_tenant_after() {
    # shellcheck source=/dev/null  # the per-run env file, written by prepare
    . "$ENV_DIR/state.env"
    local before after
    before="$(cat "$OUT/ledger/trd440-before.txt")"
    after="$(counts)" || exit $?
    printf '%s\n' "$after" > "$OUT/ledger/trd440-after.txt"
    if [[ "$before" == "$after" ]]; then ok "TRD-440: services, running containers and compose projects unchanged by the tenant-add"
    else bad "TRD-440: the tenant-add changed the stack: $(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ')"; fi
    local cid db realm
    cid="$(svc_cid state postgres)"
    db="$(docker exec "$cid" psql -tAqU postgres -c "SELECT datname FROM pg_database WHERE datname IN ('t_${TENANT_SLUG//-/_}', 't_${TENANT_SLUG}')" | tr -d '\r')"
    if [[ -n "$db" ]]; then ok "TRD-440: tenant database $db exists"; else bad "TRD-440: no tenant database for $TENANT_SLUG"; fi
    # The admin password reaches kcadm as KC_CLI_PASSWORD, handed to `docker exec`
    # by NAME (the value comes from this shell's environment), so it is on no argv,
    # neither this host's nor the container's (R29-MD-A, probed on the pinned
    # Keycloak image). kcadm's cached token is removed after the read.
    realm="$(KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$(svc_cid state keycloak)" sh -c "/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user '${KEYCLOAK_ADMIN}' >/dev/null 2>&1 && /opt/keycloak/bin/kcadm.sh get realms/${TENANT_SLUG} --fields realm; rm -f /opt/keycloak/.keycloak/kcadm.config" 2>/dev/null | tr -d '\r' || true)"
    if [[ "$realm" == *"\"${TENANT_SLUG}\""* ]]; then ok "TRD-440: realm $TENANT_SLUG exists"; else bad "TRD-440: realm $TENANT_SLUG absent"; fi
    printf '%s db=%s realm=%s\n' "$(now)" "${db:-none}" "$(echo "$realm" | tr -d ' \n')" | ledger trd440.log
}

# ── TRD-038 ────────────────────────────────────────────────────────────────
phase_switch() {
    require_scratch switch
    [[ -s "$OUT/state-snapshot.txt" ]] || die "no state snapshot (run state-wait first)"
    # green must already be up and healthy (app-up green, app-wait green)
    local g; g="$(svc_cid app-green gremion-ui)"
    if [[ -z "$g" ]] || ! wait_health "$g" 30; then die "app-green is not up and healthy -- run app-up green and app-wait green first"; fi
    # blue leaves: removal by label, never `compose down`
    docker ps -aq --filter "label=com.docker.compose.project=${STACK}-app-blue" | xargs -r docker rm -f >/dev/null
    local now_snap
    now_snap="$( { docker ps -q --no-trunc --filter "label=com.docker.compose.project=${STACK}-state" | sort
      docker volume ls -q --filter "name=^${STACK}" | sort | while read -r v; do
          printf '%s %s\n' "$v" "$(docker volume inspect -f '{{.CreatedAt}}' "$v")"; done; } )"
    printf '%s\n' "$now_snap" > "$OUT/ledger/state-after-switch.txt"
    cp "$OUT/state-snapshot.txt" "$OUT/ledger/state-before-switch.txt"
    if [[ "$now_snap" == "$(cat "$OUT/state-snapshot.txt")" ]]; then
        ok "TRD-038: blue -> green left every state container ID and volume CreatedAt unchanged"
    else
        bad "TRD-038: the switch changed the state tier: $(diff "$OUT/state-snapshot.txt" "$OUT/ledger/state-after-switch.txt" | tr '\n' ' ')"
    fi
}

# The replacement for the deleted cross-project depends_on (brief section 9):
# the app colour boots while the state tier is DOWN and must become READY
# (TASK-023's boot retry) once state is back. /healthz is liveness and answers
# 200 even after a failed boot, so readiness is /api/health (200 {"status":"ok"}
# only once boot -- migrations and workers -- completed; 503 before).
#
# /api/health is NOT on the boot-and-resolve exemption list: tenantResolveHandle
# (hooks.server.ts sequence element 0) answers 403 without x-proxy-trust when
# TENANT_PROXY_SHARED_SECRET is set -- it always is here -- and 404 without a
# registered x-forwarded-host whose Host matches (resolve.ts). So the probe is
# shaped like the edge's request: the proof host (registered by cold-state for
# the default tenant) as both headers, and the container's OWN secret, which
# expands inside the container and so never reaches this host's argv, output
# or ledger. wget's stderr (the HTTP status) is the body when it is not ok.
# shellcheck disable=SC2016  # $TENANT_PROXY_SHARED_SECRET and $1 expand in the container
ready_body() { # <gremion-ui container> <host>
    { docker exec "$1" sh -c 'wget -qO- -T 5 --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: $1" --header "Host: $1" http://127.0.0.1:3000/api/health 2>&1' sh "$2" 2>&1 || true; } | tr -d '\r'
}
# The proof host becomes the default tenant's (non-primary) tenant_domain row;
# prints how many default-tenant rows carry it afterwards (1 = registered).
register_proof_host() {
    local pg; pg="$(svc_cid state postgres)"
    [[ -n "$pg" ]] || { echo "no state postgres"; return 0; }
    { docker exec "$pg" psql -v ON_ERROR_STOP=1 -tAqU postgres -d control -c \
        "INSERT INTO tenant_domain (host, tenant_id) SELECT '${PROOF_HOST}', id FROM tenant WHERE slug = 'default' ON CONFLICT (host) DO NOTHING; SELECT count(*) FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id WHERE d.host = '${PROOF_HOST}' AND t.slug = 'default'" 2>&1 || true; } | tr -d '\r'
}
phase_cold_state() {
    require_scratch cold-state
    local cid c body s scid t=0 stamp reg
    local budget="${POOLED_COLD_BUDGET:-240}" hold="${POOLED_COLD_HOLD:-20}" poll="${POOLED_POLL:-3}"
    local -a state=() app=()
    for c in green blue; do cid="$(svc_cid "app-$c" gremion-ui)"; [[ -n "$cid" ]] && break; done
    [[ -n "$cid" ]] || { bad "cold-state: no app colour running"; return; }
    mapfile -t state < <(docker ps -aq --filter "label=com.docker.compose.project=${STACK}-state" | sed '/^$/d')
    mapfile -t app < <(docker ps -q --filter "label=com.docker.compose.project=${STACK}-app-$c" | sed '/^$/d')
    (( ${#state[@]} > 0 )) || { bad "cold-state: the state project has no container"; return; }
    stamp="$(now)"
    # 0. the probe must see the RUNNING app as ready, or neither control below
    #    can mean anything: register the proof host, then a positive control.
    reg="$(register_proof_host)"
    [[ "$reg" == 1 ]] || { bad "cold-state: could not register the proof host ${PROOF_HOST} for the default tenant in control.tenant_domain (got: ${reg:-nothing})"; return; }
    body="$(ready_body "$cid" "$PROOF_HOST")"
    [[ "$body" == *'"status":"ok"'* ]] || {
        bad "cold-state: positive control -- the edge-shaped /api/health probe does not see the running app-$c as ready, so it cannot prove readiness after a cold start (${body:-no answer})"
        return; }
    # 1. state DOWN, then the app colour re-boots against it
    docker stop -t 5 "${state[@]}" >/dev/null
    docker restart -t 5 "${app[@]}" >/dev/null
    sleep "$hold"
    # 2. negative control: with state down the app must NOT report ready
    body="$(ready_body "$cid" "$PROOF_HOST")"
    [[ "$body" == *'"status":"ok"'* ]] \
        && bad "cold-state: /api/health answers ok with the state tier DOWN -- the probe cannot tell ready from booting ($body)"
    # 3. state back up, healthy
    docker start "${state[@]}" >/dev/null
    for s in postgres keycloak; do
        scid="$(svc_cid state "$s")"
        if [[ -z "$scid" ]] || ! wait_health "$scid" 200; then bad "cold-state: state/$s not healthy after the cold start"; fi
    done
    # 4. the app becomes READY within the budget, without a restart of its own
    while (( t < budget )); do
        body="$(ready_body "$cid" "$PROOF_HOST")"
        [[ "$body" == *'"status":"ok"'* ]] && break
        sleep "$poll"; t=$(( t + poll ))
    done
    if [[ "$body" == *'"status":"ok"'* ]]; then
        ok "cold-state: app-$c booted against a DOWN state tier and is ready ${t}s after state returned ($body)"
        printf '%s cold-state ready app-%s after %ss (state down %ss at boot)\n' "$stamp" "$c" "$t" "$hold" | ledger cold-state.log
    else
        bad "cold-state: app-$c gremion-ui not ready ${budget}s after the state tier returned (/api/health: ${body:-no answer})"
        printf '%s cold-state NOT ready app-%s after %ss\n' "$stamp" "$c" "$budget" | ledger cold-state.log
        docker logs --tail 30 "$cid" >&2 || true
    fi
}

phase_teardown() {
    require_scratch teardown
    local p
    for p in app-blue app-green state ops mail; do
        docker ps -aq --filter "label=com.docker.compose.project=${STACK}-$p" | xargs -r docker rm -f >/dev/null
    done
    docker ps -aq --filter "name=^${STACK}-" | xargs -r docker rm -f >/dev/null
    docker network ls -q --filter "name=^${STACK}" | xargs -r docker network rm >/dev/null
    docker volume ls -q --filter "name=^${STACK}" | xargs -r docker volume rm >/dev/null
    [[ -f "$OUT/.created-userlist" ]] && rm -f "$ROOT/docker/pgbouncer/userlist.txt" "$OUT/.created-userlist"
    [[ -f "$OUT/.created-ipcrypt" ]] && rm -f "$ROOT/secrets/ipcrypt_key.txt" "$OUT/.created-ipcrypt"
    # The scratch GREMION_ROOT and the customer proof's own OUT for this STACK:
    # a stale etc/secrets (tenant_provisioner) answers a fresh Keycloak with
    # 401 invalid_client. The ledger under ${OUT}/ledger is kept.
    scratch_rm "$SROOT" || true
    scratch_rm "$ROOT/.scratch/customer-provision-proof/${STACK}" || true
    local left
    left="$(docker ps -aq --filter "name=^${STACK}" | grep -c . || true)$(docker network ls -q --filter "name=^${STACK}" | grep -c . || true)$(docker volume ls -q --filter "name=^${STACK}" | grep -c . || true)"
    if [[ "$left" == 000 ]]; then ok "teardown: no container, network or volume under ${STACK} remains"
    else bad "teardown left resources (containers/networks/volumes: $left)"; fi
}

run_phase() {
    case "$1" in
        prepare) phase_prepare ;;
        render-env) phase_render_env ;;
        names) phase_names ;;
        state-up) phase_state_up ;;
        state-wait) phase_state_wait ;;
        app-up) phase_app_up "$2" ;;
        app-wait) phase_app_wait "$2" ;;
        aux-up) phase_aux_up ;;
        mail-roles) phase_mail_roles ;;
        mail-realm) phase_mail_realm ;;
        limits) phase_limits ;;
        rss) phase_rss ;;
        isolation) phase_isolation ;;
        probes) phase_probes ;;
        tenant-before) phase_tenant_before ;;
        tenant) phase_tenant ;;
        tenant-after) phase_tenant_after ;;
        switch) phase_switch ;;
        cold-state) phase_cold_state ;;
        teardown) phase_teardown ;;
        *) die "unknown phase '$1'" ;;
    esac
}

# sourced (test/host/pooled-stack-proof.bats unit-tests the helpers): stop here
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0
[[ $# -gt 0 ]] || set -- all
PHASES="$*"   # recorded before the loop below shifts the arguments away
info "STACK=${STACK} scope=${SCOPE} ledger=${OUT}/ledger"
if [[ "$1" == all ]]; then
    require_scratch all
    trap 'phase_teardown || true' EXIT
    for ph in prepare names state-up state-wait "app-up blue" "app-wait blue" aux-up limits rss isolation probes tenant-before tenant tenant-after "app-up green" "app-wait green" switch cold-state limits; do
        # shellcheck disable=SC2086
        run_phase $ph
    done
else
    while [[ $# -gt 0 ]]; do
        case "$1" in
            app-up|app-wait) run_phase "$1" "${2:?colour}"; shift 2 ;;
            *) run_phase "$1"; shift ;;
        esac
    done
fi
printf '%s phases [%s] RED=%s\n' "$(now)" "$PHASES" "$RED" | ledger run.log
if (( RED )); then echo "[pooled-proof] RED" >&2; exit 1; fi
echo "[pooled-proof] GREEN"
