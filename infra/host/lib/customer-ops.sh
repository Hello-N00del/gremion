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

# The mail transport front (PLAN-mail-transport M2): ONE launcher decides, from
# MAIL_TRANSPORT (relay | stalwart; no default), how a realm's sender is stamped.
# Every realm-smtp call goes through mail_realm_smtp -- stalwart hands over to
# gremion-vendor-mail untouched, relay stamps the shared relay sender.
mail_front() { "${CUSTOMER_OPS_BIN}/gremion-mail" "$@"; }
mail_realm_smtp() { mail_front realm-smtp "$@"; }
# mail_sender_args -- sets MAIL_SENDER_ARGS to the container-side flag that tells
# tenant-create which sender the host stamped (relay only; stalwart passes nothing,
# so its container calls are byte-identical to before). Fails closed when the
# transport cannot be resolved.
MAIL_SENDER_ARGS=()
mail_sender_args() {
    local t j
    MAIL_SENDER_ARGS=()
    t="$(mail_front transport)" || return 1
    if [[ "$t" == relay ]]; then
        j="$(mail_front sender-json)" || return 1
        MAIL_SENDER_ARGS=(--sender-json "$j")
    fi
}

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
# relay OR slim Stalwart). customer_create calls nothing else for mail.
#   stalwart  the customer's own submission principal kc-<token>@ (vendor-mail
#             realm-smtp), then the ledger step mail_principal_issued -- the
#             behaviour this step always had, byte for byte.
#   relay     NO per-realm principal: the realm is stamped with the shared
#             relay sender (gremion-mail realm-smtp), then the SAME ledger step
#             mail_principal_issued records after the container reads the stamp
#             back (8/8 stays 8/8; the step kind does not change).
# An unresolved or unknown MAIL_TRANSPORT fails closed BEFORE any identity is
# issued, so phase B does not run. MAIL_SENDER_ARGS carries the relay descriptor
# on to the container calls that follow (record-step here, phase B after).
mail_step() {
    local slug="$1" token="$2" transport
    transport="$(mail_front transport)"         || die "MAIL_TRANSPORT is unresolved or not a transport this release knows (relay, stalwart); the mail step of ${slug} did not run and phase B does not run" "$GREMION_EXIT_USAGE"
    case "$transport" in
        stalwart)
            MAIL_SENDER_ARGS=()
            info "host: the customer's own submission principal kc-${token}@"
            mail_realm_smtp --realm "$slug" --tenant "$token"                 || die "the mail step of ${slug} failed; phase B does not run (a rerun resumes here)" "$GREMION_EXIT_ASSERT"
            tc record-step "$slug" mail_principal_issued --operator "$OPERATOR_ID"                 || die "record-step mail_principal_issued of ${slug} failed" "$GREMION_EXIT_ASSERT"
            ;;
        relay)
            mail_sender_args || die "the relay sender of ${slug} could not be resolved; phase B does not run" "$GREMION_EXIT_ASSERT"
            info "host: the shared relay sender (no per-customer principal)"
            mail_realm_smtp --realm "$slug" --tenant "$token"                 || die "the mail step of ${slug} failed; phase B does not run (a rerun resumes here)" "$GREMION_EXIT_ASSERT"
            tc record-step "$slug" mail_principal_issued --operator "$OPERATOR_ID" "${MAIL_SENDER_ARGS[@]}"                 || die "record-step mail_principal_issued of ${slug} failed" "$GREMION_EXIT_ASSERT"
            ;;
        *)
            die "MAIL_TRANSPORT resolved to ${transport}, which this release does not know (relay, stalwart); the mail step of ${slug} did not run" "$GREMION_EXIT_USAGE"
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
    tc phase-b "${flags[@]}" ${MAIL_SENDER_ARGS[@]+"${MAIL_SENDER_ARGS[@]}"} || die "phase B of ${slug} failed; a rerun resumes from the ledger" "$GREMION_EXIT_ASSERT"
    TC_MOUNT=()
    write_router "$slug"

    after="$(container_fingerprint)"
    if [[ "$before" != "$after" ]]; then
        bad "TRD-440: the container set moved during create (before: ${before}; after: ${after})"
        exit "$GREMION_EXIT_ASSERT"
    fi
    ok "customer ${slug} created (TRD-440: container set unchanged)"
}

# ── suspend and resume (TRD-044, PRD-OPS-004; were gremion-tenant's cmd_*) ──
# The executor's `suspend` / `resume` handlers call these; gremion-tenant's
# break-glass verbs call them too. DATA IS UNTOUCHED: the container verbs only
# flip the status, the realm and the broker users, and the host step only the
# mail principal. The router file stays exactly as it is: a suspended customer's
# route keeps resolving and the app serves its branded 503 on status `suspended`
# (suspendCustomer sets the status FIRST). Each verb takes the TRD-440 fingerprint
# before and after and fails if it moved; the suspend leaves its "before" in
# runtime/suspended/<slug>.fingerprint and the resume must end on the same value,
# so a resume proves the stack is what it was before the suspend.
suspended_fingerprint_file() { printf '%s/runtime/suspended/%s.fingerprint' "$ROOT" "$1"; }

# _lifecycle_args <verb> <slug> [--operator <uuid>] -- validates; sets OPERATOR_ID.
_lifecycle_args() {
    local verb="$1"; shift
    local slug="${1:-}"; shift || true
    need_slug "$slug"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --operator) need_value "$@"; OPERATOR_ID="$2"; shift 2 ;;
            *) die "${verb}: unknown argument: $1" "$GREMION_EXIT_USAGE" ;;
        esac
    done
    need_operator
}

customer_suspend() {   # <slug> --operator <uuid>
    local slug="${1:-}" before after f
    _lifecycle_args suspend "$@"
    active_colour
    before="$(container_fingerprint)"
    tc suspend "$slug" --operator "$OPERATOR_ID" || die "suspend of ${slug} failed in the container" "$GREMION_EXIT_ASSERT"
    # The tenant is already 503 with its realm disabled (fail closed). The host
    # step un-stamps the realm's sender before it deletes the principal, and every
    # step is re-runnable, so a failure here is recovered by the same verb (the
    # container step above repeats harmlessly).
    mail_realm_smtp --realm "$slug" --tenant "$(token_of "$slug")" --revoke \
        || die "the principal of ${slug} could not be revoked; the customer is already suspended, rerun gremion-tenant suspend ${slug} to converge" "$GREMION_EXIT_ASSERT"
    after="$(container_fingerprint)"
    if [[ "$before" != "$after" ]]; then
        bad "TRD-440: the container set moved during suspend (before: ${before}; after: ${after})"
        exit "$GREMION_EXIT_ASSERT"
    fi
    f="$(suspended_fingerprint_file "$slug")"
    # keep the FIRST suspend's value: a converging rerun must not overwrite it
    if [[ ! -f "$f" ]]; then
        mkdir -p "$(dirname "$f")"
        printf '%s\n' "$before" | atomic_write "$f" 600 || die "could not record the fingerprint of ${slug}" "$GREMION_EXIT_ASSERT"
    fi
    ok "customer ${slug} suspended (TRD-440: container set unchanged, data untouched)"
}

customer_resume() {   # <slug> --operator <uuid>
    local slug="${1:-}" before after f recorded=""
    _lifecycle_args resume "$@"
    active_colour
    f="$(suspended_fingerprint_file "$slug")"
    [[ ! -f "$f" ]] || recorded="$(head -n 1 "$f")"
    before="$(container_fingerprint)"
    mail_realm_smtp --realm "$slug" --tenant "$(token_of "$slug")" \
        || die "a fresh principal for ${slug} could not be issued" "$GREMION_EXIT_ASSERT"
    mail_sender_args || die "resume of ${slug}: MAIL_TRANSPORT could not be resolved" "$GREMION_EXIT_USAGE"
    tc resume "$slug" --operator "$OPERATOR_ID" ${MAIL_SENDER_ARGS[@]+"${MAIL_SENDER_ARGS[@]}"} || die "resume of ${slug} failed in the container" "$GREMION_EXIT_ASSERT"
    after="$(container_fingerprint)"
    if [[ "$before" != "$after" || ( -n "$recorded" && "$recorded" != "$after" ) ]]; then
        bad "TRD-440: the container set differs after resume (before resume: ${before}; after: ${after}; before the suspend: ${recorded:-unrecorded})"
        exit "$GREMION_EXIT_ASSERT"
    fi
    rm -f "$f"
    ok "customer ${slug} resumed (TRD-440: container set equal to before the suspend, data untouched)"
}

# ── modules, DPIA decision and reconcile (TRD-044; reconcile was gremion-tenant's cmd_*) ──
# The executor's enable_module / disable_module / record_dpia / reconcile handlers
# call these. The container verbs hold the rules (the level-1 gate, the DPIA
# decision, export-before-drop); the host adds the TRD-440 fingerprint around the
# two that change a customer's module set (the container set must not move: the
# stack is pooled, a module is data and a broker user, never a container).

# _module_args <verb> <slug> <module> [--operator <uuid>] [--dpia-json <file>] -- sets OPERATOR_ID, MODULE_ID, DPIA_JSON.
_module_args() {
    local verb="$1"; shift
    local slug="${1:-}"; shift || true
    MODULE_ID="${1:-}"; shift || true
    DPIA_JSON=""
    need_slug "$slug"
    [[ "$MODULE_ID" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "${verb}: invalid module id '${MODULE_ID}'" "$GREMION_EXIT_USAGE"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --operator) need_value "$@"; OPERATOR_ID="$2"; shift 2 ;;
            --dpia-json) need_value "$@"; DPIA_JSON="$2"; shift 2 ;;
            *) die "${verb}: unknown argument: $1" "$GREMION_EXIT_USAGE" ;;
        esac
    done
    need_operator
}

# _assert_fingerprint <verb> <slug> <before> — the container set is what it was.
_assert_fingerprint() {
    local after; after="$(container_fingerprint)"
    if [[ "$3" != "$after" ]]; then
        bad "TRD-440: the container set moved during ${1} of ${2} (before: ${3}; after: ${after})"
        exit "$GREMION_EXIT_ASSERT"
    fi
}

customer_enable_module() {   # <slug> <module> --operator <uuid> [--dpia-json <file>]
    local slug="${1:-}" before
    _module_args enable_module "$@"
    active_colour
    before="$(container_fingerprint)"
    local -a argv=(enable-module "$slug" "$MODULE_ID" --operator "$OPERATOR_ID")
    [[ -z "$DPIA_JSON" ]] || argv+=(--dpia-json "$DPIA_JSON")
    tc "${argv[@]}" || die "enable of ${MODULE_ID} for ${slug} failed in the container" "$GREMION_EXIT_ASSERT"
    _assert_fingerprint enable_module "$slug" "$before"
    ok "module ${MODULE_ID} enabled for ${slug} (TRD-440: container set unchanged)"
}

customer_disable_module() {   # <slug> <module> --operator <uuid>
    local slug="${1:-}" before
    _module_args disable_module "$@"
    active_colour
    before="$(container_fingerprint)"
    tc disable-module "$slug" "$MODULE_ID" --operator "$OPERATOR_ID" || die "disable of ${MODULE_ID} for ${slug} failed in the container" "$GREMION_EXIT_ASSERT"
    _assert_fingerprint disable_module "$slug" "$before"
    ok "module ${MODULE_ID} disabled for ${slug} (exported before it was dropped; TRD-440: container set unchanged)"
}

customer_record_dpia() {   # <slug> <module> --operator <uuid> --requires-dpia yes|no --reason-codes a,b --document-ref <text>
    local slug="${1:-}" requires="" codes="" ref=""
    local -a rest=()
    shift || true
    local module="${1:-}"; shift || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --requires-dpia) need_value "$@"; requires="$2"; shift 2 ;;
            --reason-codes) need_value "$@"; codes="$2"; shift 2 ;;
            --document-ref) need_value "$@"; ref="$2"; shift 2 ;;
            *) rest+=("$1"); shift ;;
        esac
    done
    _module_args record_dpia "$slug" "$module" ${rest[@]+"${rest[@]}"}
    [[ "$requires" == yes || "$requires" == no ]] || die "record_dpia: --requires-dpia is yes or no" "$GREMION_EXIT_USAGE"
    [[ -n "$codes" && -n "$ref" ]] || die "record_dpia: --reason-codes and --document-ref are required" "$GREMION_EXIT_USAGE"
    active_colour
    tc dpia-record "$slug" "$MODULE_ID" --operator "$OPERATOR_ID" --requires-dpia "$requires" --reason-codes "$codes" --document-ref "$ref" \
        || die "the DPIA decision for ${MODULE_ID} of ${slug} could not be recorded" "$GREMION_EXIT_ASSERT"
    ok "DPIA decision for ${MODULE_ID} of ${slug} recorded (an identical latest one is reused)"
}

# customer_reconcile <slug> [--apply] — the realm contract. Without --apply: the
# verify-only report (exit 1 on drift). With --apply: the container repair, then
# the host rotation of the mail principal when the report says smtp-server is
# `repair: host`, then a verify-only that must be green.
customer_reconcile() {
    local slug="${1:-}"; shift || true
    need_slug "$slug"
    local apply=no report
    while [[ $# -gt 0 ]]; do case "$1" in --apply) apply=yes; shift ;; *) die "reconcile: unknown argument: $1" "$GREMION_EXIT_USAGE" ;; esac; done
    active_colour
    mail_sender_args || die "reconcile of ${slug}: MAIL_TRANSPORT could not be resolved" "$GREMION_EXIT_USAGE"
    if [[ "$apply" == no ]]; then
        tc reconcile --verify-only "$slug" ${MAIL_SENDER_ARGS[@]+"${MAIL_SENDER_ARGS[@]}"}
        return
    fi
    # The apply exits 0 (green) or 1 (a check still fails: the drift --apply is
    # for) and prints its report as ONE JSON line on stdout. A crash, a missing
    # or unparseable report, or any other exit fails loudly here (review C, r2)
    # instead of silently skipping the host rotation.
    local out rc=0
    out="$(tc reconcile "$slug" ${MAIL_SENDER_ARGS[@]+"${MAIL_SENDER_ARGS[@]}"})" || rc=$?
    (( rc == 0 || rc == 1 )) || die "reconcile --apply of ${slug} failed in the container (exit ${rc})" "$GREMION_EXIT_ASSERT"
    report="$(grep '^{' <<< "$out" | tail -n 1 || true)"
    if [[ -z "$report" ]] || ! jq -e 'type == "object" and (.repairHost | type) == "array"' <<< "$report" >/dev/null 2>&1; then
        die "reconcile --apply of ${slug} printed no parseable report (exit ${rc}); nothing was rotated" "$GREMION_EXIT_ASSERT"
    fi
    if jq -e '.repairHost | index("smtp-server")' <<< "$report" >/dev/null; then
        info "smtp-server is repair: host -- rotating the principal of ${slug}"
        mail_realm_smtp --realm "$slug" --tenant "$(token_of "$slug")" --rotate \
            || die "the principal of ${slug} could not be rotated" "$GREMION_EXIT_ASSERT"
    fi
    tc reconcile --verify-only "$slug" ${MAIL_SENDER_ARGS[@]+"${MAIL_SENDER_ARGS[@]}"}
}
