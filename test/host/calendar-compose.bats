#!/usr/bin/env bats
# The calendar leaf's host side (docker-compose.app.yml `calendar-service`): the ONE password of the module app
# role m_calendar_app, as gremion-init-secrets renders it.
# Run: bats test/host/calendar-compose.bats
#
# The calendar leaf opens each customer's lifecycle database t_<tenant>__calendar as m_calendar_app. That password
# has a single source: the file etc/secrets/tenant-create/module_app_password_calendar, which gremion-tenant writes
# (keep-if-present) and the module lifecycle sets the role from at every enable. The env value is derived from that
# file and never generated twice: a second generated value would not match the role, and every customer's calendar
# would answer 503 (28P01) while /healthz stays green. gremion-validate-env refuses a host whose value differs (test/host/validate-env.bats).
#
# Unit only (no daemon). The rendered URL itself is scripts/check-calendar-compose.test.mjs.

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

cal_file() { printf '%s' "${GREMION_ROOT}/etc/secrets/tenant-create/module_app_password_calendar"; }

# a value of the shape gremion-tenant writes (openssl rand -hex 32)
FILE_VALUE="1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

seed_file() {
    mkdir -p "${GREMION_ROOT}/etc/secrets/tenant-create"
    chmod 700 "${GREMION_ROOT}/etc/secrets/tenant-create"
    printf '%s\n' "${1:-$FILE_VALUE}" > "$(cal_file)"
    chmod 600 "$(cal_file)"
}

@test "an existing module_app_password_calendar file is THE password, in both colours, and it is not the board's" {
    seed_file
    render
    [ "$status" -eq 0 ]
    local f
    for f in app-blue.env app-green.env; do
        [ "$(value_of "${ENV_DIR}/${f}" CALENDAR_APP_PASSWORD)" = "$FILE_VALUE" ] \
            || { echo "${f}: CALENDAR_APP_PASSWORD is not the content of the file"; return 1; }
        [ "$(value_of "${ENV_DIR}/${f}" BOARD_APP_PASSWORD)" != "$FILE_VALUE" ] \
            || { echo "${f}: the board password is the calendar one"; return 1; }
    done
    # the file is kept as it was
    [ "$(cat "$(cal_file)")" = "$FILE_VALUE" ]
    # the state tier has no use for it
    assert_absent '^CALENDAR_APP_PASSWORD=' "${ENV_DIR}/state.env"
    # and no value reaches the log
    [[ "$output" != *"$FILE_VALUE"* ]]
}

@test "a second render with --force changes neither the calendar file nor CALENDAR_APP_PASSWORD" {
    seed_file
    render
    [ "$status" -eq 0 ]
    run "$INIT" --root "$GREMION_ROOT" --stack gremion --force
    [ "$status" -eq 0 ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" CALENDAR_APP_PASSWORD)" = "$FILE_VALUE" ]
    [ "$(value_of "${ENV_DIR}/app-green.env" CALENDAR_APP_PASSWORD)" = "$FILE_VALUE" ]
    [ "$(cat "$(cal_file)")" = "$FILE_VALUE" ]
}

@test "with NO file the render writes it (0600, directory 0700) and the env value is that same value, in both colours" {
    [ ! -e "$(cal_file)" ]
    render
    [ "$status" -eq 0 ]
    [ -s "$(cal_file)" ]
    local want f
    want="$(tr -d '\r\n' < "$(cal_file)")"
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "the file does not hold a 64 hex value"; return 1; }
    for f in app-blue.env app-green.env; do
        [ "$(value_of "${ENV_DIR}/${f}" CALENDAR_APP_PASSWORD)" = "$want" ] || { echo "${f}: differs from the file"; return 1; }
    done
    if fs_carries_modes "$ENV_DIR"; then
        [ "$(stat -c '%a' "$(cal_file)")" = "600" ]
    fi
    # a rerun of the render (--force) keeps the value the file already holds: the role was set from it
    run "$INIT" --root "$GREMION_ROOT" --stack gremion --force
    [ "$status" -eq 0 ]
    [ "$(tr -d '\r\n' < "$(cal_file)")" = "$want" ]
    [ "$(value_of "${ENV_DIR}/app-blue.env" CALENDAR_APP_PASSWORD)" = "$want" ]
}

@test "a file value that is not safe inside a URL is refused before anything is written, and the message names the file, never the value" {
    seed_file 'p@ss/word:with#chars'
    render
    [ "$status" -ne 0 ]
    [[ "$output" == *"module_app_password_calendar"* ]]
    [[ "$output" != *"p@ss/word"* ]]
    [[ ! -f "${ENV_DIR}/app-blue.env" ]]
    [[ ! -f "${ENV_DIR}/state.env" ]]
}
