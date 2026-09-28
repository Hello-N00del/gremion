#!/usr/bin/env bats
# Unit tests for test/host/integration/pooled-stack-proof.sh (TASK-040).
#
# The proof's own checks must be able to go RED. Nothing here reaches a real
# docker engine: `docker` is test/host/fixtures/pooled-stack/docker-shim/docker,
# which answers the app-wait and cold-state phases for one app-blue colour and
# a three-container state tier and logs every stop/start/restart it sees.
# The running proof itself is `bash test/host/integration/pooled-stack-proof.sh all`.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
PROOF="${REPO_ROOT}/test/host/integration/pooled-stack-proof.sh"

setup() {
    local bin="${BATS_TEST_TMPDIR}/bin"
    mkdir -p "$bin"
    # A copy with an executable bit, whatever the checkout's file mode is.
    tr -d '\r' < "${REPO_ROOT}/test/host/fixtures/pooled-stack/docker-shim/docker" > "${bin}/docker"
    chmod +x "${bin}/docker"
    export PATH="${bin}:${PATH}"
    export SHIM_STACK=t040-shim
    export SHIM_DIR="${BATS_TEST_TMPDIR}/shim"
    export POOLED_STACK=t040-shim
    export POOLED_OUT="${BATS_TEST_TMPDIR}/out"
    # cold-state budgets, in seconds, kept short for the shim
    export POOLED_COLD_HOLD=0
    export POOLED_COLD_BUDGET=3
    export POOLED_POLL=1
    unset SHIM_ALIAS_STATE SHIM_READY SHIM_READY_DOWN
}

# ── app-wait: the per-colour isolation checks ────────────────────────────────

@test "app-wait: a correctly aliased colour is GREEN (positive control for the shim)" {
    run bash "$PROOF" app-wait blue
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok   app-blue: 2 container(s)"* ]]
    [[ "$output" == *"[pooled-proof] GREEN"* ]]
    [[ "$output" != *"FAIL"* ]]
}

@test "app-wait: gremion-ui without its <svc>-<colour> alias on _state is RED (verify-r2 HIGH 2)" {
    export SHIM_ALIAS_STATE=wrongalias
    run bash "$PROOF" app-wait blue
    [[ "$output" == *"FAIL /cid-ui on t040-shim_state carries no gremion-ui-blue alias"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    # and it does not claim the isolation check passed
    [[ "$output" != *"ok   app-blue: "*" every shared-network alias"* ]]
}

@test "run.log records the phases that ran, not the empty list left after the loop (verify-r2 MEDIUM 2)" {
    run bash "$PROOF" app-wait blue
    [ "$status" -eq 0 ]
    grep -q 'phases \[app-wait blue\] RED=0' "${POOLED_OUT}/ledger/run.log"
}

# ── cold-state: the app re-boots against a DOWN state tier ───────────────────

@test "cold-state: the app is restarted while state is down and is ready by /api/health once state is back" {
    export SHIM_READY=ok
    run bash "$PROOF" cold-state
    [ "$status" -eq 0 ]
    [[ "$output" == *"[pooled-proof] GREEN"* ]]
    # order: state stopped, then the app colour restarted, then state started
    local calls="${SHIM_DIR}/calls.log"
    local l_stop l_restart l_start
    l_stop="$(grep -n '^stop ' "$calls" | head -n1 | cut -d: -f1)"
    l_restart="$(grep -n '^restart ' "$calls" | head -n1 | cut -d: -f1)"
    l_start="$(grep -n '^start ' "$calls" | head -n1 | cut -d: -f1)"
    [ -n "$l_stop" ] && [ -n "$l_restart" ] && [ -n "$l_start" ]
    [ "$l_stop" -lt "$l_restart" ]
    [ "$l_restart" -lt "$l_start" ]
    grep -q '^stop .*cid-postgres' "$calls"
    grep -q '^restart .*cid-ui' "$calls"
    # readiness, not liveness: the proof asked /api/health
    grep -q '/api/health' "$calls"
    grep -q 'cold-state ready' "${POOLED_OUT}/ledger/cold-state.log"
}

@test "cold-state: an app that never becomes ready after state returns is RED (state held down past the retry budget)" {
    export SHIM_READY=no
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: app-blue gremion-ui not ready"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
}

@test "cold-state: a readiness probe that answers ok while state is DOWN is RED (negative control)" {
    export SHIM_READY_DOWN=ok
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: /api/health answers ok with the state tier DOWN"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
}
