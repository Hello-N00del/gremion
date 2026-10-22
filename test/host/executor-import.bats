#!/usr/bin/env bats
# Tests for the TASK-031 executor handlers (infra/host/lib/executor/handlers/
# import_members.sh and seed_vertical.sh): the request kinds `import_members`
# and `seed_vertical`. Unit only: the tenant-create one-shot (`tc`) and the
# sibling gremion-migration-dump are stubs that record what the handler TRIED
# to do, in order. The live half is test/host/integration/member-import-proof.sh.
# Run: bats test/host/executor-import.bats

load 'test_helper/host'

REQ='0192f0c4-aaaa-7000-8000-00000000000b'
SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
OTHER='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
DB='t_0192f0c4aaaa70008000000000000001__kernel'
SECRET_MAIL='erika.mustermann@example.org'

setup() {
    setup_host_root
    WORK="${GREMION_ROOT}/work"
    mkdir -p "$WORK" "${GREMION_ROOT}/stubbin"
    ORDER="${GREMION_ROOT}/order.log"
    : > "$ORDER"
    export ORDER GREMION_ROOT DB SHA
    cat > "${GREMION_ROOT}/stubbin/gremion-migration-dump" <<'STUB'
#!/usr/bin/env bash
printf 'dump %s\n' "$*" >> "$ORDER"
[ -f "${GREMION_ROOT}/dump-fails" ] && exit 1
exit 0
STUB
    chmod +x "${GREMION_ROOT}/stubbin/gremion-migration-dump"
    # tc <verb> ...: the list on STDIN; the answer of the Nth call of a verb is
    # ${GREMION_ROOT}/answer.<verb>.<N> (line 1 the exit code, the rest stdout).
    cat > "${GREMION_ROOT}/stubs.sh" <<'STUB'
tc() {
    local verb="$1" n f stdin_len
    n="$(cat "${GREMION_ROOT}/count.${verb}" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "${GREMION_ROOT}/count.${verb}"
    stdin_len="$(wc -c | tr -d ' ')"
    printf 'tc %s #%s stdin=%s argv=%s\n' "$verb" "$n" "$stdin_len" "$*" >> "$ORDER"
    f="${GREMION_ROOT}/answer.${verb}.${n}"
    [ -f "$f" ] || f="${GREMION_ROOT}/answer.${verb}"
    [ -f "$f" ] || return 99
    tail -n +2 "$f"
    return "$(head -n 1 "$f")"
}
STUB
    SRC="${HOST_SRC}/lib"
    args_validate
}

teardown() {
    teardown_host_root
}

# answer <verb> <N|""> <exit code> <json>
answer() {
    local f="${GREMION_ROOT}/answer.$1${2:+.$2}"
    printf '%s\n%s\n' "$3" "$4" > "$f"
}
counts() { # created accounts invites rejected
    printf '{"created":%s,"linked_existing":0,"unchanged":0,"rejected":%s,"accounts_created":%s,"invites_sent":%s}' "$1" "$4" "$2" "$3"
}
validated_json() { printf '{"status":"validated","sha256":"%s","counts":%s,"rows":[],"database":"%s"}' "${1:-$SHA}" "$(counts 0 0 0 0)" "$DB"; }
applied_json() { printf '{"status":"applied","sha256":"%s","counts":%s,"rows":[],"database":"%s"}' "$SHA" "$(counts "$1" "$2" "$3" 0)" "$DB"; }

CSV=$'name,email,body,role\nErika Mustermann,erika.mustermann@example.org,Rat,member\n'
args_validate() { jq -nc --arg c "$CSV" '{slug:"alpha-rat",phase:"validate",vertical:"stura",csv:$c}' > "${WORK}/args.json"; }
args_apply() { jq -nc --arg c "$CSV" --arg s "${1:-$SHA}" '{slug:"alpha-rat",phase:"apply",vertical:"stura",csv:$c,expectSha256:$s}' > "${WORK}/args.json"; }

# drive <handler function> — runs the handler the way the executor does (a
# sourced library, strict mode, a subshell), with tc and the dump stubbed.
drive() {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"
        CUSTOMER_OPS_BIN="$2/stubbin"
        . "$1/executor/handlers/import_members.sh"; . "$1/executor/handlers/seed_vertical.sh"
        . "$2/stubs.sh"
        ( set -e; "$3" "$4" alpha-rat 8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e "$5/args.json" "$5" ) 2>&1
    ' _ "$SRC" "$GREMION_ROOT" "$1" "$REQ" "$WORK"
}
order() { cat "$ORDER"; }

# ---------------------------------------------------------------------------

@test "both kinds are registered, and the handler files are strict-mode-free libraries" {
    run bash -c '
        set -euo pipefail
        . "$1/common.sh"; . "$1/customer-ops.sh"; . "$1/executor/registry.sh"
        [ "$(handler_for import_members)" = handle_import_members ]
        [ "$(handler_for seed_vertical)" = handle_seed_vertical ]
    ' _ "$SRC"
    [ "$status" -eq 0 ]
    ! grep -q '^set -e' "${SRC}/executor/handlers/import_members.sh" "${SRC}/executor/handlers/seed_vertical.sh"
}

@test "validate: the container's import-validate runs with the list on STDIN, nothing is dumped, applied or written" {
    answer import-validate "" 0 "$(validated_json)"
    drive handle_import_members
    [ "$status" -eq 0 ]
    [[ "$output" == *"status=validated sha256=${SHA}"* ]]
    [[ "$output" == *"name this sha256 in the apply request"* ]]
    [ "$(grep -c '^tc import-validate' "$ORDER")" -eq 1 ]
    grep -q "stdin=${#CSV}" "$ORDER" || grep -Eq 'stdin=[1-9][0-9]*' "$ORDER"
    ! grep -q '^dump' "$ORDER"
    ! grep -q 'import-apply' "$ORDER"
}

@test "the list is on STDIN only: no recorded argv carries a row, and no e-mail address is printed" {
    answer import-validate "" 0 "$(validated_json)"
    drive handle_import_members
    [ "$status" -eq 0 ]
    ! grep -q 'Mustermann' "$ORDER"
    [[ "$output" != *"$SECRET_MAIL"* ]]
}

@test "validate: a rejected list fails the request and names the rows by number and reason, never the address" {
    answer import-validate "" 1 '{"status":"rejected","sha256":"'"$SHA"'","counts":{"created":0,"linked_existing":0,"unchanged":0,"rejected":1,"accounts_created":0,"invites_sent":0},"rows":[{"row":2,"name":"Erika Mustermann","reason":"unknown_role"}],"database":"'"$DB"'"}'
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"row 2 (Erika Mustermann): unknown_role"* ]]
    [[ "$output" != *"$SECRET_MAIL"* ]]
}

@test "apply: validate, dump, apply, rerun, discard - in that order, one dump, discarded with a reason" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    answer import-apply 1 0 "$(applied_json 1 1 1)"
    answer import-apply 2 0 "$(applied_json 0 0 0)"
    drive handle_import_members
    [ "$status" -eq 0 ]
    [ "$(order | sed -E 's/ stdin=.*//; s/^(dump [a-z]+).*/\1/' | tr '\n' '|')" = "tc import-validate #1|dump take|tc import-apply #1|tc import-apply #2|dump discard|" ]
    grep -q "^dump take --release import-0192f0c4 --db ${DB}\$" "$ORDER"
    grep -q '^dump discard --release import-0192f0c4 --reason member import verified' "$ORDER"
    grep -q -- "--expect-sha256 ${SHA}" "$ORDER"
    [[ "$output" == *"import applied and verified"* ]]
}

@test "apply: a list that is not the validated one (sha256 differs) is refused before any dump or write" {
    args_apply "$OTHER"
    answer import-validate "" 0 "$(validated_json)"
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"not the one that was validated"* ]]
    ! grep -q '^dump' "$ORDER"
    ! grep -q 'import-apply' "$ORDER"
}

@test "apply: a dump that cannot be taken stops the request before the first write" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    touch "${GREMION_ROOT}/dump-fails"
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"pre-import dump could not be taken"* ]]
    ! grep -q 'import-apply' "$ORDER"
}

@test "apply: a customer database that is not a kernel database name is refused (no dump argv from a container line)" {
    args_apply
    answer import-validate "" 0 '{"status":"validated","sha256":"'"$SHA"'","counts":{"created":0,"linked_existing":0,"unchanged":0,"rejected":0,"accounts_created":0,"invites_sent":0},"rows":[],"database":"postgres"}'
    drive handle_import_members
    [ "$status" -ne 0 ]
    ! grep -q '^dump' "$ORDER"
}

@test "apply: a rerun that is not a no-op KEEPS the dump, names restore and discard, and fails" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    answer import-apply 1 0 "$(applied_json 1 1 1)"
    answer import-apply 2 0 "$(applied_json 1 0 0)"
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"the rerun was not a no-op"* ]]
    [[ "$output" == *"KEPT"* ]]
    [[ "$output" == *"gremion-migration-dump restore --release import-0192f0c4 --db ${DB} --accept-loss-since"* ]]
    ! grep -q '^dump discard' "$ORDER"
}

@test "apply: an invite sent by the rerun is also not a no-op (mail count is part of the idempotency proof)" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    answer import-apply 1 0 "$(applied_json 1 1 1)"
    answer import-apply 2 0 "$(applied_json 0 0 1)"
    drive handle_import_members
    [ "$status" -ne 0 ]
    ! grep -q '^dump discard' "$ORDER"
}

@test "apply: an apply that fails midway KEEPS the dump" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    answer import-apply 1 1 '{"status":"failed","sha256":"","counts":{"created":0,"linked_existing":0,"unchanged":0,"rejected":0,"accounts_created":0,"invites_sent":0},"rows":[],"error":"keycloak unreachable"}'
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"KEPT"* ]]
    ! grep -q '^dump discard' "$ORDER"
    [ "$(grep -c '^tc import-apply' "$ORDER")" -eq 1 ]
}

@test "apply: a list the apply rejects before any write (role change) discards its unused dump and fails" {
    args_apply
    answer import-validate "" 0 "$(validated_json)"
    answer import-apply 1 1 '{"status":"rejected","sha256":"'"$SHA"'","counts":{"created":0,"linked_existing":0,"unchanged":0,"rejected":1,"accounts_created":0,"invites_sent":0},"rows":[{"row":2,"name":"Erika Mustermann","reason":"role_changed"}],"database":"'"$DB"'"}'
    drive handle_import_members
    [ "$status" -ne 0 ]
    [[ "$output" == *"row 2 (Erika Mustermann): role_changed"* ]]
    grep -q '^dump discard --release import-0192f0c4 --reason member import rejected before any write' "$ORDER"
}

@test "args that name another customer than the request are refused before the container is touched" {
    jq -nc '{slug:"other-rat",phase:"validate",vertical:"stura",csv:"x"}' > "${WORK}/args.json"
    drive handle_import_members
    [ "$status" -ne 0 ]
    [ ! -s "$ORDER" ]
}

# ---------------------------------------------------------------------------

@test "seed_vertical: runs the idempotent seed-vertical verb with no stdin list and reports the counts" {
    jq -nc '{slug:"alpha-rat",vertical:"stura"}' > "${WORK}/args.json"
    answer seed-vertical "" 0 '{"status":"applied","units":{"created":10,"adopted":1,"present":0},"terms_written":true}'
    drive handle_seed_vertical
    [ "$status" -eq 0 ]
    [[ "$output" == *"units_created=10 units_adopted=1 units_present=0 terms_written=true"* ]]
    grep -q '^tc seed-vertical #1 stdin=0 argv=seed-vertical alpha-rat --vertical stura$' "$ORDER"
}

@test "seed_vertical: a verb that does not apply fails the request" {
    jq -nc '{slug:"alpha-rat",vertical:"stura"}' > "${WORK}/args.json"
    answer seed-vertical "" 1 '{"status":"failed","error":"vertical stura: not found"}'
    drive handle_seed_vertical
    [ "$status" -ne 0 ]
    [[ "$output" == *"vertical stura: not found"* ]]
}
