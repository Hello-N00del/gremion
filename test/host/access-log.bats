#!/usr/bin/env bats
# Tests for infra/host/lib/access-log.sh (TRD-092 / TRD-191 / PRD-OPS-006): the
# host helper that records vendor/operator access to a council's data in
# gremion_platform's oac.access_record, and its call sites in
# infra/host/bin/gremion-tenant (break-glass request, suspend, resume,
# reconcile --apply). Unit only: docker is test/host/fixtures/executor/docker-shim
# (oac.record_access behind `docker exec ... psql`, recorded in access.log and
# order.log). Run: bats test/host/access-log.bats

load 'test_helper/host'

OP='8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
FIX="${HOST_TEST_DIR}/fixtures/executor"

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    LIB="${REL}/infra/host/lib"
    mkdir -p "${REL}/infra/host/bin" "${LIB}/executor" "${REL}/docker/keycloak"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${HOST_SRC}/lib/access-log.sh" "${LIB}/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${LIB}/executor/"
    cp "${HOST_SRC}/bin/gremion-tenant" "${HOST_SRC}/bin/gremion-mail" "${REL}/infra/host/bin/"
    cp "${KERNEL_ROOT}/docker/keycloak/realm-export.ops.json" "${REL}/docker/keycloak/"
    printf '#!/usr/bin/env bash\nprintf "vendor-mail %%s\\n" "$*" >> "$ORDER"\nexit 0\n' > "${REL}/infra/host/bin/gremion-vendor-mail"
    chmod +x "${REL}/infra/host/bin/gremion-vendor-mail"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    printf 'STACK=guardstack\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=unit-pg-root-secret\nKEYCLOAK_ADMIN_PASSWORD=unit-kc\nTRAEFIK_CERT_RESOLVER=le-http\nEDGE_BIND_IP=192.0.2.10\nEDGE_BIND_IP6=2001:db8::a\n' > "${GREMION_ROOT}/etc/env/state.env"
    printf 'STACK=guardstack\nCOLOUR=blue\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    printf '{"brand":{"product":"Rat","org_short":"MS"}}\n' > "${GREMION_ROOT}/tenant-config.json"
    shim docker "exec bash '${FIX}/docker-shim' \"\$@\""
    export GREMION_EXECUTOR_PG_CONTAINER=t092-pg-fixture MAIL_TRANSPORT=stalwart SUDO_USER=deploy
    unset EXECUTOR_PG_CONTAINER
}

teardown() {
    teardown_host_root
}

# call <access_record args...> -- the helper, sourced the way gremion-tenant sources it
call() {
    run bash -c 'set -euo pipefail; . "$1/common.sh"; . "$1/customer-ops.sh"; . "$1/executor/db.sh"; . "$1/access-log.sh"; shift; setup_paths; "$@"' _ "$LIB" "$@"
}

@test "access_record writes who/what/why for the customer as the executor role and prints the record id" {
    call access_record alpha-rat break_glass_request "Anfrage create in die Warteschlange" "Panel nicht erreichbar, Mandant anlegen"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$output" = "0192f0c4-0000-7000-8000-0000000000ac" ]
    [ "$(cat "${GREMION_ROOT}/access.log")" = "alpha-rat|break_glass_request|deploy|Anfrage create in die Warteschlange|Panel nicht erreichbar, Mandant anlegen" ]
    [ "$(sort -u "${GREMION_ROOT}/psql-roles.log")" = "gremion_executor" ]
}

@test "the actor is the invoking login user, lowercased; a non-user name is refused before docker is called" {
    SUDO_USER=Deploy call access_record alpha-rat break_glass_request "Anfrage create" "Panel nicht erreichbar"
    [ "$status" -eq 0 ]
    grep -q '|deploy|' "${GREMION_ROOT}/access.log"
    : > "${GREMION_ROOT}/exec-argv.log" 2>/dev/null || true
    SUDO_USER='Root User' call access_record alpha-rat break_glass_request "Anfrage create" "Panel nicht erreichbar"
    [ "$status" -ne 0 ]
    [[ "$output" == *"plain user name"* ]]
    [ "$(wc -l < "${GREMION_ROOT}/access.log")" -eq 1 ]
}

@test "input the database would refuse never reaches it: bad slug, bad action, short why, empty what" {
    for args in "x break_glass_request WHAT-OK WHY-IS-LONG-ENOUGH" "alpha-rat Bad-Action WHAT-OK WHY-IS-LONG-ENOUGH" "alpha-rat break_glass_request WHAT-OK short" "alpha-rat break_glass_request '' WHY-IS-LONG-ENOUGH"; do
        eval "call access_record $args"
        [ "$status" -ne 0 ] || { echo "accepted: $args"; return 1; }
    done
    [ ! -s "${GREMION_ROOT}/access.log" ]
}

@test "a database refusal is a non-zero exit, and access_record_or_die dies with the fail-closed message" {
    : > "${GREMION_ROOT}/access-refused"
    call access_record alpha-rat suspend "Mandant sperren" "Anforderung der Gremienverwaltung"
    [ "$status" -ne 0 ]
    call access_record_or_die alpha-rat suspend "Mandant sperren" "Anforderung der Gremienverwaltung"
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not be recorded"* ]]
    [[ "$output" == *"nothing was done"* ]]
}

@test "the executor call site is left as a documented TODO for the executor lane (gremion-executor is not edited here)" {
    grep -q 'TODO(executor lane)' "${HOST_SRC}/lib/access-log.sh"
    ! grep -q 'access_record' "${HOST_SRC}/bin/gremion-executor"
}

# ---------------------------------------------------------------------------
# call sites

gt() { run "${REL}/infra/host/bin/gremion-tenant" "$@"; }

@test "break-glass request: the access is recorded BEFORE the request is queued, with the operator's reason" {
    echo '{"slug":"alpha-rat","host":"rat.alpha.example"}' > "${GREMION_ROOT}/args.json"
    chmod 600 "${GREMION_ROOT}/args.json"
    gt request create --operator "$OP" --args-file "${GREMION_ROOT}/args.json" --reason "panel down for the second night"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(grep -n 'psql access\|psql submit' "$ORDER" | cut -d: -f2 | cut -d' ' -f2)" = "$(printf 'access\nsubmit')" ]
    grep -q '^alpha-rat|break_glass_request|deploy|.*create.*|panel down for the second night$' "${GREMION_ROOT}/access.log"
}

@test "break-glass request: when the record cannot be written, nothing is queued (fail closed)" {
    echo '{"slug":"alpha-rat","host":"rat.alpha.example"}' > "${GREMION_ROOT}/args.json"
    chmod 600 "${GREMION_ROOT}/args.json"
    : > "${GREMION_ROOT}/access-refused"
    gt request create --operator "$OP" --args-file "${GREMION_ROOT}/args.json" --reason "panel down for the second night"
    [ "$status" -ne 0 ]
    ! grep -q 'psql submit' "$ORDER"
}

@test "suspend and resume record the access (default why, or --reason) before the container acts; a refused record stops them" {
    gt suspend alpha-rat --operator "$OP" --reason "Anforderung der Gremienverwaltung vom Montag"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    grep -q '^alpha-rat|host_suspend|deploy|.*|Anforderung der Gremienverwaltung vom Montag$' "${GREMION_ROOT}/access.log"
    [ "$(grep -n 'psql access\|^tc suspend' "$ORDER" | head -1 | cut -d: -f2 | cut -d' ' -f1)" = "psql" ]
    : > "$ORDER"
    gt resume alpha-rat --operator "$OP"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    grep -q '^alpha-rat|host_resume|deploy|' "${GREMION_ROOT}/access.log"
    : > "${GREMION_ROOT}/access-refused"
    : > "$ORDER"
    gt suspend alpha-rat --operator "$OP"
    [ "$status" -ne 0 ]
    ! grep -q '^tc suspend' "$ORDER"
}

@test "reconcile --apply records the access; plain reconcile (verify only) does not" {
    gt reconcile alpha-rat
    [ ! -s "${GREMION_ROOT}/access.log" ]
    gt reconcile alpha-rat --apply
    grep -q '^alpha-rat|host_reconcile|deploy|' "${GREMION_ROOT}/access.log"
}
