#!/usr/bin/env bats
# Unit tests for test/host/integration/pooled-stack-proof.sh (TASK-040).
#
# The proof's own checks must be able to go RED. Nothing here reaches a real
# docker engine: `docker` is test/host/fixtures/pooled-stack/docker-shim/docker,
# which answers the app-wait and cold-state phases for one app-blue colour and
# a three-container state tier and logs every stop/start/restart it sees. Its
# gremion-ui answers /api/health the way the real resolver does (403 without
# x-proxy-trust, 404 without a registered forwarded host), so a probe that
# would fail on a running stack fails here too.
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
    export SHIM_PROXY_SECRET="shim-secret-$RANDOM$RANDOM"
    export POOLED_STACK=t040-shim
    export POOLED_OUT="${BATS_TEST_TMPDIR}/out"
    # cold-state budgets, in seconds, kept short for the shim
    export POOLED_COLD_HOLD=0
    export POOLED_COLD_BUDGET=3
    export POOLED_POLL=1
    unset SHIM_ALIAS_STATE SHIM_READY SHIM_READY_DOWN SHIM_REGISTER
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

# ── the shim's resolver model (what the real gremion-ui answers) ─────────────

@test "shim: /api/health is not resolve-exempt -- bare 403, untrusted 403, no/forged/unregistered host 404" {
    export SHIM_READY=ok
    local u=http://127.0.0.1:3000/api/health
    run docker exec cid-ui wget -qO- "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"403 Forbidden"* ]]
    run docker exec cid-ui wget -qO- --header "x-proxy-trust: wrong" --header "x-forwarded-host: a.example" --header "Host: a.example" "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"403 Forbidden"* ]]
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: a.example" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]   # host not registered
    echo a.example > "${SHIM_DIR}/hosts"
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: b.example" "$1"' sh "$u"
    [ "$status" -ne 0 ]; [[ "$output" == *"404 Not Found"* ]]   # Host != forwarded host
    run docker exec cid-ui sh -c 'wget -qO- --header "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" --header "x-forwarded-host: a.example" --header "Host: a.example" "$1"' sh "$u"
    [ "$status" -eq 0 ]; [[ "$output" == *'"status":"ok"'* ]]
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
    # readiness, not liveness: the proof asked /api/health, the way the edge does
    grep -q '/api/health' "$calls"
    grep -q 'x-proxy-trust' "$calls"
    grep -q 'INSERT INTO tenant_domain' "$calls"
    grep -q 'cold-state ready' "${POOLED_OUT}/ledger/cold-state.log"
}

@test "cold-state: the proxy-trust secret never reaches the docker argv, the output or the ledger" {
    export SHIM_READY=ok
    run bash "$PROOF" cold-state
    [ "$status" -eq 0 ]
    [[ "$output" != *"$SHIM_PROXY_SECRET"* ]]
    ! grep -rqF "$SHIM_PROXY_SECRET" "${SHIM_DIR}/calls.log" "${POOLED_OUT}"
}

@test "cold-state: a probe that cannot see ready on the running stack is RED before state is touched (positive control)" {
    export SHIM_READY=no
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: positive control"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    ! grep -q '^stop ' "${SHIM_DIR}/calls.log"
}

@test "cold-state: a proof host the control DB does not register is RED" {
    export SHIM_READY=ok SHIM_REGISTER=fail
    run bash "$PROOF" cold-state
    [[ "$output" == *"FAIL cold-state: could not register"* ]]
    [[ "$output" == *"[pooled-proof] RED"* ]]
    [ "$status" -eq 1 ]
    ! grep -q '^stop ' "${SHIM_DIR}/calls.log"
}

@test "cold-state: an app that never becomes ready after state returns is RED (state held down past the retry budget)" {
    export SHIM_READY=stuck
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
