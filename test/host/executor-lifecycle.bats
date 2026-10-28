#!/usr/bin/env bats
# Tests for the TRD-044 executor handlers (infra/host/lib/executor/handlers/
# suspend.sh and resume.sh): the request kinds `suspend` and `resume`, and the
# customer_suspend / customer_resume library functions they call. Unit only:
# the tenant-create one-shot (tc), the mail front (mail_realm_smtp) and the
# TRD-440 fingerprint are stubs that record what the handler TRIED to do, in
# order. The live half is the control panel's lifecycle proof.
# Run: bats test/host/executor-lifecycle.bats

load 'test_helper/host'

REQ='0192f0c4-aaaa-7000-8000-00000000000c'
OPERATOR='8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'

setup() {
    setup_host_root
    WORK="${GREMION_ROOT}/work"
    mkdir -p "$WORK"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER GREMION_ROOT
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    printf 'tenant-alpha-rat router\n' > "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml"
    echo 'fp-A' > "${GREMION_ROOT}/fingerprint"
    cat > "${GREMION_ROOT}/stubs.sh" <<'STUB'
ROOT="$GREMION_ROOT"
active_colour() { COLOUR=blue; }
container_fingerprint() { printf 'fingerprint %s\n' "$(cat "${GREMION_ROOT}/fingerprint")" >> "$ORDER"; cat "${GREMION_ROOT}/fingerprint"; }
mail_realm_smtp() { printf 'mail %s\n' "$*" >> "$ORDER"; [ ! -f "${GREMION_ROOT}/mail-fails" ]; }
mail_sender_args() { MAIL_SENDER_ARGS=(); }
tc() {
    printf 'tc %s\n' "$*" >> "$ORDER"
    [ ! -f "${GREMION_ROOT}/fail-$1" ] || return 1
    # a drifting container set after the verb, when the test says so
    [ ! -f "${GREMION_ROOT}/drift-$1" ] || echo 'fp-B' > "${GREMION_ROOT}/fingerprint"
    return 0
}
STUB
    SRC="${HOST_SRC}/lib"
    args_ok
}

teardown() {
    teardown_host_root
}

args_ok() { jq -nc '{slug:"alpha-rat"}' > "${WORK}/args.json"; }

# drive <handler function> [slug] — the handler the way the executor runs it:
# a sourced library, strict mode, a subshell, with tc/mail/fingerprint stubbed.
drive() {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"
        . "$1/executor/handlers/suspend.sh"; . "$1/executor/handlers/resume.sh"
        . "$2/stubs.sh"
        ( set -e; "$3" "$4" "$6" "$7" "$5/args.json" "$5" ) 2>&1
    ' _ "$SRC" "$GREMION_ROOT" "$1" "$REQ" "$WORK" "${2:-alpha-rat}" "$OPERATOR"
}
order() { cat "$ORDER"; }
router_sum() { sha256sum "${GREMION_ROOT}/etc/edge/tenant-alpha-rat.yml" | cut -d' ' -f1; }

# ---------------------------------------------------------------------------

@test "both kinds are registered, and the handler files are strict-mode-free libraries" {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"; . "$1/executor/registry.sh"
        [ "$(handler_for suspend)" = handle_suspend ]
        [ "$(handler_for resume)" = handle_resume ]
    ' _ "$SRC"
    [ "$status" -eq 0 ]
    assert_absent '^set -e' "${SRC}/executor/handlers/suspend.sh" 'strict mode in a sourced handler'
    assert_absent '^set -e' "${SRC}/executor/handlers/resume.sh" 'strict mode in a sourced handler'
}

@test "suspend: the container first, then the principal revoked; the fingerprint is taken around both" {
    drive handle_suspend
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "fingerprint fp-A" ]
    [ "${lines[1]}" = "tc suspend alpha-rat --operator ${OPERATOR}" ]
    [ "${lines[2]}" = "mail --realm alpha-rat --tenant alpha_rat --revoke" ]
    [ "${lines[3]}" = "fingerprint fp-A" ]
    [ "${#lines[@]}" -eq 4 ]
}

@test "suspend: no data verb and no router rewrite - the router file is byte-identical, no render-router runs" {
    local before; before="$(router_sum)"
    drive handle_suspend
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(router_sum)" = "$before" ]
    assert_absent 'render-router|phase-|seed|import|dump|restore' "$ORDER" 'suspend must only flip the status, realm, broker users and principal'
}

@test "suspend: a failing container verb stops before the principal is touched" {
    touch "${GREMION_ROOT}/fail-suspend"
    drive handle_suspend
    [ "$status" -ne 0 ]
    [[ "$output" == *"suspend of alpha-rat failed in the container"* ]]
    assert_absent '^mail ' "$ORDER" 'the principal was revoked after a failed container step'
}

@test "suspend: a failed revoke fails the request and names the converging rerun" {
    touch "${GREMION_ROOT}/mail-fails"
    drive handle_suspend
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not be revoked"* && "$output" == *"rerun"* ]]
    [ ! -f "${GREMION_ROOT}/runtime/suspended/alpha-rat.fingerprint" ]
}

@test "suspend: a container set that moved fails the request (TRD-440)" {
    touch "${GREMION_ROOT}/drift-suspend"
    drive handle_suspend
    [ "$status" -ne 0 ]
    [[ "$output" == *"TRD-440"* ]]
}

@test "suspend: args naming another customer, or no args, are refused before anything runs" {
    jq -nc '{slug:"other-rat"}' > "${WORK}/args.json"
    drive handle_suspend
    [ "$status" -ne 0 ]
    [[ "$output" == *"another customer"* ]]
    [ ! -s "$ORDER" ]
    rm "${WORK}/args.json"
    drive handle_suspend
    [ "$status" -ne 0 ]
    [[ "$output" == *"no verified args"* ]]
    [ ! -s "$ORDER" ]
}

@test "resume: a fresh principal first (never --rotate), then the container, fingerprint around both" {
    drive handle_resume
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "fingerprint fp-A" ]
    [ "${lines[1]}" = "mail --realm alpha-rat --tenant alpha_rat" ]
    [ "${lines[2]}" = "tc resume alpha-rat --operator ${OPERATOR}" ]
    [ "${lines[3]}" = "fingerprint fp-A" ]
    assert_absent 'rotate' "$ORDER" 'a resume never rotates'
}

@test "resume: a failing principal issue stops before the container verb" {
    touch "${GREMION_ROOT}/mail-fails"
    drive handle_resume
    [ "$status" -ne 0 ]
    [[ "$output" == *"fresh principal"* ]]
    assert_absent '^tc ' "$ORDER" 'the container resumed without a principal'
}

@test "resume: the router file stays byte-identical" {
    local before; before="$(router_sum)"
    drive handle_resume
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(router_sum)" = "$before" ]
    assert_absent 'render-router' "$ORDER" 'resume must not re-render the router'
}

@test "suspend then resume: the data fingerprint is equal before the suspend and after the resume; the record is cleaned up" {
    drive handle_suspend
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(head -n 1 "${GREMION_ROOT}/runtime/suspended/alpha-rat.fingerprint")" = "fp-A" ]
    drive handle_resume
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"equal to before the suspend"* ]]
    [ ! -f "${GREMION_ROOT}/runtime/suspended/alpha-rat.fingerprint" ]
}

@test "resume: a fingerprint that differs from the one before the suspend fails, and keeps the record" {
    drive handle_suspend
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    echo 'fp-B' > "${GREMION_ROOT}/fingerprint"   # the stack changed between the two requests
    drive handle_resume
    [ "$status" -ne 0 ]
    [[ "$output" == *"TRD-440"* && "$output" == *"before the suspend: fp-A"* ]]
    [ -f "${GREMION_ROOT}/runtime/suspended/alpha-rat.fingerprint" ]
}

@test "resume: a container set that moved during the resume fails the request (TRD-440)" {
    touch "${GREMION_ROOT}/drift-resume"
    drive handle_resume
    [ "$status" -ne 0 ]
    [[ "$output" == *"TRD-440"* ]]
}

@test "a suspend rerun keeps the FIRST fingerprint (a converging rerun never overwrites it)" {
    drive handle_suspend
    [ "$status" -eq 0 ]
    echo 'fp-C' > "${GREMION_ROOT}/fingerprint"
    drive handle_suspend
    [ "$status" -eq 0 ]
    [ "$(head -n 1 "${GREMION_ROOT}/runtime/suspended/alpha-rat.fingerprint")" = "fp-A" ]
}
