#!/usr/bin/env bash
# infra/host/lib/customer-ops.sh — the host half of the customer lifecycle as
# LIBRARY functions (TASK-043d-1, D10: moved, not duplicated, out of
# infra/host/bin/gremion-tenant; bodies unchanged except names). Since R31-I4
# no operator runs them by hand: the host-side executor's handlers
# (infra/host/lib/executor/handlers/*.sh) call them for a verified request;
# gremion-tenant keeps the bootstrap verbs and sources this file for tc().
#
# SOURCED, NEVER EXECUTED (no `set -euo pipefail` here, common.sh's rule); the
# caller sources common.sh first and sets strict mode itself.
#
# PHASES of customer_create: container phase A (the tenant-create one-shot of
# the ACTIVE colour: realm, kernel database, domain, storage prefix, first
# body, broker account), then THIS host's mail step (gremion-vendor-mail
# realm-smtp --realm <slug> --tenant <token>: the customer's own submission
# principal, issued and stamped; tenant-create is not on the mail network,
# TRD-045), then `record-step mail_principal_issued` (the container re-reads
# the stamp over Keycloak), then container phase B (first administrators, the
# --enable modules, active), then the router file, which the host writes (Q17:
# a compose etc/edge mount is refused, hygiene j4). A failed step STOPS:
# nothing after it runs, and a rerun resumes from the ledger.
#
# TRD-440: customer_create counts the running containers and every project's
# `config --services` before and after, and fails if either moved -- a
# customer adds databases, a realm and accounts, never a container.
#
# SECRETS never reach an argv: the app passwords, admin URLs and the
# provisioner credential tenant-create reads are 0600 files under
# etc/secrets/tenant-create (written by `init`; mounted read-only), and the
# vendor mail principal's password never leaves gremion-vendor-mail.

# The release's own infra/host/bin (this file lives in its ../lib): the
# sibling gremion-vendor-mail resolves its ops/vendor-mail tree from there.
CUSTOMER_OPS_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"

SLUG_RE='^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
EMAIL_RE='^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$'

ROOT="${ROOT:-}"
RELEASE_DIR="${RELEASE_DIR:-}"
COLOUR="${COLOUR:-}"
OPERATOR_ID="${OPERATOR_ID:-${GREMION_OPERATOR_ID:-}}"

setup_paths() {
    ROOT="$(gremion_root)"
    RELEASE_DIR="${GREMION_RELEASE_DIR:-${ROOT}/current}"
}

# env_key <file> <key> — ONE key of an env file (the gremion-vendor-mail reader).
env_key() {
    local file="$1" key="$2" n v
    [[ -f "$file" ]] || die "env file not found: ${file}" "$GREMION_EXIT_USAGE"
    n="$(grep -c "^${key}=" "$file" || true)"
    [[ "$n" -le 1 ]] || die "duplicate key ${key} in ${file}" "$GREMION_EXIT_USAGE"
    v="$(sed -n "s/^${key}=//p" "$file")"
    v="${v%$'\r'}"
    if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
    printf '%s' "$v"
}

active_colour() {
    local f="${ROOT}/runtime/active-colour" c=""
    [[ -f "$f" ]] && c="$(tr -d '[:space:]' < "$f")"
    case "$c" in
        blue|green) COLOUR="$c" ;;
        *) die "runtime/active-colour is '${c:-absent}', not blue or green: deploy a colour first (tenant-create runs in the active colour)" "$GREMION_EXIT_USAGE" ;;
    esac
}

need_slug() {   # <slug>
    [[ -n "${1:-}" ]] || die "missing <slug>" "$GREMION_EXIT_USAGE"
    [[ "$1" =~ $SLUG_RE && ${#1} -ge 3 && ${#1} -le 30 && "$1" != platform ]] \
        || die "invalid customer slug '$1' (^[a-z][a-z0-9]*(-[a-z0-9]+)*$, 3-30, not platform)" "$GREMION_EXIT_USAGE"
}

need_operator() {
    [[ -n "$OPERATOR_ID" ]] || die "no operator id: pass --operator <uuid> or export GREMION_OPERATOR_ID (the ops-realm user id)" "$GREMION_EXIT_USAGE"
    [[ "$OPERATOR_ID" =~ $UUID_RE ]] || die "operator id '${OPERATOR_ID}' is not a lowercase uuid" "$GREMION_EXIT_USAGE"
}

token_of() { printf '%s' "${1//-/_}"; }

# need_value "$@" — the flag in $1 carries a value in $2 (usage exit 2, named),
# never a bare `shift 2` failing under errexit with exit 1 and no message.
need_value() {
    [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 requires a value" "$GREMION_EXIT_USAGE"
}

# tc <args...> — the tenant-create one-shot of the ACTIVE colour, the one
# shape a compose command takes on a host (N20): --env-file, no -f, no -p.
# The optional TC_MOUNT carries extra `run` arguments: create's read-only
# --config mount, or init's bootstrap-provisioner scratch mount and name-only -e's.
TC_MOUNT=()
# release_tip -- TASK-044 (lane note D4, A6), re-applied after the cmd_create
# move: the full commit id of the release tree gremion-deploy authenticated
# (H10: HEAD == the verified tag's commit). The level-1 enable gate compares
# isolation evidence with it. It is DERIVED here and never read from the
# caller's environment or a request payload; a tree that is no git checkout of
# its own (a parent repository must not lend its HEAD) or a value that is not
# 40/64 lowercase hex gives the empty string, which the gate turns into
# NO_RELEASE_TIP at enable time only.
release_tip() {
    local sha=""
    if [[ -e "${RELEASE_DIR}/.git" ]] && command -v git >/dev/null 2>&1; then
        sha="$(git -C "$RELEASE_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
    fi
    [[ "$sha" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || sha=""
    printf '%s' "$sha"
}

tc() {
    local envfile="${ROOT}/etc/env/app-${COLOUR}.env"
    [[ -f "$envfile" ]] || die "env file absent: ${envfile}" "$GREMION_EXIT_USAGE"
    local tip; tip="$(release_tip)"
    ( cd "$RELEASE_DIR" && docker compose --env-file "$envfile" run --rm -T \
        -e "GREMION_RELEASE_TIP=${tip}" \
        -e TRAEFIK_CERT_RESOLVER -e EDGE_BIND_IP -e EDGE_BIND_IP6 -e TENANT_DNS_PREFLIGHT -e GREMION_SCRATCH_FIXTURES -e GREMION_PRODUCTION_STACK \
        "${TC_MOUNT[@]}" tenant-create "$@" )
}

vendor_mail() { "${CUSTOMER_OPS_BIN}/gremion-vendor-mail" "$@"; }

load_host_facts() {
    local state="${ROOT}/etc/env/state.env"
    TRAEFIK_CERT_RESOLVER="$(env_key "$state" TRAEFIK_CERT_RESOLVER)"
    [[ -n "$TRAEFIK_CERT_RESOLVER" ]] || die "TRAEFIK_CERT_RESOLVER is empty in ${state}" "$GREMION_EXIT_USAGE"
    # The DNS pre-flight compares the customer's host with the edge's own
    # public addresses (the state project's required EDGE_BIND_IP/_IP6).
    EDGE_BIND_IP="$(env_key "$state" EDGE_BIND_IP)"
    EDGE_BIND_IP6="$(env_key "$state" EDGE_BIND_IP6)"
    [[ -n "$EDGE_BIND_IP" ]] || die "EDGE_BIND_IP is empty in ${state}" "$GREMION_EXIT_USAGE"
    export TRAEFIK_CERT_RESOLVER EDGE_BIND_IP EDGE_BIND_IP6
}

# ── TRD-440: no container per customer ─────────────────────────────────────
# Every measurement must SUCCEED (review C, r2): a failing `docker ps` or
# `config --services` used to yield an empty field on both sides, which
# compared equal. Each project renders from its own directory, as
# scripts/check-pooled-stack.mjs does (ops and mail name COMPOSE_FILEs
# relative to compose/observability and infra/host/mail).
container_fingerprint() {
    local n f name dir svcs="" out
    out="$(docker ps -q)" || die "TRD-440: docker ps failed" "$GREMION_EXIT_ASSERT"
    n="$(grep -c . <<< "$out" || true)"
    for name in state app-blue app-green ops mail; do
        f="${ROOT}/etc/env/${name}.env"
        [[ -f "$f" ]] || continue
        case "$name" in
            ops)  dir="${RELEASE_DIR}/compose/observability" ;;
            mail) dir="${RELEASE_DIR}/infra/host/mail" ;;
            *)    dir="$RELEASE_DIR" ;;
        esac
        out="$(cd "$dir" && docker compose --env-file "$f" config --services)" \
            || die "TRD-440: docker compose config --services failed for the ${name} project" "$GREMION_EXIT_ASSERT"
        [[ -n "$out" ]] || die "TRD-440: the ${name} project renders no service" "$GREMION_EXIT_ASSERT"
        svcs+="${name}:$(sort <<< "$out" | tr '\n' ',');"
    done
    printf 'containers=%s services=%s' "$n" "$svcs"
}

# ── the router file (Q17: the host writes emit.ts's contract) ─────────────
write_router() {   # <slug>
    local slug="$1" dir="${ROOT}/etc/edge" final tmp
    final="${dir}/tenant-${slug}.yml"
    [[ -d "$dir" ]] || die "etc/edge is absent: ${dir}" "$GREMION_EXIT_USAGE"
    # The temp name does not end in .yml: Traefik's file provider never loads it.
    tmp="$(mktemp "${dir}/.tenant-${slug}.XXXXXX.tmp")"
    # shellcheck disable=SC2064  # expand $tmp now
    trap "rm -f '${tmp}'" EXIT
    tc render-router "$slug" > "$tmp" || die "render-router ${slug} failed" "$GREMION_EXIT_ASSERT"
    if [[ ! -s "$tmp" ]] || ! grep -q '^  routers:' "$tmp"; then
        die "render-router ${slug} printed no router document" "$GREMION_EXIT_ASSERT"
    fi
    grep -qF "    tenant-${slug}.kc:" "$tmp" || die "the router document of ${slug} carries no realm router (Q16)" "$GREMION_EXIT_ASSERT"
    chmod 644 "$tmp"
    sync "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$final" || die "could not move the router file into place: ${final}" "$GREMION_EXIT_ASSERT"
    sync "$dir" 2>/dev/null || true
    trap - EXIT
    ok "router file ${final} written"
}

# ── the mail step: the ONE seam between phase A and phase B ────────────────
# mail_step <slug> <token> -- how a customer's mail identity is issued, chosen
# at deploy time by MAIL_TRANSPORT (operator decision 2026-10-21: external SMTP
# relay OR slim Stalwart). customer_create calls nothing else for mail, so the
# mail-transport unit (PLAN-mail-transport M3) adds its `relay` arm HERE and
# nowhere else. Today only `stalwart` exists, the behaviour this step always
# had: the customer's own submission principal kc-<token>@ (vendor-mail
# realm-smtp), then the ledger step mail_principal_issued. An unknown value
# fails closed BEFORE any principal is issued, so phase B does not run.
mail_step() {
    local slug="$1" token="$2"
    case "${MAIL_TRANSPORT:-stalwart}" in
        stalwart)
            info "host: the customer's own submission principal kc-${token}@"
            vendor_mail realm-smtp --realm "$slug" --tenant "$token" \
                || die "the mail step of ${slug} failed; phase B does not run (a rerun resumes here)" "$GREMION_EXIT_ASSERT"
            tc record-step "$slug" mail_principal_issued --operator "$OPERATOR_ID" \
                || die "record-step mail_principal_issued of ${slug} failed" "$GREMION_EXIT_ASSERT"
            ;;
        *)
            die "MAIL_TRANSPORT=${MAIL_TRANSPORT} is not a mail transport this release knows (stalwart); the mail step of ${slug} did not run and phase B does not run" "$GREMION_EXIT_USAGE"
            ;;
    esac
}

# ── create (was gremion-tenant's cmd_create) ───────────────────────────────
# customer_create <slug> --host <host> --config <file> --it-admin <email>
#   --council-admin <email> --operator <uuid> [--enable a,b] [--body-name <name>]
#   [--dpia-json <file>]
# --dpia-json (TASK-043d C13): the operator's per-module DPIA decisions of the
# create request, mounted read-only and handed to both container phases
# (TASK-044's CreateSpec.dpia reads it; a container without it ignores it).
customer_create() {
    local slug="${1:-}"; shift || true
    need_slug "$slug"
    local host="" config="" it="" council="" enable="" body="" dpia=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host) need_value "$@"; host="$2"; shift 2 ;;
            --config) need_value "$@"; config="$2"; shift 2 ;;
            --it-admin) need_value "$@"; it="$2"; shift 2 ;;
            --council-admin) need_value "$@"; council="$2"; shift 2 ;;
            --enable) need_value "$@"; enable="$2"; shift 2 ;;
            --body-name) need_value "$@"; body="$2"; shift 2 ;;
            --operator) need_value "$@"; OPERATOR_ID="$2"; shift 2 ;;
            --dpia-json) need_value "$@"; dpia="$2"; shift 2 ;;
            *) die "create: unknown argument: $1" "$GREMION_EXIT_USAGE" ;;
        esac
    done
    need_operator
    [[ -n "$host" ]] || die "create needs --host <host>" "$GREMION_EXIT_USAGE"
    [[ -f "$config" ]] || die "create needs --config <existing file>" "$GREMION_EXIT_USAGE"
    [[ "$it" =~ $EMAIL_RE ]] || die "create needs --it-admin <email>" "$GREMION_EXIT_USAGE"
    [[ "$council" =~ $EMAIL_RE ]] || die "create needs --council-admin <email>" "$GREMION_EXIT_USAGE"
    [[ -z "$enable" || "$enable" =~ ^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$ ]] || die "--enable takes a,b,c module ids" "$GREMION_EXIT_USAGE"
    [[ -z "$dpia" || -f "$dpia" ]] || die "--dpia-json names no file" "$GREMION_EXIT_USAGE"
    active_colour
    load_host_facts
    local token before after
    token="$(token_of "$slug")"
    before="$(container_fingerprint)"

    local -a flags=("$slug" --host "$host" --config /run/gremion/tenant-config.json --operator "$OPERATOR_ID"
                    --it-admin "$it" --council-admin "$council")
    [[ -z "$enable" ]] || flags+=(--enable "$enable")
    [[ -z "$body" ]] || flags+=(--body-name "$body")
    local -a mounts=(-v "$(realpath "$config"):/run/gremion/tenant-config.json:ro")
    if [[ -n "$dpia" ]]; then
        flags+=(--dpia-json /run/gremion/dpia.json)
        mounts+=(-v "$(realpath "$dpia"):/run/gremion/dpia.json:ro")
    fi
    TC_MOUNT=("${mounts[@]}")

    info "phase A (container): realm, kernel database, domain, storage prefix, first body, broker account"
    tc phase-a "${flags[@]}" || die "phase A of ${slug} failed; a rerun resumes from the ledger" "$GREMION_EXIT_ASSERT"
    TC_MOUNT=()
    mail_step "$slug" "$token"
    TC_MOUNT=("${mounts[@]}")
    info "phase B (container): first administrators, modules, active"
    tc phase-b "${flags[@]}" || die "phase B of ${slug} failed; a rerun resumes from the ledger" "$GREMION_EXIT_ASSERT"
    TC_MOUNT=()
    write_router "$slug"

    after="$(container_fingerprint)"
    if [[ "$before" != "$after" ]]; then
        bad "TRD-440: the container set moved during create (before: ${before}; after: ${after})"
        exit "$GREMION_EXIT_ASSERT"
    fi
    ok "customer ${slug} created (TRD-440: container set unchanged)"
}
