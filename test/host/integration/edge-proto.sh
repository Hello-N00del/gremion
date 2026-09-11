#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box). Not collected by `make test-unit`.
#
# Proves spikes S10 and S11 against a REAL Traefik, and watches four
# gremion-verify guards go RED against the running edge:
#
#   S10       the loopback internaltest entrypoint reaches the INACTIVE colour
#             while the public entrypoint reaches the ACTIVE one, and
#             gremion-switch flips both by rewriting one file.
#   S11       per-tenant file routers stay live and keep their middlewares when
#             the colour containers carry traefik.enable=false — including while a
#             colour container is stopped.
#   pin-red   removing the host-pin middleware makes the two-host universal fail.
#   cert-red  a certificate with 10 days left fails the >20d assertion.
#   acme-red  a hand-written redirect on the web entrypoint turns the ACME probe
#             from 404 into 301.
#   mw-red    a router chaining a middleware nobody declares fails.
#
# VERIFY_MARKER_PATH is /whoami here, not the /healthz default: the stub's
# /whoami echoes the forwarded host, which is the property spec B's real /healthz
# has on a live host and the static stub /healthz does not. Pointing the marker at
# a host-independent body would make the pin drill unfalsifiable — and
# gremion-verify would say so, by failing check_marker_discriminates.
#
# Prints for Task 15's runbook:
#   EDGE-PROTO: s10=ok s11=ok pin-red=ok cert-red=ok acme-red=ok mw-red=ok
#
# Exit codes: 0 ok · 1 an assertion failed · 2 missing precondition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=../../../infra/host/lib/common.sh
. "$REPO_ROOT/infra/host/lib/common.sh"

FIXTURE_DIR="$REPO_ROOT/test/host/fixtures/edge-proto"
PROTO_ROOT="$FIXTURE_DIR/.proto-root"
ENV_FILE="./.proto-root/edge-proto.env"
BIN_DIR="$REPO_ROOT/infra/host/bin"

export GREMION_ROOT="$PROTO_ROOT"
export TRAEFIK_API="http://127.0.0.1:8080"
export INTERNALTEST_PORT="8081"
export VERIFY_MARKER_PATH="/whoami"
export SWITCH_POLL_SECONDS="30"

HOSTS_FILE="$PROTO_ROOT/hosts.txt"
RESULT_S10="fail" RESULT_S11="fail"
RESULT_PIN="fail" RESULT_CERT="fail" RESULT_ACME="fail" RESULT_MW="fail"

compose() { ( cd "$FIXTURE_DIR" && docker compose --env-file "$ENV_FILE" "$@" ); }

cleanup() {
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$PROTO_ROOT"
}
trap cleanup EXIT

need_cmd docker curl jq openssl sha256sum envsubst

prepare_root() {
    rm -rf "$PROTO_ROOT"
    mkdir -p "$PROTO_ROOT"/{etc/env,etc/edge,etc/edge-certs,runtime,logs,bin}
    cp "$FIXTURE_DIR"/dynamic/tenant-a.yml "$PROTO_ROOT/etc/edge/tenant-a.yml"
    cp "$FIXTURE_DIR"/dynamic/tenant-b.yml "$PROTO_ROOT/etc/edge/tenant-b.yml"
    printf 'tenant-a.example.org\ntenant-b.example.org\n' > "$HOSTS_FILE"
    printf '[]\n' > "$PROTO_ROOT/runtime/evict-targets.json"

    cat > "$PROTO_ROOT/etc/env/state.env" <<'EOF'
STACK=edgeproto
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=127.0.0.1
EDGE_HTTP_PORT=8090
EDGE_HTTPS_PORT=8443
HEALTH_EXEMPT_SERVICES=minio-mc
INTERNAL_PUSH_SECRET=proto-not-a-real-secret
VERIFY_MARKER_PATH=/healthz
EOF

    cat > "$PROTO_ROOT/edge-proto.env" <<'EOF'
COMPOSE_PROJECT_NAME=edgeproto
COMPOSE_FILE=docker-compose.yml
EDGE_BIND_IP=127.0.0.1
EDGE_HTTP_PORT=8090
EDGE_HTTPS_PORT=8443
INTERNALTEST_PORT=8081
TRAEFIK_API_PORT=8080
EOF
}

# A self-signed certificate covering both tenants. <days> lets the cert-expiry
# guard be watched RED against the running edge.
make_cert() {
    local days="$1" cfg="$PROTO_ROOT/etc/edge-certs/req.cnf"
    # The subject and the SAN come from a CONFIG FILE, not from `-subj` /
    # `-addext`. In Git Bash the argument `/CN=…` looks like an absolute path and
    # is rewritten to `C:/Program Files/Git/CN=…`; openssl then rejects the
    # subject and produces NO certificate, Traefik falls back to its own default
    # self-signed one, and check_cert fails for a reason that has nothing to do
    # with the spike. Suppressing the rewrite wholesale (MSYS_NO_PATHCONV=1) only
    # moves the problem: the -keyout/-out paths stop being converted and openssl
    # cannot write them either. A config file has no leading-slash argument at
    # all, so it behaves identically here and on Debian.
    cat > "$cfg" <<'EOF'
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[dn]
CN = tenant-a.example.org

[v3]
subjectAltName = DNS:tenant-a.example.org, DNS:tenant-b.example.org
EOF
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$days" \
        -config "$cfg" \
        -keyout "$PROTO_ROOT/etc/edge-certs/proto.key" \
        -out    "$PROTO_ROOT/etc/edge-certs/proto.crt" >/dev/null 2>&1
    cat > "$PROTO_ROOT/etc/edge/tls-proto.yml" <<'EOF'
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/certs/proto.crt
        keyFile: /etc/traefik/certs/proto.key
  certificates:
    - certFile: /etc/traefik/certs/proto.crt
      keyFile: /etc/traefik/certs/proto.key
EOF
}

# Poll Traefik's API until <jq filter> equals <expected>, or fail after 30s.
wait_api() {
    local path="$1" filter="$2" expected="$3" deadline observed=""
    deadline=$(( $(date +%s) + 30 ))
    while [[ "$(date +%s)" -lt "$deadline" ]]; do
        observed="$(curl -fsS --max-time 3 "${TRAEFIK_API}${path}" 2>/dev/null | jq -r "$filter" 2>/dev/null || echo '')"
        [[ "$observed" == "$expected" ]] && return 0
        sleep 1
    done
    bad "traefik ${path} | ${filter} = '${observed}', expected '${expected}'"
    return 1
}

# No `"$@"` pass-through: every call below is bare, and a parameter nothing ever
# supplies is dead weight shellcheck is right to flag (SC2119/SC2120). A drill
# that needs a flag invokes "$BIN_DIR/gremion-verify" directly.
# PRECONDITION, not an assertion about the design.
#
# Traefik's file provider watches its directory with inotify. Docker Desktop's
# Windows bind mounts do not deliver inotify events: files present when the
# container starts ARE read, but a file written afterwards is never noticed. That
# breaks at exactly the point S10 asserts, so without this probe the prototype
# reports "traefik did not report app@file" — a NEGATIVE SPIKE for what is really
# a property of the host. Probe the watch directly and exit 3 (blocked) with a
# message that names the real cause.
assert_file_watch() {
    local probe="$PROTO_ROOT/etc/edge/watch-probe.yml" deadline seen=""
    cat > "$probe" <<'EOF'
http:
  services:
    watchprobe:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9/"
EOF
    deadline=$(( $(date +%s) + 20 ))
    while [[ "$(date +%s)" -lt "$deadline" ]]; do
        seen="$(curl -fsS --max-time 3 "${TRAEFIK_API}/api/http/services/watchprobe@file" 2>/dev/null \
                | jq -r '.name // ""' 2>/dev/null || echo '')"
        [[ -n "$seen" ]] && break
        sleep 1
    done
    rm -f "$probe"
    [[ -n "$seen" ]] \
        || die "BLOCKED: traefik did not notice a file written into its dynamic directory within 20s. The directory is mounted and files present at start-up are loaded, so the switch file itself is fine — this host's filesystem-notification layer does not deliver inotify events into the container (Docker Desktop bind mounts on Windows). Re-run this prototype on a Linux host." 3
    ok "traefik notices new files in its dynamic directory"
}

verify() { "$BIN_DIR/gremion-verify" --hosts "$HOSTS_FILE"; }
switch()  { "$BIN_DIR/gremion-switch" "$@"; }

# ── S10 ──────────────────────────────────────────────────────────────────────
prove_s10() {
    info "S10: public entrypoint serves the ACTIVE colour, internaltest the inactive one"
    switch blue --no-evict
    assert "traefik reports app@file -> blue" \
        wait_api /api/http/services/app@file '.loadBalancer.servers[0].url' 'http://gremion-ui-blue:3000'
    assert "traefik reports app-next@file -> green" \
        wait_api /api/http/services/app-next@file '.loadBalancer.servers[0].url' 'http://gremion-ui-green:3000'

    local public internal
    public="$(curl -k -sS --resolve tenant-a.example.org:8443:127.0.0.1 \
                 https://tenant-a.example.org:8443/whoami)"
    internal="$(curl -sS -H 'Host: tenant-a.example.org' http://127.0.0.1:8081/whoami)"
    [[ "$public"   == *"colour=blue"*  ]] || die "public entrypoint served: ${public}" 1
    [[ "$internal" == *"colour=green"* ]] || die "internaltest served: ${internal}" 1
    ok "public=blue internaltest=green"

    info "S10: flipping the switch file flips both"
    switch green --no-evict
    assert "traefik reports app@file -> green" \
        wait_api /api/http/services/app@file '.loadBalancer.servers[0].url' 'http://gremion-ui-green:3000'
    public="$(curl -k -sS --resolve tenant-a.example.org:8443:127.0.0.1 \
                 https://tenant-a.example.org:8443/whoami)"
    internal="$(curl -sS -H 'Host: tenant-a.example.org' http://127.0.0.1:8081/whoami)"
    [[ "$public"   == *"colour=green"* ]] || die "after switch, public served: ${public}" 1
    [[ "$internal" == *"colour=blue"*  ]] || die "after switch, internaltest served: ${internal}" 1
    ok "public=green internaltest=blue"

    switch blue --no-evict
    assert "switched back to blue" \
        wait_api /api/http/services/app@file '.loadBalancer.servers[0].url' 'http://gremion-ui-blue:3000'
    RESULT_S10="ok"
}

# ── S11 ──────────────────────────────────────────────────────────────────────
prove_s11() {
    info "S11: tenant routers stay live with label-free colour containers"
    assert "tenant-a@file is enabled" \
        wait_api /api/http/routers/tenant-a@file '.status' 'enabled'
    assert "tenant-b@file is enabled" \
        wait_api /api/http/routers/tenant-b@file '.status' 'enabled'
    assert "edge-hostpin-tenant-a is declared on the traefik container" \
        wait_api /api/http/middlewares/edge-hostpin-tenant-a@docker '.status' 'enabled'
    assert "edge-ratelimit is declared on the traefik container" \
        wait_api /api/http/middlewares/edge-ratelimit@docker '.status' 'enabled'
    assert "gremion-verify is green against the running edge" verify

    info "S11: stopping the active colour must not take a tenant router down"
    compose stop stub-blue >/dev/null
    assert "tenant-a@file is still enabled with its colour stopped" \
        wait_api /api/http/routers/tenant-a@file '.status' 'enabled'
    assert "edge-hostpin-tenant-a survives the colour" \
        wait_api /api/http/middlewares/edge-hostpin-tenant-a@docker '.status' 'enabled'
    compose start stub-blue >/dev/null
    # Single quotes deliberate: $0 and $1 are the inner shell's positional
    # parameters, supplied after the script body, not this shell's.
    # shellcheck disable=SC2016
    assert "the colour is back and gremion-verify is green" bash -c '
        for _ in $(seq 30); do "$0" --hosts "$1" && exit 0; sleep 2; done; exit 1
    ' "$BIN_DIR/gremion-verify" "$HOSTS_FILE"
    RESULT_S11="ok"
}

# ── RED drills against the running edge ──────────────────────────────────────
red_pin() {
    info "RED: remove the host pin from tenant-a and watch the two-host universal fail"
    cat > "$PROTO_ROOT/etc/edge/tenant-a.yml" <<'EOF'
http:
  routers:
    tenant-a:
      entryPoints: ["websecure"]
      rule: "Host(`tenant-a.example.org`)"
      service: "app@file"
      priority: 10
      middlewares:
        - "edge-ratelimit@docker"
      tls: {}
EOF
    sleep 3
    if verify > "$PROTO_ROOT/logs/red-pin.log" 2>&1; then
        bad "gremion-verify passed with the host pin removed"
        return 1
    fi
    grep -q 'host-pin: forged X-Forwarded-Host' "$PROTO_ROOT/logs/red-pin.log" \
        || { bad "expected a host-pin failure; got:"; cat "$PROTO_ROOT/logs/red-pin.log"; return 1; }
    ok "host-pin guard went RED"
    cp "$FIXTURE_DIR/dynamic/tenant-a.yml" "$PROTO_ROOT/etc/edge/tenant-a.yml"
    sleep 3
    assert "green again after restoring the pin" verify
    RESULT_PIN="ok"
}

red_cert() {
    info "RED: present a certificate with 10 days left"
    make_cert 10
    sleep 3
    if verify > "$PROTO_ROOT/logs/red-cert.log" 2>&1; then
        bad "gremion-verify passed with a 10-day certificate"
        return 1
    fi
    grep -q 'expires within 20 days' "$PROTO_ROOT/logs/red-cert.log" \
        || { bad "expected a certificate-expiry failure; got:"; cat "$PROTO_ROOT/logs/red-cert.log"; return 1; }
    ok "certificate-expiry guard went RED"
    make_cert 30
    sleep 3
    assert "green again with a 30-day certificate" verify
    RESULT_CERT="ok"
}

red_acme() {
    info "RED: shadow the ACME challenge path with a hand-written redirect"
    cat > "$PROTO_ROOT/etc/edge/redirect-red.yml" <<'EOF'
http:
  middlewares:
    red-to-https:
      redirectScheme:
        scheme: https
        permanent: true
  routers:
    red-catchall:
      entryPoints: ["web"]
      rule: "HostRegexp(`.+`)"
      priority: 100000
      service: "app@file"
      middlewares: ["red-to-https"]
EOF
    sleep 3
    if verify > "$PROTO_ROOT/logs/red-acme.log" 2>&1; then
        bad "gremion-verify passed with the ACME path shadowed"
        return 1
    fi
    grep -qE 'acme-challenge probe for tenant-[ab]\.example\.org returned 30[12]' \
        "$PROTO_ROOT/logs/red-acme.log" \
        || { bad "expected an ACME-path failure; got:"; cat "$PROTO_ROOT/logs/red-acme.log"; return 1; }
    ok "ACME-path guard went RED"
    rm -f "$PROTO_ROOT/etc/edge/redirect-red.yml"
    sleep 3
    assert "green again with the redirect removed" verify
    RESULT_ACME="ok"
}

red_mw() {
    info "RED: chain a middleware nobody declares"
    cat > "$PROTO_ROOT/etc/edge/tenant-b.yml" <<'EOF'
http:
  routers:
    tenant-b:
      entryPoints: ["websecure"]
      rule: "Host(`tenant-b.example.org`)"
      service: "app@file"
      priority: 10
      middlewares:
        - "edge-hostpin-orphan@docker"
      tls: {}
EOF
    sleep 3
    if verify > "$PROTO_ROOT/logs/red-mw.log" 2>&1; then
        bad "gremion-verify passed with an undeclared middleware"
        return 1
    fi
    grep -q 'middleware edge-hostpin-orphan@docker is referenced but absent' \
        "$PROTO_ROOT/logs/red-mw.log" \
        || { bad "expected an absent-middleware failure; got:"; cat "$PROTO_ROOT/logs/red-mw.log"; return 1; }
    ok "absent-middleware guard went RED"
    cp "$FIXTURE_DIR/dynamic/tenant-b.yml" "$PROTO_ROOT/etc/edge/tenant-b.yml"
    sleep 3
    assert "green again after restoring the middleware" verify
    RESULT_MW="ok"
}

main() {
    prepare_root
    make_cert 30
    compose up -d
    # Single quotes deliberate: $0 is the inner shell's first argument.
    # shellcheck disable=SC2016
    assert "traefik answers its API" bash -c '
        for _ in $(seq 60); do curl -fsS --max-time 2 "$0/api/rawdata" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1
    ' "$TRAEFIK_API"
    assert_file_watch

    prove_s10
    prove_s11
    red_pin
    red_cert
    red_acme
    red_mw

    printf 'EDGE-PROTO: s10=%s s11=%s pin-red=%s cert-red=%s acme-red=%s mw-red=%s\n' \
        "$RESULT_S10" "$RESULT_S11" "$RESULT_PIN" "$RESULT_CERT" "$RESULT_ACME" "$RESULT_MW"
}

main "$@"
