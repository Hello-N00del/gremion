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
# LOW-5: a bearer secret must arrive on stdin (curl -K -); record it apart from argv.
case " \$* " in *" -K - "*) cat >> "\${SHIM_DIR}/curl.stdin" ;; esac
for a in "\$@"; do case "\$a" in http*) url="\$a";; esac; done
case "\$url" in
  */api/http/services/app@file)
      printf '{"loadBalancer":{"servers":[{"url":"http://gremion-ui-${colour}:3000"}]}}' ;;
  */api/internal/evict)
      # EVICT_CODE=unreachable is a target curl cannot connect to: real curl
      # prints the -w code 000 AND exits non-zero (F1-FIX-09, K6#0).
      if [ "\${EVICT_CODE:-204}" = unreachable ]; then printf '000'; exit 7; fi
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

@test "gremion-switch points the panel service at the ACTIVE colour only, with a /healthz probe and no -next twin" {
    shim_edge blue
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    grep -q 'url: "http://control-panel-blue:3000"' "${GREMION_ROOT}/etc/edge/active.yml"
    assert_absent 'control-panel-green' "${GREMION_ROOT}/etc/edge/active.yml"
    [ "$(probe_path panel)" = "/healthz" ]
    assert_absent 'panel-next' "${GREMION_ROOT}/etc/edge/active.yml"
    # a switch to green moves it, and still declares no router for it
    shim_edge green
    run "$SWITCH" green
    [ "$status" -eq 0 ]
    grep -q 'url: "http://control-panel-green:3000"' "${GREMION_ROOT}/etc/edge/active.yml"
    assert_absent 'control-panel-blue' "${GREMION_ROOT}/etc/edge/active.yml"
    assert_absent 'rule:.*control' "${GREMION_ROOT}/etc/edge/active.yml"
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

# probe_path <service> — the healthCheck.path rendered for one file-provider
# service of active.yml (the 4-space-indented key under http.services).
probe_path() {
    awk -v svc="    $1:" '
        $0 == svc { on = 1; next }
        on && /^    [A-Za-z-]+:/ { on = 0 }
        on && /^ *path:/ { sub(/^ *path: */, ""); print; exit }
    ' "${GREMION_ROOT}/etc/edge/active.yml"
}

@test "TASK-023: PUBLIC_BASE_PATH=/portal moves the public and public-next probes to /portal/healthz" {
    shim_edge blue
    printf 'PUBLIC_BASE_PATH=/portal\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    [ "$(probe_path public)" = "/portal/healthz" ]
    [ "$(probe_path public-next)" = "/portal/healthz" ]
    # the app is not mounted under the portal's base path
    [ "$(probe_path app)" = "/healthz" ]
    [ "$(probe_path app-next)" = "/healthz" ]
}

@test "TASK-023: an empty or absent PUBLIC_BASE_PATH probes /healthz on all five services" {
    shim_edge blue
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    for svc in app public panel app-next public-next; do
        [ "$(probe_path "$svc")" = "/healthz" ] || { echo "${svc}: $(probe_path "$svc")"; return 1; }
    done
    printf 'PUBLIC_BASE_PATH=\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    [ "$(probe_path public)" = "/healthz" ]
    [ "$(probe_path public-next)" = "/healthz" ]
}

@test "TASK-023: a malformed PUBLIC_BASE_PATH is a precondition failure that writes no switch file" {
    shim_edge blue
    local bad
    for bad in 'portal' '/portal/' '/a b' '/x"y' '/p:q' '//portal'; do
        rm -f "${GREMION_ROOT}/etc/edge/active.yml"
        run env PUBLIC_BASE_PATH="$bad" "$SWITCH" blue --no-evict
        [ "$status" -eq 2 ] || { echo "accepted: ${bad}"; return 1; }
        [[ "$output" == *"PUBLIC_BASE_PATH"* ]]
        [ ! -f "${GREMION_ROOT}/etc/edge/active.yml" ]
    done
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
    assert_recorded curl '{"tenant":"*"}'
}

@test "LOW-5: the evict bearer secret is on curl's stdin, never on its argv" {
    shim_edge blue
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    assert_absent 'push-secret-for-tests' "$SHIM_LOG" \
        'INTERNAL_PUSH_SECRET reached curl argv (visible in the host process list)'
    grep -Fq 'Authorization: Bearer push-secret-for-tests' "${SHIM_DIR}/curl.stdin"
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

@test "an unreachable evict target is reported as 000, not as 000000, and aborts the switch" {
    shim_edge blue
    export EVICT_CODE=unreachable
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue
    [ "$status" -eq 1 ]
    [[ "$output" == *"answered 000, expected 204"* ]]
    [ ! -f "${GREMION_ROOT}/etc/edge/active.yml" ]
}

@test "--no-evict skips the fan-out and records the skip" {
    shim_edge blue
    cat > "${GREMION_ROOT}/runtime/evict-targets.json" <<'EOF'
[{"container": "gremion-ui-blue", "url": "http://gremion-ui-blue:3000/api/internal/evict"}]
EOF
    run "$SWITCH" blue --no-evict
    [ "$status" -eq 0 ]
    [[ "$output" == *"evict fan-out SKIPPED"* ]]
    assert_absent 'api/internal/evict' "$SHIM_LOG" \
        '--no-evict still POSTed to the eviction endpoint'
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

@test "a switch on an install that opted in renders the control router itself, from current, and says so" {
    shim_edge blue
    printf 'CONTROL_PANEL_ORIGIN=https://control.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"
    shim gremion-render 'printf "http: {}\n" > "$GREMION_ROOT/etc/edge/control-panel.yml"; exit 0'
    run "$SWITCH" blue
    echo "$output"
    [ "$status" -eq 0 ]
    assert_recorded gremion-render "--release ${GREMION_ROOT}/current --control-panel-only"
    [ -s "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    [[ "$output" == *"control router rendered"* ]]
    # the router is there already: nothing is rendered again
    : > "$SHIM_LOG"
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    [ "$(grep -c '^gremion-render ' "$SHIM_LOG" || true)" = "0" ]
}

@test "a switch renders the control router from the release whose template it was handed (gremion-deploy's step 10), not from current" {
    shim_edge blue
    printf 'CONTROL_PANEL_ORIGIN=https://control.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"
    local rel="${GREMION_ROOT}/releases/dist-v9.9.9"
    mkdir -p "${rel}/infra/host/templates/edge"
    cp "${REPO_ROOT}/infra/host/templates/edge/active.yml.tmpl" "${rel}/infra/host/templates/edge/"
    shim gremion-render 'printf "http: {}\n" > "$GREMION_ROOT/etc/edge/control-panel.yml"; exit 0'
    GREMION_EDGE_TEMPLATE="${rel}/infra/host/templates/edge/active.yml.tmpl" run "$SWITCH" blue
    echo "$output"
    [ "$status" -eq 0 ]
    assert_recorded gremion-render "--release ${rel} --control-panel-only"
}

@test "a refused control render does not undo the switch: the colour is live, the refusal and the manual command are named" {
    shim_edge blue
    printf 'CONTROL_PANEL_ORIGIN=https://control.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"
    shim gremion-render 'echo "render: the operator CA is missing" >&2; exit 2'
    run "$SWITCH" blue
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(tr -d '[:space:]' < "${GREMION_ROOT}/runtime/active-colour")" = "blue" ]
    [ ! -e "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    [[ "$output" == *"the control router was not rendered (exit 2)"* ]]
    [[ "$output" == *"gremion-render --release ${GREMION_ROOT}/current --control-panel-only"* ]]
}

@test "a switch on an install that did not opt in renders nothing and says nothing about the control router" {
    shim_edge blue
    shim gremion-render 'exit 0'
    run "$SWITCH" blue
    [ "$status" -eq 0 ]
    [[ "$output" != *"control-panel.yml"* ]]
    [[ "$output" != *"control router"* ]]
    [ "$(grep -c '^gremion-render ' "$SHIM_LOG" || true)" = "0" ]
}

@test "the REAL render behind the real switch: the router comes from the repo's own templates, routes to the panel service the switch wrote, and carries the client-certificate gate" {
    shim_edge blue
    local rel="${GREMION_ROOT}/releases/dist-v9.9.9"
    mkdir -p "$rel"
    make_opted_in_root "$rel" nopanel
    GREMION_EDGE_TEMPLATE="${rel}/infra/host/templates/edge/active.yml.tmpl" run "$SWITCH" blue
    echo "$output"
    [ "$status" -eq 0 ]
    # the switch wrote the panel service from the real template ...
    grep -q 'url: "http://control-panel-blue:3000"' "${GREMION_ROOT}/etc/edge/active.yml"
    # ... and the real render wrote the router that names it
    [[ "$output" == *"control router rendered"* ]]
    [ -s "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    grep -q 'clientAuthType: RequireAndVerifyClientCert' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    grep -qF 'Host(`control.example.org`)' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    grep -q 'service: "panel@file"' "${GREMION_ROOT}/etc/edge/control-panel.yml"
}
