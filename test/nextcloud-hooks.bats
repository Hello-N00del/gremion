#!/usr/bin/env bats
# docker/nextcloud: new users must start with an empty home (no Readme.md, no
# Nextcloud.png). The skeleton directory is emptied twice over: statically in
# config/custom.config.php (first start) and by the before-starting hook
# empty-skeleton.sh (every start, so a stale data volume converges too).
#
# The hook is run against a stub `php` that records its arguments, so the tests
# assert the occ calls the hook makes, not the exit code. No Nextcloud and no
# Docker are needed.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
HOOK="$REPO_ROOT/docker/nextcloud/hooks/before-starting/empty-skeleton.sh"
CUSTOM_CONFIG="$REPO_ROOT/docker/nextcloud/config/custom.config.php"
DOCKERFILE="$REPO_ROOT/docker/nextcloud/Dockerfile"

setup() {
    STUB_DIR="$(mktemp -d)"
    export PHP_LOG="$STUB_DIR/php.log"
    : >"$PHP_LOG"
    cat >"$STUB_DIR/php" <<'STUB'
#!/bin/sh
# $1 is the occ path, $2 the occ command.
printf '%s\n' "$*" >>"$PHP_LOG"
case "${2:-}" in
    status)
        echo "  - installed: ${NC_INSTALLED:-true}"
        ;;
    config:system:set)
        exit "${NC_SET_RC:-0}"
        ;;
esac
exit 0
STUB
    chmod +x "$STUB_DIR/php"
}

teardown() {
    rm -rf "$STUB_DIR"
}

run_hook() {
    PATH="$STUB_DIR:$PATH" run sh "$HOOK"
}

@test "hook sets skeletondirectory to the empty string through occ" {
    run_hook
    [ "$status" -eq 0 ]
    grep -qxF '/var/www/html/occ config:system:set skeletondirectory --value=' "$PHP_LOG"
    [[ "$output" == *"empty-skeleton: ensured skeletondirectory is empty"* ]]
}

@test "hook is idempotent: a second run makes the same single set and still exits 0" {
    run_hook
    run_hook
    [ "$status" -eq 0 ]
    [ "$(grep -c 'config:system:set skeletondirectory' "$PHP_LOG")" -eq 2 ]
    # Nothing but the status probe and the one set per run.
    [ "$(grep -vc -e ' status$' -e 'config:system:set skeletondirectory --value=$' "$PHP_LOG")" -eq 0 ]
}

@test "hook never touches existing users or their files" {
    run_hook
    [ "$status" -eq 0 ]
    run grep -E 'user:|files:|app:' "$PHP_LOG"
    [ "$status" -ne 0 ]
}

@test "hook does nothing before Nextcloud is installed" {
    NC_INSTALLED=false run_hook
    [ "$status" -eq 0 ]
    run grep 'config:system:set' "$PHP_LOG"
    [ "$status" -ne 0 ]
}

@test "an occ failure warns loudly but never blocks the container start" {
    NC_SET_RC=1 run_hook
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARNING skeletondirectory set failed"* ]]
    [[ "$output" != *"ensured skeletondirectory is empty"* ]]
}

@test "custom.config.php carries the empty skeletondirectory for a first start" {
    grep -qE "^[[:space:]]*'skeletondirectory'[[:space:]]*=>[[:space:]]*''," "$CUSTOM_CONFIG"
}

@test "the image copies the whole before-starting directory, so the hook ships" {
    grep -qF 'COPY hooks/before-starting/   /docker-entrypoint-hooks.d/before-starting/' "$DOCKERFILE"
    [ -f "$HOOK" ]
}
