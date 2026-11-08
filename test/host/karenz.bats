#!/usr/bin/env bats
# Module switch-off Karenz (phase 2, Task 5): the hourly finalization run,
# infra/host/ops/karenz.sh and its unit pair gremion-karenz.service /
# gremion-karenz.timer. Unit only: docker and flock are recording shims; nothing
# here touches a real daemon. The finalize rule is proven on a real Postgres in
# packages/tenant-store (test/integration/lifecycle-karenz.test.ts) and the verb
# in gremion-ui (karenz-verbs.test.ts).
# Run: bats test/host/karenz.bats

load 'test_helper/host'

KARENZ="${HOST_SRC}/ops/karenz.sh"
UNIT_DIR="${HOST_SRC}/templates/systemd"
VERB_TS="${KERNEL_ROOT}/gremion-ui/scripts/tenant-provision-karenz.ts"

setup() {
    setup_host_root
    mkdir -p "${GREMION_ROOT}/current/infra/host/lib" "${GREMION_ROOT}/current/infra/host/ops" "${GREMION_ROOT}/current/infra/host/bin"
    cp "${HOST_SRC}/lib/common.sh" "${HOST_SRC}/lib/customer-ops.sh" "${GREMION_ROOT}/current/infra/host/lib/"
    cp "$KARENZ" "${GREMION_ROOT}/current/infra/host/ops/karenz.sh"
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    printf 'STACK=unitstack\nCOLOUR=blue\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    # tenant-create karenz-run prints its one JSON line; KARENZ_RC makes it fail
    shim docker 'echo "{\"verb\":\"karenz-run\",\"deletion\":\"off\",\"due\":0,\"finalized\":0,\"kept\":0,\"orphanedExports\":[],\"errors\":[]}"; exit "${KARENZ_RC:-0}"'
    shim flock '[ -f "$GREMION_ROOT/lock-held" ] && exit 1; exit 0'
    RUN="${GREMION_ROOT}/current/infra/host/ops/karenz.sh"
}

teardown() {
    teardown_host_root
}

@test "the service is a oneshot after docker, as the deploy user, with the docker group, inside the 4-minute rule" {
    local u="${UNIT_DIR}/gremion-karenz.service"
    [ -f "$u" ]
    grep -q '^Type=oneshot' "$u"
    grep -q '^After=docker.service' "$u"
    grep -q '^Requires=docker.service' "$u"
    grep -q '^User=${DEPLOY_USER}$' "$u"
    grep -q '^Group=${DEPLOY_USER}$' "$u"
    grep -q '^SupplementaryGroups=docker$' "$u"
    grep -q '^Environment=GREMION_ROOT=${GREMION_ROOT}$' "$u"
    grep -q '^ExecStart=${GREMION_ROOT}/current/infra/host/ops/karenz.sh$' "$u"
    grep -q '^TimeoutStartSec=170$' "$u"
    grep -q '^NoNewPrivileges=true' "$u"
    run grep -n '/opt/gremion' "$u"
    [ "$status" -ne 0 ]
}

@test "the timer fires hourly at minute 17 UTC, is persistent, and starts the service" {
    local t="${UNIT_DIR}/gremion-karenz.timer"
    [ -f "$t" ]
    grep -q '^OnCalendar=\*-\*-\* \*:17:00 UTC$' "$t"
    grep -q '^Persistent=true' "$t"
    grep -q '^Unit=gremion-karenz.service' "$t"
    grep -q '^WantedBy=timers.target' "$t"
}

@test "bootstrap's timers stage installs the karenz units through two-argument render_unit and asserts a real next elapse" {
    local bs="${KERNEL_ROOT}/infra/host/bootstrap.sh"
    grep -qF 'render_unit gremion-karenz.service /etc/systemd/system/gremion-karenz.service' "$bs"
    grep -qF 'render_unit gremion-karenz.timer /etc/systemd/system/gremion-karenz.timer' "$bs"
    grep -qF 'systemctl enable --now gremion-karenz.timer' "$bs"
    grep -qF 'systemctl show gremion-karenz.timer -p NextElapseUSecRealtime --value' "$bs"
    run grep -nE 'render_unit +[A-Za-z0-9._-]+ *\|' "$bs"
    [ "$status" -ne 0 ]
}

@test "karenz.sh runs tenant-create karenz-run in the ACTIVE colour, once, and passes the JSON line through" {
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"verb":"karenz-run"'* ]]
    local n
    n="$(grep -c 'tenant-create karenz-run' "$SHIM_LOG")"
    [ "$n" -eq 1 ]
    grep -q -- 'app-blue.env' "$SHIM_LOG"
}

@test "a dry run that reports rows due is a success (exit 0): the verb exit code decides, not the due count" {
    shim docker 'echo "{\"verb\":\"karenz-run\",\"deletion\":\"off\",\"due\":3,\"finalized\":0,\"kept\":0,\"orphanedExports\":[],\"errors\":[]}"; exit 0'
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"due":3'* ]]
}

@test "a failing verb exits 1, so the unit fails and the operator sees it" {
    run env GREMION_ROOT="$GREMION_ROOT" KARENZ_RC=1 "$RUN"
    [ "$status" -eq 1 ]
}

@test "a busy host lock exits 3 and runs nothing" {
    : > "$GREMION_ROOT/lock-held"
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 3 ]
    run grep -c 'tenant-create' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "it refuses to run with no active colour and runs nothing" {
    rm -f "${GREMION_ROOT}/runtime/active-colour"
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN"
    [ "$status" -eq 2 ]
    run grep -c 'tenant-create' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "an argument is a usage error (exit 2) and runs nothing" {
    run env GREMION_ROOT="$GREMION_ROOT" "$RUN" --all
    [ "$status" -eq 2 ]
    run grep -c 'tenant-create' "$SHIM_LOG"
    [ "$output" = "0" ]
}

@test "karenz.sh takes runtime/hostd.lock, the lock a deploy and an executor request take" {
    grep -qF 'runtime/hostd.lock' "$KARENZ"
    grep -qE 'flock -w "\$\{KARENZ_LOCK_WAIT:-20\}" 9' "$KARENZ"
}

@test "lock wait + one-shot start + the run's own deadline + the record fit inside TimeoutStartSec" {
    local timeout wait deadline_ms
    timeout="$(sed -n 's/^TimeoutStartSec=\([0-9]*\)$/\1/p' "${UNIT_DIR}/gremion-karenz.service")"
    wait="$(sed -n 's/.*flock -w "${KARENZ_LOCK_WAIT:-\([0-9]*\)}".*/\1/p' "$KARENZ")"
    # CR stripped first: a Windows checkout has CRLF in .ts files and `$` would not match
    deadline_ms="$(tr -d '\r' < "$VERB_TS" | sed -n 's/^export const KARENZ_RUN_DEADLINE_MS = \([0-9_]*\)$/\1/p' | tr -d _)"
    [ -n "$timeout" ] && [ -n "$wait" ] && [ -n "$deadline_ms" ]
    # 15 s for `docker compose run` to start the one-shot, 25 s for the record and teardown
    (( wait + 15 + deadline_ms / 1000 + 25 <= timeout ))
}

@test "the operator README lists karenz.sh next to purge.sh" {
    grep -qF '| `karenz.sh` |' "${HOST_SRC}/ops/README.md"
    grep -qF 'gremion-karenz.timer' "${HOST_SRC}/ops/README.md"
}
