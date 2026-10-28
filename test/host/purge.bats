#!/usr/bin/env bats
# TRD-144/145 (TASK-033-a): the scheduled purge, infra/host/ops/purge.sh and its
# unit pair gremion-purge.service / gremion-purge.timer. Unit only: docker and
# flock are recording shims; nothing here touches a real daemon. The engine is
# proven on a real Postgres in packages/tenant-store (test/integration/purge.test.ts).
# Run: bats test/host/purge.bats

load 'test_helper/host'

PURGE="${HOST_SRC}/ops/purge.sh"
UNIT_DIR="${HOST_SRC}/templates/systemd"
MIGRATION="${KERNEL_ROOT}/packages/tenant-store/src/lifecycle/platform-migrations/0012_plt_purge_run.sql"

setup() {
    setup_host_root
    mkdir -p "${GREMION_ROOT}/current/infra/host/lib" "${GREMION_ROOT}/current/infra/host/ops" "${GREMION_ROOT}/current/infra/host/bin"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${GREMION_ROOT}/current/infra/host/lib/"
    cp "$PURGE" "${GREMION_ROOT}/current/infra/host/ops/purge.sh"
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    printf 'STACK=unitstack\nCOLOUR=blue\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    # tenant-create purge-run prints its one JSON line; PURGE_RC makes it fail
    shim docker 'echo "{\"verb\":\"purge-run\",\"status\":\"succeeded\"}"; exit "${PURGE_RC:-0}"'
    shim flock '[ -f "$GREMION_ROOT/lock-held" ] && exit 1; exit 0'
    RUN="${GREMION_ROOT}/current/infra/host/ops/purge.sh"
}

teardown() {
    teardown_host_root
}

@test "the service is a oneshot after docker, as the deploy user, with the docker group, inside the 4-minute rule" {
    local u="${UNIT_DIR}/gremion-purge.service"
    [ -f "$u" ]
    grep -q '^Type=oneshot' "$u"
    grep -q '^After=docker.service' "$u"
    grep -q '^Requires=docker.service' "$u"
    grep -q '^User=${DEPLOY_USER}$' "$u"
    grep -q '^SupplementaryGroups=docker$' "$u"
    grep -q '^Environment=GREMION_ROOT=${GREMION_ROOT}$' "$u"
    grep -q '^ExecStart=${GREMION_ROOT}/current/infra/host/ops/purge.sh$' "$u"
    grep -q '^TimeoutStartSec=170$' "$u"
    grep -q '^NoNewPrivileges=true' "$u"
    run grep -n '/opt/gremion' "$u"
    [ "$status" -ne 0 ]
}

@test "the timer fires at the moment of the seeded purge_run cron, persistent, and starts the service" {
    local t="${UNIT_DIR}/gremion-purge.timer"
    [ -f "$t" ]
    # one schedule, stated once: the cron the platform migration seeds
    local cron min hour
    cron="$(sed -n "s/.*'purge_run', '\([^']*\)'.*/\1/p" "$MIGRATION")"
    min="${cron%% *}"; hour="$(cut -d' ' -f2 <<< "$cron")"
    [[ "$cron" == "$min $hour * * *" ]]
    grep -q "^OnCalendar=\*-\*-\* $(printf '%02d:%02d' "$hour" "$min"):00 UTC$" "$t"
    grep -q '^Persistent=true' "$t"
    grep -q '^Unit=gremion-purge.service' "$t"
    grep -q '^WantedBy=timers.target' "$t"
}

@test "bootstrap's timers stage installs the purge units through two-argument render_unit and asserts a real next elapse" {
    local bs="${KERNEL_ROOT}/infra/host/bootstrap.sh"
    grep -qF 'render_unit gremion-purge.service /etc/systemd/system/gremion-purge.service' "$bs"
    grep -qF 'render_unit gremion-purge.timer /etc/systemd/system/gremion-purge.timer' "$bs"
    grep -qF 'systemctl enable --now gremion-purge.timer' "$bs"
    grep -qF 'systemctl show gremion-purge.timer -p NextElapseUSecRealtime --value' "$bs"
}

@test "it runs tenant-create purge-run in the ACTIVE colour, once, and passes the JSON line through" {
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"verb":"purge-run"'* ]]
    local n
    n="$(grep -c 'tenant-create purge-run' "$SHIM_LOG")"
    [ "$n" -eq 1 ]
    grep -q -- 'app-blue.env' "$SHIM_LOG"
}

@test "it exits 1 when the purge run fails, so the unit fails and the operator sees it" {
    run env GREMION_ROOT="$GREMION_ROOT" PURGE_RC=1 "$RUN"
    [ "$status" -eq 1 ]
}

@test "it takes the host lock (waits, then exits 3) rather than race a deploy, and runs nothing then" {
    : > "$GREMION_ROOT/lock-held"
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 3 ]
    run grep -c 'tenant-create' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "it refuses to run with no active colour (tenant-create runs in the active colour) and runs nothing" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 2 ]
    run grep -c 'tenant-create' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "it takes no argument" {
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN" --all
    [ "$status" -eq 2 ]
}
