#!/usr/bin/env bats
# Static guards on test/host/integration/customer-provision-proof.sh (#50): the
# proof drifted from the verbs and directories it drives, and only a live Linux
# run noticed. Each guard reads the script, so it runs on every host.

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    PROOF="$REPO_ROOT/test/host/integration/customer-provision-proof.sh"
}

@test "every 'tenant reconcile ... --apply' in the proof passes --reason (gremion-tenant refuses an unaudited apply)" {
    run grep -nE 'tenant reconcile [^|;]*--apply' "$PROOF"
    [ "$status" -eq 0 ]
    local re='--reason "[^"]{10,}"'
    while IFS= read -r line; do
        [[ "$line" =~ $re ]] || { echo "no --reason: $line"; return 1; }
    done <<< "$output"
    # the verb really requires it (if this stops matching, re-check the guard above)
    grep -q 'reconcile --apply needs --reason' "$REPO_ROOT/infra/host/bin/gremion-tenant"
}

@test "the tenant-secret ownership check reads the app env's TENANT_SECRETS_DIR and skips .gitkeep" {
    grep -qF "s/^TENANT_SECRETS_DIR=//p' \"\$PENV/app-blue.env\"" "$PROOF"
    grep -q 'find "$tsd" -type f ! -name .gitkeep' "$PROOF"
    # pooled-stack-proof is what renders that variable into app-<colour>.env
    grep -q '^TENANT_SECRETS_DIR=\${SROOT_H}/secrets/tenants' "$REPO_ROOT/test/host/integration/pooled-stack-proof.sh"
    ! grep -q 'PROOF_TENANT_SECRETS_DIR:-$ROOT/secrets/tenants' "$PROOF"
}

@test "a fresh tenant's warm-up is waited for: create-check and the suspend baseline use edge_served_wait (#50)" {
    grep -q '^edge_served_wait() {' "$PROOF"
    grep -q 'if edge_served_wait "$(host_of "$X")"; then ok "customer-create:' "$PROOF"
    # the suspend phase proves Y is served BEFORE it suspends X, so "Y was affected" means affected by the suspend
    local body; body="$(sed -n '/^phase_customer_suspend() {/,/^}/p' "$PROOF")"
    local base sus
    base="$(grep -n 'edge_served_wait "$(host_of "$Y")"' <<< "$body" | head -1 | cut -d: -f1)"
    sus="$(grep -n 'tenant suspend "$X"' <<< "$body" | head -1 | cut -d: -f1)"
    [ -n "$base" ] && [ -n "$sus" ] && [ "$base" -lt "$sus" ]
}

@test "the proof's own node fixtures pass (panel-session sign-in incl. gremion-ui's disabled Auth.js CSRF, #50)" {
    command -v node >/dev/null || skip "node not on PATH"
    mkdir -p "$REPO_ROOT/.scratch"
    run node --test "$REPO_ROOT/test/host/fixtures/customer-provision/panel-session-signin.test.mjs" "$REPO_ROOT/test/host/fixtures/customer-provision/panel-session.test.mjs"
    [ "$status" -eq 0 ] || { printf '%s\n' "$output" | tail -30; return 1; }
    [[ "$output" =~ pass\ ([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -ge 18 ]
}

# ── #50 item 6 and the mid-run HEAD move: unit tests on the sourced proof ─────
# The proof is sourced with a fake docker/curl/git on PATH and its kcadm (skc)
# and psql (q) helpers replaced; nothing reaches an engine.
SHA_A=aaaaaaaa11111111111111111111111111111111
SHA_B=bbbbbbbb22222222222222222222222222222222
OP_ID=0b7c2e1a-3f4d-4a5b-8c6d-7e8f9a0b1c2d

cp_unit_setup() { # <head sha the fake git reports>
    local bin="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$bin" "${BATS_TEST_TMPDIR}/env" "${BATS_TEST_TMPDIR}/out"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/docker"; cp "$bin/docker" "$bin/curl"
    export FAKE_GIT_HEAD="${BATS_TEST_TMPDIR}/fake-head"
    printf '#!/usr/bin/env bash\nh="$(cat "$FAKE_GIT_HEAD")"; for a in "$@"; do [[ "$a" == --short=8 ]] && h="${h:0:8}"; done; echo "$h"\n' > "$bin/git"
    chmod +x "$bin/docker" "$bin/curl" "$bin/git"
    printf '%s\n' "$1" > "$FAKE_GIT_HEAD"
    export PATH="${bin}:${PATH}"
    export POOLED_STACK="t040-${SHA_A:0:8}" POOLED_ENV_DIR="${BATS_TEST_TMPDIR}/env" PROOF_OUT="${BATS_TEST_TMPDIR}/out"
    printf 'GREMION_ROOT=%s\nPLATFORM_DOMAIN=proof.example.org\nPROOF_HEAD_SHA=%s\n' "${BATS_TEST_TMPDIR}/root" "$SHA_A" > "${POOLED_ENV_DIR}/state.env"
    unset PROOF_STACK PROOF_OPERATOR_ID
}

# kcadm stand-in: logs every call; `get users -r platform -q email=...` lists
# the users in $SKC_USERS (a file of ids), `create users` adds $OP_ID to it,
# `get users/<id>` succeeds only for a listed id.
fake_skc='skc() {
    printf "%s\n" "$*" >> "$SKC_LOG"
    case "$1 $2" in
        "get realms/platform") echo "{\"realm\":\"platform\"}" ;;
        "get users")
            jq -Rn "[inputs | select(length > 0) | {id: .}]" < "$SKC_USERS" ;;
        "create users") echo "$OP_ID" >> "$SKC_USERS" ;;
        "add-roles -r") : ;;
        "get users/"*) [[ "${SKC_OUTAGE:-}" != 1 ]] || { echo "Failed to send request - Connect to 127.0.0.1:8080 failed: Connection refused" >&2; return 1; }; grep -qx "${2#users/}" "$SKC_USERS" || { echo "Resource not found for url" >&2; return 1; }; echo "{\"id\":\"${2#users/}\",\"enabled\":true}" ;;
        *) echo "fake skc: unhandled: $*" >&2; return 1 ;;
    esac
}
q() { case "$2" in *pg_database*) echo 1 ;; *module_version*) echo 3 ;; *) echo "fake q: $2" >&2; return 1 ;; esac; }'

run_cp() { # <bash code run after sourcing the proof and the fakes>
    export SKC_LOG="${BATS_TEST_TMPDIR}/skc.log" SKC_USERS="${BATS_TEST_TMPDIR}/skc-users" OP_ID
    touch "$SKC_USERS"
    run bash -c 'set -euo pipefail; . "$1"; eval "$2"; eval "$3"' _ "$PROOF" "$fake_skc" "$1"
}

@test "the customer STACK follows the pooled stack's recorded sha, not a moved HEAD (no renamed ledger)" {
    cp_unit_setup "$SHA_B"
    run_cp 'echo "STACK=$STACK"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"STACK=t043-${SHA_A:0:8}"* ]]
}

@test "need_pooled refuses after a HEAD move since the pooled prepare, naming both shas (ISOLATION_STALE_TIP otherwise)" {
    cp_unit_setup "$SHA_B"
    run_cp 'need_pooled no-operator; echo reached'
    [ "$status" -eq 2 ]
    [[ "$output" == *"FATAL: HEAD moved"*"${SHA_A:0:12}"*"${SHA_B:0:12}"* ]]
    [[ "$output" != *reached* ]]
}

@test "need_pooled at the pinned HEAD passes (positive control for the HEAD guard)" {
    cp_unit_setup "$SHA_A"
    run_cp 'need_pooled no-operator; echo reached'
    [ "$status" -eq 0 ]
    [[ "$output" == *reached* ]]
}

@test "need_pooled takes the operator customer-init recorded when PROOF_OPERATOR_ID is unset" {
    cp_unit_setup "$SHA_A"
    mkdir -p "${PROOF_OUT}/secrets"; echo "$OP_ID" > "${PROOF_OUT}/secrets/operator-id"
    run_cp 'need_pooled; echo "op=$PROOF_OPERATOR_ID"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"op=${OP_ID}"* ]]
}

@test "need_pooled with no operator at all is a FATAL that names customer-init" {
    cp_unit_setup "$SHA_A"
    run_cp 'need_pooled; echo reached'
    [ "$status" -eq 2 ]
    [[ "$output" == *"FATAL: "*"customer-init"* ]]
    [[ "$output" != *reached* ]]
}

@test "customer-init creates the proof operator in the CURRENT ops realm and records its id (#50 item 6)" {
    cp_unit_setup "$SHA_A"
    run_cp 'phase_customer_init'
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    [ "$(cat "${PROOF_OUT}/secrets/operator-id")" = "$OP_ID" ]
    grep -q '^create users -r platform ' "$SKC_LOG"
    grep -q "^add-roles -r platform --uid ${OP_ID} --rolename operator" "$SKC_LOG"
    [[ "$output" == *"ok   customer-init: "*"${OP_ID}"* ]]
}

@test "customer-init reuses an operator the realm already has (a rerun creates none)" {
    cp_unit_setup "$SHA_A"
    echo "$OP_ID" > "${BATS_TEST_TMPDIR}/skc-users"
    run_cp 'phase_customer_init'
    [ "$status" -eq 0 ]
    [ "$(cat "${PROOF_OUT}/secrets/operator-id")" = "$OP_ID" ]
    ! grep -q '^create users' "$SKC_LOG"
}

@test "customer-init refuses a PROOF_OPERATOR_ID that is not in the current ops realm (a stale id)" {
    cp_unit_setup "$SHA_A"
    export PROOF_OPERATOR_ID=11111111-2222-4333-8444-555555555555
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [[ "$output" == *"PROOF_OPERATOR_ID 11111111-2222-4333-8444-555555555555 does not exist in the current ops realm"* ]]
    [ "$status" -eq 0 ]
    [[ "$output" == *"RED=1"* ]]
    [ ! -e "${PROOF_OUT}/secrets/operator-id" ]
}

@test "customer-init: a kcadm outage while checking PROOF_OPERATOR_ID is reported as such, never as a stale id" {
    cp_unit_setup "$SHA_A"
    export PROOF_OPERATOR_ID="$OP_ID" SKC_OUTAGE=1
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"kcadm could not look PROOF_OPERATOR_ID ${OP_ID} up: Failed to send request"* ]]
    [[ "$output" == *"RED=1"* ]]
    [[ "$output" != *"does not exist in the current ops realm"* ]]
}

@test "customer-init on a host (PROOF_GREMION_ROOT) creates no user in the operators' realm: it needs PROOF_OPERATOR_ID" {
    cp_unit_setup "$SHA_A"
    export PROOF_GREMION_ROOT="${BATS_TEST_TMPDIR}/host-root"
    run_cp 'phase_customer_init; echo "RED=$RED"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"on a host set PROOF_OPERATOR_ID"* ]]
    [[ "$output" == *"RED=1"* ]]
    ! grep -q '^create users' "$SKC_LOG"
}

@test "customer-before needs no operator yet (it runs before customer-init creates one)" {
    local body; body="$(sed -n '/^phase_customer_before() {/,/^}/p' "$PROOF")"
    grep -q 'need_pooled no-operator' <<< "$body"
}
