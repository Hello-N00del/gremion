#!/usr/bin/env bats
# Tests for the TRD-044 module and reconcile handlers (infra/host/lib/executor/
# handlers/enable_module.sh, disable_module.sh, record_dpia.sh, reconcile.sh) and
# the customer_* library functions they call. Unit only: the tenant-create
# one-shot (tc), the mail front and the TRD-440 fingerprint are stubs that
# record what the handler TRIED to do, in order.
# Run: bats test/host/executor-modules.bats

load 'test_helper/host'

REQ='0192f0c4-aaaa-7000-8000-00000000000d'
OPERATOR='8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'

setup() {
    setup_host_root
    WORK="${GREMION_ROOT}/work"
    mkdir -p "$WORK"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER GREMION_ROOT
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    echo 'fp-A' > "${GREMION_ROOT}/fingerprint"
    cat > "${GREMION_ROOT}/stubs.sh" <<'STUB'
ROOT="$GREMION_ROOT"
active_colour() { COLOUR=blue; }
container_fingerprint() { cat "${GREMION_ROOT}/fingerprint"; }
mail_realm_smtp() { printf 'mail %s\n' "$*" >> "$ORDER"; [ ! -f "${GREMION_ROOT}/mail-fails" ]; }
mail_sender_args() { MAIL_SENDER_ARGS=(); }
tc() {
    printf 'tc %s\n' "$*" >> "$ORDER"
    # keep what a --dpia-json file said at the moment of the call (the workdir is removed after the run)
    local prev="" a
    for a in "$@"; do
        # the argv carries the CONTAINER path; the file is what the mount names (-v <host>:/run/gremion/dpia.json:ro)
        [ "$prev" != "--dpia-json" ] || cp "${TC_MOUNT[1]%:/run/gremion/dpia.json:ro}" "${GREMION_ROOT}/dpia-seen.json"
        prev="$a"
    done
    if [ "$1" = reconcile ]; then
        if [ "${2:-}" = "--verify-only" ]; then
            echo '[tenant-create] reconcile realm "alpha-rat" - verify-only'
            [ ! -f "${GREMION_ROOT}/verify-crash" ] || { echo 'Error: cannot connect to the database'; return 3; }
            [ ! -f "${GREMION_ROOT}/drift" ] || { echo 'FAIL smtp-server: repair: host'; return 1; }
            [ ! -f "${GREMION_ROOT}/still-drift" ] || { echo 'FAIL smtp-server: repair: host'; return 1; }
            return 0
        fi
        [ ! -f "${GREMION_ROOT}/reconcile-crash" ] || return 3
        if [ -f "${GREMION_ROOT}/drift" ]; then
            echo '{"ok":false,"repairHost":["smtp-server"]}'
            rm -f "${GREMION_ROOT}/drift"
            return 1
        fi
        echo '{"ok":true,"repairHost":[]}'
        return 0
    fi
    [ ! -f "${GREMION_ROOT}/fail-$1" ] || return 1
    [ ! -f "${GREMION_ROOT}/drift-$1" ] || echo 'fp-B' > "${GREMION_ROOT}/fingerprint"
    return 0
}
STUB
    SRC="${HOST_SRC}/lib"
}

teardown() {
    teardown_host_root
}

# drive <handler function> [slug] — the handler the way the executor runs it.
drive() {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"
        for h in enable_module disable_module record_dpia reconcile; do . "$1/executor/handlers/${h}.sh"; done
        . "$2/stubs.sh"
        ( set -e; "$3" "$4" "$6" "$7" "$5/args.json" "$5" ) 2>&1
    ' _ "$SRC" "$GREMION_ROOT" "$1" "$REQ" "$WORK" "${2:-alpha-rat}" "$OPERATOR"
}
order() { cat "$ORDER"; }

enable_args() { jq -nc '{slug:"alpha-rat", module:"votes", dpia:{requiresDpia:"no", reasonCodes:["operator_decision"], documentRef:"TOM-3"}}' > "${WORK}/args.json"; }

# ---------------------------------------------------------------------------

@test "the four kinds are registered, and the handler files are strict-mode-free libraries" {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"; . "$1/executor/registry.sh"
        [ "$(handler_for enable_module)" = handle_enable_module ]
        [ "$(handler_for disable_module)" = handle_disable_module ]
        [ "$(handler_for record_dpia)" = handle_record_dpia ]
        [ "$(handler_for reconcile)" = handle_reconcile ]
    ' _ "$SRC"
    [ "$status" -eq 0 ]
    for h in enable_module disable_module record_dpia reconcile; do
        assert_absent '^set -e' "${SRC}/executor/handlers/${h}.sh" 'strict mode in a sourced handler'
    done
}

@test "enable_module: the container verb with the DPIA decision as a 0600 file" {
    enable_args
    drive handle_enable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "tc enable-module alpha-rat votes --operator ${OPERATOR} --dpia-json /run/gremion/dpia.json" ]
    [ "${#lines[@]}" -eq 1 ]
    [ "$(jq -c . "${GREMION_ROOT}/dpia-seen.json")" = '{"requiresDpia":"no","reasonCodes":["operator_decision"],"documentRef":"TOM-3"}' ]
    [ "$(stat -c %a "${WORK}/dpia.json")" = 600 ]
}

# drive_real_tc <handler> -- like drive, but through the REAL tc() and the docker
# shim (test/host/fixtures/executor/docker-shim): what the handler hands to
# `docker compose run tenant-create` (argv and mounts) is what is asserted.
drive_real_tc() {
    printf 'STACK=guardstack
COLOUR=blue
' > "${GREMION_ROOT}/etc/env/app-blue.env"
    shim docker "exec bash '${HOST_TEST_DIR}/fixtures/executor/docker-shim' \"\$@\""
    mkdir -p "${GREMION_ROOT}/current"
    run bash -c '
        set -euo pipefail
        export GREMION_RELEASE_DIR="$2/current"
        . "$1/common.sh"; . "$1/customer-ops.sh"
        for h in enable_module; do . "$1/executor/handlers/${h}.sh"; done
        setup_paths
        active_colour() { COLOUR=blue; }
        container_fingerprint() { cat "${GREMION_ROOT}/fingerprint"; }
        ( set -e; "$3" "$4" "$6" "$7" "$5/args.json" "$5" ) 2>&1
    ' _ "$SRC" "$GREMION_ROOT" "$1" "$REQ" "$WORK" "${2:-alpha-rat}" "$OPERATOR"
}

@test "enable_module: through the real tc() the DPIA file is MOUNTED and the container-side path is in argv (not the host path)" {
    enable_args
    drive_real_tc handle_enable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_present 'tenant-create enable-module alpha-rat votes --operator '"${OPERATOR}"' --dpia-json /run/gremion/dpia\.json' "${GREMION_ROOT}/tc-argv.log"
    assert_absent "--dpia-json ${WORK}" "${GREMION_ROOT}/tc-argv.log" 'the host path must not reach the container'
    # the shim saw a -v <host>:/run/gremion/dpia.json:ro and read the decision through it
    [ "$(sed -n 2p "${GREMION_ROOT}/dpia-seen" | jq -c .)" = '{"requiresDpia":"no","reasonCodes":["operator_decision"],"documentRef":"TOM-3"}' ]
}

@test "enable_module without a decision mounts nothing for it" {
    jq -nc '{slug:"alpha-rat", module:"votes", dpia:null}' > "${WORK}/args.json"
    drive_real_tc handle_enable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    assert_absent 'dpia' "${GREMION_ROOT}/tc-argv.log" 'no decision was carried'
}

@test "enable_module without a carried decision passes no --dpia-json (the recorded one is used by the gate)" {
    jq -nc '{slug:"alpha-rat", module:"votes", dpia:null}' > "${WORK}/args.json"
    drive handle_enable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "tc enable-module alpha-rat votes --operator ${OPERATOR}" ]
    assert_absent 'dpia-json' "$ORDER" 'no decision was carried'
}

@test "enable_module: a refusal of the container verb fails the request; a container set that moved fails it (TRD-440)" {
    enable_args
    touch "${GREMION_ROOT}/fail-enable-module"
    drive handle_enable_module
    [ "$status" -ne 0 ]
    [[ "$output" == *"enable of votes for alpha-rat failed in the container"* ]]
    rm "${GREMION_ROOT}/fail-enable-module"
    touch "${GREMION_ROOT}/drift-enable-module"
    drive handle_enable_module
    [ "$status" -ne 0 ]
    [[ "$output" == *"TRD-440"* ]]
}

@test "enable_module is idempotent: a rerun runs the same verb and succeeds" {
    enable_args
    drive handle_enable_module
    [ "$status" -eq 0 ]
    drive handle_enable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(grep -c '^tc enable-module' "$ORDER")" -eq 2 ]
}

@test "disable_module: only the container verb, fingerprint around it; no router or mail step" {
    jq -nc '{slug:"alpha-rat", module:"votes"}' > "${WORK}/args.json"
    drive handle_disable_module
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "tc disable-module alpha-rat votes --operator ${OPERATOR}" ]
    [ "${#lines[@]}" -eq 1 ]
    assert_absent 'render-router|mail|suspend' "$ORDER" 'disable touches the module only'
}

@test "disable_module: a failing verb (no export volume, export failed) fails the request; drift fails it (TRD-440)" {
    jq -nc '{slug:"alpha-rat", module:"votes"}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/fail-disable-module"
    drive handle_disable_module
    [ "$status" -ne 0 ]
    [[ "$output" == *"disable of votes for alpha-rat failed in the container"* ]]
    rm "${GREMION_ROOT}/fail-disable-module"
    touch "${GREMION_ROOT}/drift-disable-module"
    drive handle_disable_module
    [ "$status" -ne 0 ]
    [[ "$output" == *"TRD-440"* ]]
}

@test "record_dpia: the decision as dpia-record flags (reuse-identical in the verb)" {
    jq -nc '{slug:"alpha-rat", module:"votes", requiresDpia:"yes", reasonCodes:["operator_decision"], documentRef:"TOM-9 / DSFA 2026-03"}' > "${WORK}/args.json"
    drive handle_record_dpia
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "tc dpia-record alpha-rat votes --operator ${OPERATOR} --requires-dpia yes --reason-codes operator_decision --document-ref TOM-9 / DSFA 2026-03" ]
    [ "${#lines[@]}" -eq 1 ]
}

@test "record_dpia: a failing verb fails the request" {
    jq -nc '{slug:"alpha-rat", module:"votes", requiresDpia:"no", reasonCodes:["operator_decision"], documentRef:"TOM-9"}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/fail-dpia-record"
    drive handle_record_dpia
    [ "$status" -ne 0 ]
    [[ "$output" == *"DPIA decision for votes of alpha-rat could not be recorded"* ]]
}

@test "reconcile dry-run: verify-only only; green passes with the report in the output" {
    jq -nc '{slug:"alpha-rat", apply:false}' > "${WORK}/args.json"
    drive handle_reconcile
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"verify-only"* && "$output" == *"in sync"* ]]
    run order
    [ "${lines[0]}" = "tc reconcile --verify-only alpha-rat" ]
    [ "${#lines[@]}" -eq 1 ]
    assert_absent '^mail ' "$ORDER" 'a dry run rotates nothing'
}

@test "reconcile dry-run: drift fails the request, the report is in the events, nothing is repaired" {
    jq -nc '{slug:"alpha-rat", apply:false}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/drift"
    drive handle_reconcile
    [ "$status" -ne 0 ]
    [[ "$output" == *"FAIL smtp-server: repair: host"* && "$output" == *"drift"* ]]
    assert_absent 'reconcile alpha-rat$|rotate' "$ORDER" 'a dry run must not apply'
}

@test "reconcile dry-run: a crash of the verify (exit 3, not 1) is a failure of the verify, never reported as drift" {
    jq -nc '{slug:"alpha-rat", apply:false}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/verify-crash"
    drive handle_reconcile
    [ "$status" -ne 0 ]
    [[ "$output" == *"verify-only failed in the container (exit 3)"* ]] || { echo "$output"; return 1; }
    [[ "$output" != *"drift found"* ]] || { echo "$output"; return 1; }
}

@test "reconcile apply: the repair, the host principal rotated when smtp-server is repair: host, then a verify-only that must be green" {
    jq -nc '{slug:"alpha-rat", apply:true}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/drift"
    drive handle_reconcile
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run order
    [ "${lines[0]}" = "tc reconcile alpha-rat" ]
    [ "${lines[1]}" = "mail --realm alpha-rat --tenant alpha_rat --rotate" ]
    [ "${lines[2]}" = "tc reconcile --verify-only alpha-rat" ]
    [ "${#lines[@]}" -eq 3 ]
}

@test "reconcile apply on a green realm: no rotation; a second apply is the same and succeeds (idempotent)" {
    jq -nc '{slug:"alpha-rat", apply:true}' > "${WORK}/args.json"
    drive handle_reconcile
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    drive handle_reconcile
    [ "$status" -eq 0 ]
    assert_absent '^mail ' "$ORDER" 'no drift, no rotation'
}

@test "reconcile apply: a crash fails the request without rotating; a verify that stays red fails it" {
    jq -nc '{slug:"alpha-rat", apply:true}' > "${WORK}/args.json"
    touch "${GREMION_ROOT}/reconcile-crash"
    drive handle_reconcile
    [ "$status" -ne 0 ]
    [[ "$output" == *"failed in the container"* ]]
    assert_absent '^mail ' "$ORDER" 'nothing was rotated after a crash'
    rm "${GREMION_ROOT}/reconcile-crash"
    touch "${GREMION_ROOT}/still-drift"
    drive handle_reconcile
    [ "$status" -ne 0 ]
}

@test "every handler refuses args naming another customer or no args, before anything runs" {
    local h
    for h in enable_module disable_module record_dpia reconcile; do
        : > "$ORDER"
        jq -nc '{slug:"other-rat", module:"votes", apply:true}' > "${WORK}/args.json"
        drive "handle_${h}"
        [ "$status" -ne 0 ] || { echo "$h: $output"; return 1; }
        [[ "$output" == *"another customer"* ]] || { echo "$h: $output"; return 1; }
        [ ! -s "$ORDER" ]
        rm "${WORK}/args.json"
        drive "handle_${h}"
        [ "$status" -ne 0 ]
        [[ "$output" == *"no verified args"* ]]
        [ ! -s "$ORDER" ]
    done
}

@test "gremion-tenant reconcile delegates to the library function (one copy of the logic)" {
    # cmd_reconcile only records the access (TRD-092) and then hands over.
    assert_present '^    customer_reconcile "\$slug" ' "${HOST_SRC}/bin/gremion-tenant" 'gremion-tenant delegates reconcile to customer-ops.sh'
    assert_absent 'repairHost' "${HOST_SRC}/bin/gremion-tenant" 'the reconcile body moved to customer-ops.sh'
}
