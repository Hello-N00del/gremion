#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-switch.
#
# Nothing here touches a real docker, a real traefik or a real network: `curl` is
# a recording shim (test_helper/host.bash) and the whole host layout is a temp
# $GREMION_ROOT. The integration proof against a real Traefik is
# test/host/integration/edge-proto.sh.

load 'test_helper/host'

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
SWITCH="${REPO_ROOT}/infra/host/bin/gremion-switch"

# A curl shim that answers the two shapes gremion-switch uses:
#   - GET  <api>/api/http/services/app@file  -> the service JSON traefik reports
#   - POST <url>/api/internal/evict          -> the HTTP status code (curl -w)
# $1 is the colour the fake traefik reports; $EVICT_CODE is what a target answers.
shim_edge() {
    local colour="$1"
    shim curl "$(cat <<EOF
url=""
for a in "\$@"; do case "\$a" in http*) url="\$a";; esac; done
case "\$url" in
  */api/http/services/app@file)
      printf '{"loadBalancer":{"servers":[{"url":"http://gremion-ui-${colour}:3000"}]}}' ;;
  */api/internal/evict)
      printf '%s' "\${EVICT_CODE:-204}" ;;
  *)
      printf '' ;;
esac
EOF
)"
}

setup() {
    setup_host_root
    export TRAEFIK_API="http://127.0.0.1:8080"
    export SWITCH_POLL_SECONDS=2
    export EVICT_CODE=204
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=staging
PLATFORM_DOMAIN=example.org
INTERNAL_PUSH_SECRET=push-secret-for-tests
EOF
    printf '[]\n' > "${GREMION_ROOT}/runtime/evict-targets.json"
}

@test "gremion-switch prints usage and exits 2 with no colour" {
    run "$SWITCH"
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: gremion-switch"* ]]
}

@test "gremion-switch rejects an unknown argument with exit 2" {
    run "$SWITCH" purple
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown argument: purple"* ]]
}

@test "gremion-switch points app and public at the requested colour" {
    shim_edge blue
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    grep -q 'url: "http://gremion-ui-blue:3000"'     "${GREMION_ROOT}/etc/edge/active.yml"
    grep -q 'url: "http://gremion-public-blue:3000"' "${GREMION_ROOT}/etc/edge/active.yml"
}

@test "gremion-switch points app-next and public-next at the other colour" {
    shim_edge blue
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    grep -q 'url: "http://gremion-ui-green:3000"'     "${GREMION_ROOT}/etc/edge/active.yml"
    grep -q 'url: "http://gremion-public-green:3000"' "${GREMION_ROOT}/etc/edge/active.yml"
}

@test "gremion-switch emits two distinguishable internaltest routers and no middleware" {
    shim_edge green
    run "$SWITCH" green
    [ "$status" -eq 0 ]
    grep -q 'test-app:'    "${GREMION_ROOT}/etc/edge/active.yml"
    grep -q 'test-public:' "${GREMION_ROOT}/etc/edge/active.yml"
    grep -q 'internaltest' "${GREMION_ROOT}/etc/edge/active.yml"
    # deliberate deviation from the skeleton: two routers on one entrypoint with
    # the same rule collide, so test-public is scoped by path
    grep -q 'PathPrefix(`/portal`)' "${GREMION_ROOT}/etc/edge/active.yml"
    # a middleware here would be orphaned on the next switch (spec A section C)
    ! grep -q 'middlewares' "${GREMION_ROOT}/etc/edge/active.yml"
}

@test "gremion-switch records the active colour" {
    shim_edge green
    run "$SWITCH" green
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = "green" ]
}

@test "gremion-switch leaves no temporary file beside active.yml" {
    shim_edge blue
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    run bash -c "ls ${GREMION_ROOT}/etc/edge/ | grep -c tmp || true"
    [[ "$output" == "0" ]]
}

@test "gremion-switch evicts every target with the bearer token and the wildcard body" {
    shim_edge blue
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[
  {"container": "gremion-ui-blue",      "url": "http://gremion-ui-blue:3000/api/internal/evict"},
  {"container": "content-service-blue", "url": "http://content-service-blue:8080/api/internal/evict"}
]
EOF
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    assert_recorded curl "http://gremion-ui-blue:3000/api/internal/evict"
    assert_recorded curl "http://content-service-blue:8080/api/internal/evict"
    assert_recorded curl "Authorization: Bearer push-secret-for-tests"
    assert_recorded curl '{"tenant":"*"}'
}

@test "a target that does not answer 204 aborts the switch and writes no switch file" {
    shim_edge blue
    export EVICT_CODE=500
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue
    [ "$status" -eq 1 ]
    [[ "$output" == *"answered 500, expected 204"* ]]
    [ ! -f "${GREMION_ROOT}/etc/edge/active.yml" ]
    [ ! -f "${GREMION_ROOT}/runtime/active-colour" ]
}

@test "--no-evict skips the fan-out and records the skip" {
    shim_edge blue
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue --no-evict
    [ "$status" -eq 0 ]
    [[ "$output" == *"evict fan-out SKIPPED"* ]]
    ! grep -q 'api/internal/evict' "$SHIM_LOG"
    grep -q 'evict fan-out SKIPPED' "${GREMION_ROOT}/logs/switch.log"
}

@test "a missing evict-targets.json is a precondition failure" {
    shim_edge blue
    rm -f "${GREMION_ROOT}/runtime/evict-targets.json"
    run "$SWITCH" blue
    [ "$status" -eq 2 ]
    [[ "$output" == *"evict targets file missing"* ]]
}

@test "a missing INTERNAL_PUSH_SECRET is a precondition failure" {
    shim_edge blue
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=staging
PLATFORM_DOMAIN=example.org
EOF
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue
    [ "$status" -eq 2 ]
    [[ "$output" == *"INTERNAL_PUSH_SECRET is not set"* ]]
}

@test "the switch fails when traefik never reports the new colour" {
    # the fake traefik is stuck on green while we switch to blue
    shim_edge green
    run "$SWITCH" blue
    [ "$status" -eq 1 ]
    [[ "$output" == *"traefik did not report app@file -> http://gremion-ui-blue:3000"* ]]
    # the file was written (that is what triggers the reload) but the colour was not
    # recorded: a switch that traefik did not pick up is not a completed switch.
    [ -f "${GREMION_ROOT}/etc/edge/active.yml" ]
    [ ! -f "${GREMION_ROOT}/runtime/active-colour" ]
}

@test "the switch fails when the traefik API is unreachable" {
    shim curl 'exit 7'
    run "$SWITCH" blue --no-evict
    [ "$status" -eq 1 ]
    [[ "$output" == *"last: none"* ]]
}

@test "a missing template is a precondition failure that writes no switch file" {
    # active_template_path() dies inside a command substitution, i.e. in a
    # SUBSHELL. If the render were piped straight into atomic_write, that die
    # would end only the subshell and atomic_write would still rename an EMPTY
    # file over active.yml — Traefik would lose app@file entirely. The render is
    # therefore captured BEFORE anything is written.
    shim_edge blue
    local mutilated="${BATS_TEST_TMPDIR}/hostsrc"
    mkdir -p "${mutilated}/bin" "${mutilated}/lib"
    cp "${REPO_ROOT}/infra/host/bin/gremion-switch" "${mutilated}/bin/"
    cp "${REPO_ROOT}/infra/host/lib/common.sh"      "${mutilated}/lib/"
    run "${mutilated}/bin/gremion-switch" blue --no-evict
    [ "$status" -eq 2 ]
    [[ "$output" == *"active.yml.tmpl not found"* ]]
    [ ! -f "${GREMION_ROOT}/etc/edge/active.yml" ]
    [ ! -f "${GREMION_ROOT}/runtime/active-colour" ]
}
