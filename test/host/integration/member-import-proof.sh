#!/usr/bin/env bash
# ============================================================
# member-import-proof.sh -- TASK-031's RUNNING proof (PRD-IDN-010).
#
#   bash test/host/integration/member-import-proof.sh <phase>...
#
# Runs against a RUNNING pooled scratch stack that already holds one ACTIVE
# customer (customer-provision-proof.sh customer-create-x leaves proof-x), built
# from the commit under test. It never brings a stack up, never runs
# `docker compose down`, never prunes and never touches a gremion_* volume.
# Every phase is its own call (no tool call over four minutes). Evidence is read
# from the running system: psql into the customer's kernel database, the realm's
# users through kcadm, the pre-migration dump ledger, the request events.
#
# Environment
#   POOLED_STACK / POOLED_ENV_DIR   the running stack and its env files
#   PROOF_OPERATOR_ID               a platform-realm user id (lowercase uuid)
#   PROOF_CUSTOMER                  the active customer (default proof-x)
#   PROOF_VERTICAL                  the vertical id (default fixture); the fixture
#                                   vertical is staged by import-stage
#   PROOF_MODULES_OFF=1             (default) messaging and files are OFF for the
#                                   customer: the seed must write wants_matrix_room /
#                                   wants_nextcloud_folder false (decision D-8)
#
# Phases
#   import-stage    copy the fixture vertical into verticals/<id>; the tenant-create
#                   image of the stack must then be rebuilt from this tree
#   import-seed     a seed_vertical request: the vertical's units exist, one
#                   keycloak resource row per unit, and with messaging / files OFF
#                   no matrix / nextcloud row is pending or failed (D-8)
#   import-reject   a list whose every row is rejected: the request fails naming
#                   rows by number and reason; no account, no membership, no dump
#   import-validate the valid list: succeeded, the sha256 in the events, no write
#   import-apply    the apply request: succeeded; memberships exist, one realm
#                   account per distinct address, imported users carry the
#                   UPDATE_PASSWORD required action ONLY (D-5), the pre-migration
#                   dump ledger shows ONE created and ONE deleted line, the
#                   request payload is purged to its canonical shape
#   import-rerun    the same apply again: creates 0 (counts and realm users
#                   unchanged); the dump ledger gained a created + deleted pair
#   import-unstage  remove what import-stage copied
# Every assertion reads a post-condition. Zero checks run is a FAILURE. The
# last line is `[import-proof] N passing (minimum M)`.
# ============================================================
set -euo pipefail
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
ROOT_H="$(host_path "$ROOT")"
FIX="${ROOT}/test/host/fixtures/member-import"
MIN_CHECKS=24

PSTACK="${POOLED_STACK:-}"
PENV="${POOLED_ENV_DIR:-}"
SLUG="${PROOF_CUSTOMER:-proof-x}"
VERTICAL="${PROOF_VERTICAL:-fixture}"
VERTICAL_SRC="${PROOF_VERTICAL_SRC:-${ROOT}/packages/member-import/test/fixtures/verticals/fixture}"
MODULES_OFF="${PROOF_MODULES_OFF:-1}"
OUT="${PROOF_OUT:-${ROOT}/.scratch/member-import-proof/${PSTACK:-unset}}"

CHECKS=0
RED=0
ok()   { printf '  ok   %s\n' "$*"; CHECKS=$(( CHECKS + 1 )); }
bad()  { printf '  FAIL %s\n' "$*" >&2; RED=1; CHECKS=$(( CHECKS + 1 )); }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
info() { printf '[import-proof] %s\n' "$*"; }
ledger() { mkdir -p "$OUT/ledger"; cat >> "$OUT/ledger/$1"; }

command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"

need_pooled() {
    [[ -n "$PSTACK" && -d "$PENV" && -f "$PENV/state.env" ]] || die "set POOLED_STACK and POOLED_ENV_DIR (a running pooled stack's env files)"
    [[ "${PROOF_OPERATOR_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
        || die "set PROOF_OPERATOR_ID (a platform-realm user id, lowercase uuid)"
    [[ "$PSTACK" =~ ^t[0-9]{3}[a-z]?-[0-9a-f]{8}$ ]] || die "this proof runs on a scratch stack only (POOLED_STACK=${PSTACK})"
}
penv() { sed -n "s/^$1=//p" "$PENV/state.env" | tr -d '"\r' | tail -n1; }
croot() { if [[ -n "${PROOF_GREMION_ROOT:-}" ]]; then printf '%s' "$PROOF_GREMION_ROOT"; else penv GREMION_ROOT; fi; }
svc() { docker ps -q --filter "label=com.docker.compose.project=${PSTACK}-$1" --filter "label=com.docker.compose.service=$2" | head -n1; }
q() { docker exec -i "$(svc state postgres)" psql -v ON_ERROR_STOP=1 -tAqU postgres -d "$1" -c "$2" | tr -d '\r'; }
skc() {
    local cid; cid="$(svc state keycloak)"
    KC_LOGIN_PASSWORD="$(penv KEYCLOAK_ADMIN_PASSWORD)" docker exec -e KC_LOGIN_PASSWORD "$cid" sh -c \
        '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth --realm master --user "$0" --password "$KC_LOGIN_PASSWORD" >/dev/null' \
        "$(penv KEYCLOAK_ADMIN)"
    docker exec "$cid" /opt/keycloak/bin/kcadm.sh "$@"
}
tool() { # <bin> args... -- a host tool against the laid-out root, as the operator
    local bin="$1"; shift
    MSYS_NO_PATHCONV=1 GREMION_ROOT="$(host_path "$(croot)")" GREMION_RELEASE_DIR="$ROOT_H" GREMION_OPERATOR_ID="$PROOF_OPERATOR_ID" \
        GREMION_SCRATCH_FIXTURES="$PSTACK" GREMION_PRODUCTION_STACK=none bash "$ROOT/infra/host/bin/$bin" "$@"
}

# The customer's kernel database: t_<tenant id as 32 hex>__kernel (control registry id).
kernel_db() {
    local id; id="$(q "$(penv CONTROL_DB_NAME)" "SELECT id FROM tenant WHERE slug = '${SLUG}'")"
    [[ -n "$id" ]] || die "customer ${SLUG} is not in the control registry"
    printf 't_%s__kernel' "${id//-/}"
}
k() { q "$(kernel_db)" "$1"; }
realm_users() { skc get users -r "$SLUG" --fields email -q max=1000 | jq -r '.[].email // empty' | grep -c '@import-proof.test$' || true; }
dump_ledger() { local d; d="$(penv GREMION_MIGRATION_DUMP_DIR)"; [[ -n "$d" ]] || die "state.env names no GREMION_MIGRATION_DUMP_DIR"; docker run --rm -v "${d}:/d:ro" --entrypoint cat "$(docker inspect -f '{{.Config.Image}}' "$(svc state postgres)")" /d/ledger.jsonl 2>/dev/null || true; }
dump_events() { dump_ledger | jq -r --arg db "$(kernel_db)" 'select(.database == $db) | .event' | tr '\n' ' '; }

# submit <kind> <args json on stdin> -> the request id (kept 0600 only for the call)
submit() {
    local kind="$1" f id; f="$(mktemp)"; chmod 600 "$f"; cat > "$f"
    id="$(tool gremion-tenant request "$kind" --args-file "$f" --operator "$PROOF_OPERATOR_ID" --reason "member-import-proof: ${kind} ${SLUG}" | tail -n1)" || { rm -f "$f"; return 1; }
    rm -f "$f"
    [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || return 1
    printf '%s\n' "$id"
}
# run_request <id> -> the final state (executor single cycles, at most 3)
run_request() {
    local id="$1" st n
    for n in 1 2 3; do
        tool gremion-executor --once >> "$OUT/ledger/executor.log" 2>&1 || true
        st="$(q gremion_platform "SELECT state FROM plt.provisioning_request WHERE request_id = '${id}'")"
        case "$st" in succeeded|failed|refused|expired|dead) printf '%s' "$st"; return 0 ;; esac
    done
    printf '%s' "$st"; return 1
}
events() { q gremion_platform "SELECT message FROM plt.provisioning_request_event WHERE request_id = '$1' ORDER BY at, event_id"; }
import_args() { # <phase> <csv file> [sha]
    jq -nc --arg slug "$SLUG" --arg phase "$1" --arg v "$VERTICAL" --rawfile csv "$2" --arg sha "${3:-}" \
        '{slug:$slug, phase:$phase, vertical:$v, csv:$csv} + (if $sha == "" then {} else {expectSha256:$sha} end)'
}

phase_import_stage() {
    [[ -d "$VERTICAL_SRC" ]] || die "no vertical to stage at ${VERTICAL_SRC}"
    if [[ -e "$ROOT/verticals/$VERTICAL" ]]; then ok "import-stage: verticals/${VERTICAL} is already part of this tree (nothing staged)"; return; fi
    cp -r "$VERTICAL_SRC" "$ROOT/verticals/$VERTICAL"
    : > "$OUT/staged-vertical" 2>/dev/null || { mkdir -p "$OUT"; : > "$OUT/staged-vertical"; }
    [[ -f "$ROOT/verticals/$VERTICAL/vertical.json" ]] && ok "import-stage: verticals/${VERTICAL} staged; rebuild the stack's tenant-create image from this tree before the next phase" || bad "import-stage: the vertical is not in place"
}

phase_import_unstage() {
    if [[ -f "$OUT/staged-vertical" && -d "$ROOT/verticals/$VERTICAL" ]]; then rm -rf "$ROOT/verticals/$VERTICAL" "$OUT/staged-vertical"; fi
    [[ ! -e "$OUT/staged-vertical" ]] && ok "import-unstage: nothing staged by this proof remains in verticals/" || bad "import-unstage: staged vertical remains"
}

phase_import_seed() {
    need_pooled
    local id st units want
    want="$(jq '.orgUnits | length' "$ROOT/packages/member-import/test/fixtures/verticals/fixture/blueprint.json")"
    id="$(jq -nc --arg slug "$SLUG" --arg v "$VERTICAL" '{slug:$slug, vertical:$v}' | submit seed_vertical)" || { bad "import-seed: the request was not queued"; return; }
    st="$(run_request "$id")" || true
    events "$id" | ledger "seed-${id}.events"
    [[ "$st" == succeeded ]] && ok "import-seed: request ${id} succeeded" || { bad "import-seed: request ${id} is ${st:-unknown}"; return; }
    units="$(k "SELECT count(*) FROM org_units")"
    [[ "$units" == "$want" ]] && ok "import-seed: ${units} units exist (the vertical's blueprint)" || bad "import-seed: ${units} units, expected ${want}"
    [[ "$(k "SELECT count(*) FROM provisioning_resources WHERE subsystem = 'keycloak'")" == "$want" ]] \
        && ok "import-seed: one keycloak resource row per unit" || bad "import-seed: keycloak rows differ from the unit count"
    if [[ "$MODULES_OFF" == 1 ]]; then
        [[ "$(k "SELECT count(*) FROM org_units WHERE wants_matrix_room OR wants_nextcloud_folder")" == 0 ]] \
            && ok "import-seed (D-8): with messaging and files OFF no unit asks for a matrix room or a Nextcloud folder" \
            || bad "import-seed (D-8): a unit asks for a matrix room / Nextcloud folder with the modules off"
        [[ "$(k "SELECT count(*) FROM provisioning_resources WHERE subsystem IN ('matrix','nextcloud') AND status IN ('pending','failed')")" == 0 ]] \
            && ok "import-seed (D-8): no pending or failed matrix / nextcloud resource row" || bad "import-seed (D-8): a matrix / nextcloud row is pending or failed"
    fi
    # a rerun creates nothing
    id="$(jq -nc --arg slug "$SLUG" --arg v "$VERTICAL" '{slug:$slug, vertical:$v}' | submit seed_vertical)" || { bad "import-seed: the rerun was not queued"; return; }
    st="$(run_request "$id")" || true
    [[ "$st" == succeeded && "$(k "SELECT count(*) FROM org_units")" == "$want" ]] \
        && ok "import-seed: a rerun succeeded and left ${want} units" || bad "import-seed: the rerun is ${st:-unknown} or changed the unit count"
}

phase_import_reject() {
    need_pooled
    local id st before_u before_m pre_dump
    pre_dump="$(dump_events)"
    before_u="$(realm_users)"; before_m="$(k "SELECT count(*) FROM org_unit_members")"
    id="$(import_args validate "$FIX/reject-all.csv" | submit import_members)" || { bad "import-reject: not queued"; return; }
    st="$(run_request "$id")" || true
    events "$id" | ledger "reject-${id}.events"
    [[ "$st" == failed ]] && ok "import-reject: the all-rejected list fails the request" || bad "import-reject: request is ${st:-unknown}, expected failed"
    events "$id" | grep -q 'row 2 (Eve Epsilon): ' && events "$id" | grep -q 'row 3 (Fay Zeta): ' \
        && ok "import-reject: every rejected row is named by number and name with a reason" || bad "import-reject: rows not named"
    events "$id" | grep -q '@import-proof.test' && bad "import-reject: an e-mail address reached the event stream" || ok "import-reject: no e-mail address in the event stream"
    [[ "$(realm_users)" == "$before_u" ]] && ok "import-reject: no realm account was created" || bad "import-reject: realm accounts changed"
    [[ "$(k "SELECT count(*) FROM org_unit_members")" == "$before_m" ]] && ok "import-reject: no membership was written" || bad "import-reject: memberships changed"
    [[ "$(dump_events)" == "$pre_dump" ]]         && ok "import-reject: no dump was taken for a list that never validated" || bad "import-reject: the dump ledger moved"
}

phase_import_validate() {
    need_pooled
    local id st sha mb
    mb="$(k "SELECT count(*) FROM org_unit_members")"
    realm_users > "$OUT/users-before"
    id="$(import_args validate "$FIX/members.csv" | submit import_members)" || { bad "import-validate: not queued"; return; }
    st="$(run_request "$id")" || true
    events "$id" | ledger "validate-${id}.events"
    [[ "$st" == succeeded ]] && ok "import-validate: request ${id} succeeded" || { bad "import-validate: request is ${st:-unknown}"; return; }
    sha="$(events "$id" | sed -n 's/.*status=validated sha256=\([0-9a-f]\{64\}\).*//p' | head -n1)"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] && { printf '%s
' "$sha" > "$OUT/sha256"; ok "import-validate: the events carry the list's sha256"; } || bad "import-validate: no sha256 in the events"
    [[ "$(k "SELECT count(*) FROM org_unit_members")" == "$mb" ]] && ok "import-validate: wrote nothing" || bad "import-validate: memberships changed"
    printf '%s
' "$mb" > "$OUT/members-before"
}

phase_import_apply() {
    need_pooled
    local id st sha rows pre
    sha="$(cat "$OUT/sha256" 2>/dev/null)" || die "run import-validate first"
    # D-5: the apply is refused for a different list than the validated one
    id="$(import_args apply "$FIX/reject-all.csv" "$sha" | submit import_members)" || { bad "import-apply: the wrong-list apply was not queued"; return; }
    st="$(run_request "$id")" || true
    [[ "$st" == failed ]] && ok "import-apply: an apply naming another list's sha256 fails before any write" || bad "import-apply: the wrong-list apply is ${st:-unknown}"
    pre="$(dump_events)"
    id="$(import_args apply "$FIX/members.csv" "$sha" | submit import_members)" || { bad "import-apply: not queued"; return; }
    st="$(run_request "$id")" || true
    events "$id" | ledger "apply-${id}.events"
    [[ "$st" == succeeded ]] && ok "import-apply: request ${id} succeeded" || { bad "import-apply: request is ${st:-unknown}"; return; }
    rows="$(( $(wc -l < "$FIX/members.csv") - 1 ))"
    [[ "$(( $(k "SELECT count(*) FROM org_unit_members") - $(cat "$OUT/members-before") ))" == "$rows" ]] \
        && ok "import-apply: ${rows} memberships created" || bad "import-apply: membership delta is not ${rows}"
    [[ "$(realm_users)" == "$rows" ]] && ok "import-apply: ${rows} realm accounts, one per distinct address" || bad "import-apply: realm accounts differ from ${rows}"
    local actions
    actions="$(skc get users -r "$SLUG" -q "email=ada.alpha@import-proof.test" --fields requiredActions | jq -c '.[0].requiredActions | sort')"
    [[ "$actions" == '["UPDATE_PASSWORD"]' ]] && ok "import-apply (D-5): an imported member carries UPDATE_PASSWORD only" || bad "import-apply (D-5): required actions are ${actions}"
    events "$id" | grep -q 'import rerun: status=applied created=0 .*accounts_created=0 invites_sent=0' \
        && ok "import-apply: the in-job rerun created nothing and mailed nobody" || bad "import-apply: the rerun line is missing or not a no-op"
    [[ "$(dump_events)" == "${pre}created deleted " ]] && ok "import-apply: the dump ledger gained exactly one created and one deleted line" || bad "import-apply: dump ledger is '$(dump_events)'"
    [[ "$(q gremion_platform "SELECT args->>'purged' FROM plt.provisioning_request WHERE request_id = '${id}'")" == true \
        && "$(q gremion_platform "SELECT args ? 'csv' FROM plt.provisioning_request WHERE request_id = '${id}'")" == f ]] \
        && ok "import-apply: the member list is purged from the request row" || bad "import-apply: the request row still carries the list"
    events "$id" | grep -q '@import-proof.test' && bad "import-apply: an e-mail address reached the event stream" || ok "import-apply: no e-mail address in the event stream"
    k "SELECT count(*) FROM org_unit_members" > "$OUT/members-after"
    realm_users > "$OUT/users-after"
    echo "$id" > "$OUT/apply.id"
}

phase_import_rerun() {
    need_pooled
    local sha id st pre
    sha="$(cat "$OUT/sha256" 2>/dev/null)" || die "run import-validate and import-apply first"
    pre="$(dump_events)"
    id="$(import_args apply "$FIX/members.csv" "$sha" | submit import_members)" || { bad "import-rerun: not queued"; return; }
    st="$(run_request "$id")" || true
    events "$id" | ledger "rerun-${id}.events"
    [[ "$st" == succeeded ]] && ok "import-rerun: the same apply again succeeded" || { bad "import-rerun: request is ${st:-unknown}"; return; }
    [[ "$(k "SELECT count(*) FROM org_unit_members")" == "$(cat "$OUT/members-after")" ]] && ok "import-rerun: 0 memberships created" || bad "import-rerun: memberships changed"
    [[ "$(realm_users)" == "$(cat "$OUT/users-after")" ]] && ok "import-rerun: 0 realm accounts created" || bad "import-rerun: realm accounts changed"
    events "$id" | grep -q 'import apply: status=applied created=0 .*accounts_created=0 invites_sent=0' \
        && ok "import-rerun: the first apply of the rerun already reports 0 created, 0 mails" || bad "import-rerun: the apply line is not a no-op"
    [[ "$(dump_events)" == "${pre}created deleted " ]] && ok "import-rerun: one more created + deleted dump pair, none left live" || bad "import-rerun: dump ledger is '$(dump_events)'"
}

run_phase() {
    case "$1" in
        import-stage) phase_import_stage ;;
        import-seed) phase_import_seed ;;
        import-reject) phase_import_reject ;;
        import-validate) phase_import_validate ;;
        import-apply) phase_import_apply ;;
        import-rerun) phase_import_rerun ;;
        import-unstage) phase_import_unstage ;;
        *) die "unknown phase '$1'" ;;
    esac
}

[[ $# -gt 0 ]] || die "usage: member-import-proof.sh <phase>... (see the header)"
mkdir -p "$OUT"
for ph in "$@"; do run_phase "$ph"; done
printf '%s phases [%s] checks=%s RED=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" "$CHECKS" "$RED" | ledger run.log
(( CHECKS > 0 )) || { echo "[import-proof] RED: zero checks ran" >&2; exit 1; }
if (( RED )); then echo "[import-proof] RED: ${CHECKS} checks ran, at least one failed" >&2; exit 1; fi
echo "[import-proof] ${CHECKS} passing (minimum ${MIN_CHECKS} across the full phase set)"
