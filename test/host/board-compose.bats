#!/usr/bin/env bats
# The board leaf's host side (docker-compose.app.yml `board-service`): its shared secret and the ONE password of
# the module app role m_board_app, as gremion-init-secrets renders them.
# Run: bats test/host/board-compose.bats
#
# That password has a single source: the file etc/secrets/tenant-create/module_app_password_board, which
# gremion-tenant writes (keep-if-present) and the module lifecycle sets the role from at every enable. The env
# value is derived from that file and never generated twice: a second generated value would not match the role,
# and every customer's board would answer 503 (28P01) while /healthz stays green.
#
# Unit only (no daemon). The authentication of the rendered URL against a real Postgres, and the leaf booting
# on the rendered environment, are scripts/check-board-compose.test.mjs.

load 'test_helper/host'

setup() {
    setup_host_root
    INIT="${HOST_SRC}/bin/gremion-init-secrets"
    ENV_DIR="${GREMION_ROOT}/etc/env"
}

teardown() {
    teardown_host_root
}

render() {
    run "$INIT" --root "$GREMION_ROOT" --stack gremion "$@"
}

value_of() {
    sed -n "s/^$2=//p" "$1" | head -n1
}

board_file() { printf '%s' "${GREMION_ROOT}/etc/secrets/tenant-create/module_app_password_board"; }

# a value of the shape gremion-tenant writes (openssl rand -hex 32)
FILE_VALUE="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

seed_file() {
    mkdir -p "${GREMION_ROOT}/etc/secrets/tenant-create"
    chmod 700 "${GREMION_ROOT}/etc/secrets/tenant-create"
    printf '%s\n' "${1:-$FILE_VALUE}" > "$(board_file)"
    chmod 600 "$(board_file)"
}

@test "an existing module_app_password_board file is THE password, in both colours (a generated value would differ)" {
    seed_file
    render
    [ "$status" -eq 0 ]
    local f
    for f in app-blue.env app-green.env; do
        [ "$(value_of "${ENV_DIR}/${f}" BOARD_APP_PASSWORD)" = "$FILE_VALUE" ] \
            || { echo "${f}: BOARD_APP_PASSWORD is not the content of the file"; return 1; }
    done
    # the file is kept as it was
    [ "$(cat "$(board_file)")" = "$FILE_VALUE" ]
    # the state tier has no use for it
    ! grep -q '^BOARD_APP_PASSWORD=' "${ENV_DIR}/state.env"
    # and no value reaches the log
    [[ "$output" != *"$FILE_VALUE"* ]]
}

@test "a second render with --force changes neither the file nor BOARD_APP_PASSWORD, while the other secrets rotate" {
    seed_file
    render
    [ "$status" -eq 0 ]
    local before_secret; before_secret="$(value_of "${ENV_DIR}/app-blue.env" INTERNAL_BOARD_SECRET)"
    run "$INIT" --root "$GREMION_ROOT" --stack gremion --force
    [ "$status" -eq 0 ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" BOARD_APP_PASSWORD)" = "$FILE_VALUE" ]
    [ "$(value_of "${ENV_DIR}/app-green.env" BOARD_APP_PASSWORD)" = "$FILE_VALUE" ]
    [ "$(cat "$(board_file)")" = "$FILE_VALUE" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" INTERNAL_BOARD_SECRET)" != "$before_secret" ]
}

@test "with NO file the render writes it (0600, directory 0700) and the env value is that same value, in both colours" {
    [ ! -e "$(board_file)" ]
    render
    [ "$status" -eq 0 ]
    [ -s "$(board_file)" ]
    local want f
    want="$(tr -d '\r\n' < "$(board_file)")"
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "the file does not hold a 64 hex value"; return 1; }
    for f in app-blue.env app-green.env; do
        [ "$(value_of "${ENV_DIR}/${f}" BOARD_APP_PASSWORD)" = "$want" ] || { echo "${f}: differs from the file"; return 1; }
    done
    if fs_carries_modes "$ENV_DIR"; then
        [ "$(stat -c '%a' "$(board_file)")" = "600" ]
        [ "$(stat -c '%a' "${GREMION_ROOT}/etc/secrets/tenant-create")" = "700" ]
    fi
    # a rerun of the render (--force) keeps the value the file already holds: the role was set from it
    run "$INIT" --root "$GREMION_ROOT" --stack gremion --force
    [ "$status" -eq 0 ]
    [ "$(tr -d '\r\n' < "$(board_file)")" = "$want" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" BOARD_APP_PASSWORD)" = "$want" ]
}

@test "a file changed by hand is followed by the next render" {
    seed_file
    render
    [ "$status" -eq 0 ]
    seed_file "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    run "$INIT" --root "$GREMION_ROOT" --stack gremion --force
    [ "$status" -eq 0 ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" BOARD_APP_PASSWORD)" = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" ]
}

@test "an empty file counts as absent (the keep-if-present rule of gremion-tenant is a size test)" {
    mkdir -p "${GREMION_ROOT}/etc/secrets/tenant-create"
    : > "$(board_file)"
    render
    [ "$status" -eq 0 ]
    [ -s "$(board_file)" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" BOARD_APP_PASSWORD)" = "$(tr -d '\r\n' < "$(board_file)")" ]
}

@test "a file value that is not safe inside a URL is refused before anything is written, and the message names the file, never the value" {
    seed_file 'p@ss/word:with#chars'
    render
    [ "$status" -ne 0 ]
    [[ "$output" == *"module_app_password_board"* ]]
    [[ "$output" != *"p@ss/word"* ]]
    [[ ! -f "${ENV_DIR}/app-blue.env" ]]
    [[ ! -f "${ENV_DIR}/state.env" ]]
}

@test "a refused render (an env file already exists, no --force) writes no secret file" {
    render
    [ "$status" -eq 0 ]
    rm -f "$(board_file)"
    run "$INIT" --root "$GREMION_ROOT" --stack gremion
    [ "$status" -eq 2 ]
    [ ! -e "$(board_file)" ]
}

@test "INTERNAL_BOARD_SECRET is 64 hex, the same in both colours, its own value, mode 600, and a refused re-render leaves it untouched" {
    render
    [ "$status" -eq 0 ]
    local f k v
    v="$(value_of "${ENV_DIR}/app-blue.env" INTERNAL_BOARD_SECRET)"
    [[ "$v" =~ ^[0-9a-f]{64}$ ]] || { echo "INTERNAL_BOARD_SECRET is not 64 hex"; return 1; }
    [ "$v" = "$(value_of "${ENV_DIR}/app-green.env" INTERNAL_BOARD_SECRET)" ]
    for k in INTERNAL_CALENDAR_SECRET INTERNAL_CONTENT_SECRET INTERNAL_NEWSLETTER_SECRET INTERNAL_PUSH_SECRET BOARD_APP_PASSWORD; do
        [ "$v" != "$(value_of "${ENV_DIR}/app-blue.env" "$k")" ] || { echo "INTERNAL_BOARD_SECRET equals ${k}"; return 1; }
    done
    ! grep -q '^INTERNAL_BOARD_SECRET=' "${ENV_DIR}/state.env"
    if fs_carries_modes "$ENV_DIR"; then
        for f in app-blue.env app-green.env; do [ "$(stat -c '%a' "${ENV_DIR}/${f}")" = "600" ]; done
    fi
    # without --force the render refuses and the existing value stays
    run "$INIT" --root "$GREMION_ROOT" --stack gremion
    [ "$status" -eq 2 ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" INTERNAL_BOARD_SECRET)" = "$v" ]
}

@test "COMPOSE_PROFILES carries board (the list comes from the shipped module-profiles.json, which names the profile of the module that declares board-postgres)" {
    render
    [ "$status" -eq 0 ]
    local f
    for f in state.env app-blue.env app-green.env; do
        [ "$(value_of "${ENV_DIR}/${f}" COMPOSE_PROFILES)" = "production,board,calendar,collabora,content,newsletter,nextcloud,video" ] \
            || { echo "${f}: $(value_of "${ENV_DIR}/${f}" COMPOSE_PROFILES)"; return 1; }
    done
}
