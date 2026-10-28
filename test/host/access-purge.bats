#!/usr/bin/env bats
# Tests for infra/host/ops/access-purge.sh and its units (TRD-092 / TRD-191,
# MED-2): the access record (oac.access_record) is purged from the oldest entry
# by oac.purge_access_records, which nothing used to call. The timer runs it
# daily with the 27-day window (RC-LOG-AUD = the security window, never
# shorter) as the executor role over the state server's local socket.
# Unit only: docker is test/host/fixtures/executor/docker-shim. Run:
#   bats test/host/access-purge.bats

load 'test_helper/host'

FIX="${HOST_TEST_DIR}/fixtures/executor"
UNIT_DIR="${HOST_SRC}/templates/systemd"

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/lib/executor" "${REL}/infra/host/ops" "${REL}/infra/host/bin"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/lib/executor/db.sh" "${REL}/infra/host/lib/executor/"
    cp "${HOST_SRC}/ops/access-purge.sh" "${REL}/infra/host/ops/" 2>/dev/null || true
    printf 'STACK=guardstack\nPOSTGRES_USER=postgres\n' > "${GREMION_ROOT}/etc/env/state.env"
    shim docker "exec bash '${FIX}/docker-shim' \"\$@\""
    export GREMION_EXECUTOR_PG_CONTAINER=t092-pg-fixture
    unset EXECUTOR_PG_CONTAINER
}

teardown() {
    teardown_host_root
}

purge() { run "${REL}/infra/host/ops/access-purge.sh"; }

@test "the purge calls oac.purge_access_records with the 27-day window as the executor role and reports the count" {
    echo 3 > "${GREMION_ROOT}/purge-count"
    purge
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(cat "${GREMION_ROOT}/purge.log")" = "27 days" ]
    [ "$(sort -u "${GREMION_ROOT}/psql-roles.log")" = "gremion_executor" ]
    [[ "$output" == *"removed=3"* ]]
    [[ "$output" == *"window=27d"* ]]
}

@test "no environment knob can narrow the window below 27 days" {
    GREMION_ACCESS_PURGE_DAYS=1 ACCESS_PURGE_DAYS=1 ACCESS_PURGE_WINDOW="1 day" purge
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(cat "${GREMION_ROOT}/purge.log")" = "27 days" ]
}

@test "a database that is down, or one that refuses the purge, is a non-zero exit" {
    : > "${GREMION_ROOT}/pg-down"
    purge
    [ "$status" -ne 0 ]
    rm "${GREMION_ROOT}/pg-down"
    : > "${GREMION_ROOT}/purge-refused"
    purge
    [ "$status" -ne 0 ]
}

@test "a reply that is not a count fails the run (never reported as 0 removed)" {
    echo "not-a-number" > "${GREMION_ROOT}/purge-count"
    purge
    [ "$status" -ne 0 ]
}

@test "the service and the timer units: deploy user in the docker group, daily, persistent, no literal root path" {
    local s="${UNIT_DIR}/gremion-access-purge.service" t="${UNIT_DIR}/gremion-access-purge.timer"
    [ -f "$s" ] && [ -f "$t" ]
    grep -q '^Type=oneshot' "$s"
    grep -qF 'User=${DEPLOY_USER}' "$s"
    grep -q '^SupplementaryGroups=docker' "$s"
    grep -qF 'ExecStart=${GREMION_ROOT}/current/infra/host/ops/access-purge.sh' "$s"
    grep -q '^TimeoutStartSec=' "$s"
    grep -q '^OnCalendar=\*-\*-\* [0-9][0-9]:[0-9][0-9]:00 UTC' "$t"
    grep -q '^Persistent=true' "$t"
    grep -q '^Unit=gremion-access-purge.service' "$t"
    grep -q '^WantedBy=timers.target' "$t"
    run grep -n '/opt/gremion' "$s" "$t"
    [ "$status" -ne 0 ]
}

@test "bootstrap's timers stage installs the purge units through two-argument render_unit and asserts a real next elapse" {
    local bs="${HOST_SRC}/bootstrap.sh"
    grep -qF 'render_unit gremion-access-purge.service /etc/systemd/system/gremion-access-purge.service' "$bs"
    grep -qF 'render_unit gremion-access-purge.timer /etc/systemd/system/gremion-access-purge.timer' "$bs"
    grep -qF 'systemctl enable --now gremion-access-purge.timer' "$bs"
    grep -qF 'systemctl show gremion-access-purge.timer -p NextElapseUSecRealtime --value' "$bs"
}

@test "the ops README documents the purge script, its window and its timer" {
    grep -q 'access-purge.sh' "${HOST_SRC}/ops/README.md"
    grep -q 'oac.purge_access_records' "${HOST_SRC}/ops/README.md"
    grep -q '27' "${HOST_SRC}/ops/README.md"
}
