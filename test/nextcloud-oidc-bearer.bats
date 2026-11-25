#!/usr/bin/env bats
# docker/nextcloud/hooks/before-starting/reconcile-oidc-bearer.sh re-asserts bearer validation on every
# start. One Nextcloud serves every customer host: the primary customer's provider is `Keycloak`, a customer
# on a secondary host has its own `Keycloak-<slug>` (written by gremion-services wire). A provider without
# --check-bearer=1 makes WebDAV answer 401 for that customer, so the hook walks EVERY provider of
# `occ user_oidc:provider --output=json`, not only the one named Keycloak.
#
# The hook runs against a stub `php` that records the occ calls, so the tests assert which calls were made,
# not an exit code. No Nextcloud and no Docker are needed.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$REPO_ROOT/docker/nextcloud/hooks/before-starting/reconcile-oidc-bearer.sh"

setup() {
    STUB_DIR="$(mktemp -d)"
    export PHP_LOG="$STUB_DIR/php.log"
    export PROVIDERS_FILE="$STUB_DIR/providers.json"
    export FAIL_IDS_FILE="$STUB_DIR/fail-ids"
    : >"$PHP_LOG"
    : >"$FAIL_IDS_FILE"
    cat >"$STUB_DIR/php" <<'STUB'
#!/bin/sh
# $1 is the occ path, the rest is the occ command line.
shift
printf '%s\n' "$*" >>"$PHP_LOG"
case "${1:-}" in
    status)
        echo "  - installed: ${NC_INSTALLED:-true}" ;;
    user_oidc:provider)
        if [ -z "${2:-}" ] || [ "${2:-}" = "--output=json" ]; then
            # the list of every registered provider
            [ -f "$STUB_DIR/list-fails" ] && { echo "Could not open the database" >&2; exit 1; }
            cat "$PROVIDERS_FILE"
            exit 0
        fi
        if grep -qxF -- "${2:-}" "$FAIL_IDS_FILE"; then
            echo "The provider update was refused" >&2
            exit 1
        fi ;;
esac
exit 0
STUB
    chmod +x "$STUB_DIR/php"
    export STUB_DIR
}

teardown() {
    rm -rf "$STUB_DIR"
}

# providers_compact <identifier>... -- the JSON array as user_oidc prints it, one line
providers_compact() {
    local out="[" id n=1 sep=""
    for id in "$@"; do
        out="${out}${sep}{\"id\":${n},\"identifier\":\"${id}\",\"clientId\":\"nextcloud\",\"settings\":{\"checkBearer\":false}}"
        sep=","
        n=$((n + 1))
    done
    printf '%s]\n' "$out" >"$PROVIDERS_FILE"
}

# providers_pretty <identifier>... -- the same array, pretty-printed (a space after each colon)
providers_pretty() {
    local out="[" id n=1 sep=""
    for id in "$@"; do
        out="${out}${sep}
    {
        \"id\": ${n},
        \"identifier\": \"${id}\",
        \"clientId\": \"nextcloud\"
    }"
        sep=","
        n=$((n + 1))
    done
    printf '%s\n]\n' "$out" >"$PROVIDERS_FILE"
}

run_hook() {
    PATH="$STUB_DIR:$PATH" run sh "$HOOK"
}

# update_calls -- every occ call that changes a provider (an identifier is given)
update_calls() {
    grep -E '^user_oidc:provider [^-]' "$PHP_LOG" || true
}

@test "single customer: one provider Keycloak gets exactly the call it always got" {
    providers_compact Keycloak
    run_hook
    [ "$status" -eq 0 ]
    [ "$(update_calls)" = "user_oidc:provider Keycloak --check-bearer=1 --bearer-provisioning=1 --unique-uid=0" ]
    [[ "$output" == *"ensured check-bearer=1 on provider Keycloak"* ]]
}

@test "two providers: Keycloak and Keycloak-b are both updated" {
    providers_compact Keycloak Keycloak-b
    run_hook
    [ "$status" -eq 0 ]
    grep -qxF 'user_oidc:provider Keycloak --check-bearer=1 --bearer-provisioning=1 --unique-uid=0' "$PHP_LOG"
    grep -qxF 'user_oidc:provider Keycloak-b --check-bearer=1 --bearer-provisioning=1' "$PHP_LOG"
    [[ "$output" == *"provider Keycloak-b"* ]]
}

@test "a secondary customer's provider keeps its own uid scheme: only the primary is told --unique-uid=0" {
    providers_compact Keycloak Keycloak-b
    run_hook
    [ "$status" -eq 0 ]
    call="$(grep '^user_oidc:provider Keycloak-b ' "$PHP_LOG")"
    [ -n "$call" ]
    [[ "$call" != *"--unique-uid"* ]]
}

@test "a pretty-printed list is read the same way" {
    providers_pretty Keycloak Keycloak-b
    run_hook
    [ "$status" -eq 0 ]
    grep -qxF 'user_oidc:provider Keycloak --check-bearer=1 --bearer-provisioning=1 --unique-uid=0' "$PHP_LOG"
    grep -qxF 'user_oidc:provider Keycloak-b --check-bearer=1 --bearer-provisioning=1' "$PHP_LOG"
}

@test "one failing provider is a warning that names it, and the other one is still updated" {
    providers_compact Keycloak Keycloak-b Keycloak-c
    printf 'Keycloak-b\n' >"$FAIL_IDS_FILE"
    run_hook
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING"*"Keycloak-b"* ]]
    grep -qxF 'user_oidc:provider Keycloak --check-bearer=1 --bearer-provisioning=1 --unique-uid=0' "$PHP_LOG"
    grep -qxF 'user_oidc:provider Keycloak-c --check-bearer=1 --bearer-provisioning=1' "$PHP_LOG"
}

@test "the primary failing does not stop the secondary customer's provider" {
    providers_compact Keycloak Keycloak-b
    printf 'Keycloak\n' >"$FAIL_IDS_FILE"
    run_hook
    [ "$status" -eq 0 ]
    grep -qxF 'user_oidc:provider Keycloak-b --check-bearer=1 --bearer-provisioning=1' "$PHP_LOG"
}

@test "an empty provider list is a warning, never a failure" {
    printf '[]\n' >"$PROVIDERS_FILE"
    run_hook
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING"* ]]
    [ -z "$(update_calls)" ]
}

@test "a list occ cannot read is a warning, never a failure" {
    : >"$STUB_DIR/list-fails"
    run_hook
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING"* ]]
    [ -z "$(update_calls)" ]
}

@test "an identifier that is not a plain name is never passed to occ" {
    providers_compact Keycloak 'bad name;x' --check-bearer=0
    run_hook
    [ "$status" -eq 0 ]
    [ "$(update_calls)" = "user_oidc:provider Keycloak --check-bearer=1 --bearer-provisioning=1 --unique-uid=0" ]
    # neither odd name reached occ in any form (an option-looking name is not caught by update_calls)
    [ "$(grep -c -e 'bad name' -e 'provider --check-bearer=0' -e 'x --check' "$PHP_LOG" || true)" = "0" ]
    [[ "$output" == *"ignoring"* ]]
}

@test "before Nextcloud is installed the hook calls nothing beyond the status probe" {
    providers_compact Keycloak
    NC_INSTALLED=false run_hook
    [ "$status" -eq 0 ]
    [ -z "$(update_calls)" ]
}

@test "groupfolders is still enabled on every start" {
    providers_compact Keycloak
    run_hook
    [ "$status" -eq 0 ]
    grep -qxF 'app:enable groupfolders' "$PHP_LOG"
}
