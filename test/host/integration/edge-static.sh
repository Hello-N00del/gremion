#!/usr/bin/env bash
#
# INTEGRATION (Docker on this box). Not collected by `make test-unit`.
# Run: make test-edge-static   (or bash test/host/integration/edge-static.sh)
#
# TASK-022's scratch-stack proof of the ACME edge, driven through the REAL
# kernel composition (docker-compose.yml + docker-compose.prod.yml) and the
# committed docker/traefik/traefik.yml, with a scratch ACME CA in place of
# Let's Encrypt:
#
#   health    docker inspect shows the traefik container healthy through the
#             ping entrypoint (:8082), and no published HostIp is 0.0.0.0, ::
#             or empty.
#   api       curl http://127.0.0.1:<api>/api/http/routers answers; the same
#             port on this host's non-loopback address refuses.
#   mount     exactly one mount targets /etc/traefik/dynamic, RW=false.
#   hot       a router file dropped into ${GREMION_ROOT}/etc/edge registers
#             with no restart.
#   issue     a file-provider router with certResolver le-http obtains a
#             certificate from the scratch CA over a REAL HTTP-01 exchange:
#             Pebble resolves the test host through pebble-challtestsrv to the
#             Traefik container and fetches the token from Traefik's :80.
#   renew     with a short certificate validity (Pebble's default profile) and
#             certificatesDuration: 1 in a PROOF-ONLY rendered copy of
#             traefik.yml, the Traefik log shows a renewal and acme.json holds a
#             new serial. The shipped file is never edited.
#   v6        web publishes on EDGE_BIND_IP6=::1 and answers there (on a kernel
#             without IPv6: a residual, see Q6 below).
#
# Everything is scoped to this checkout and commit: project and STACK
# t022-<sha8>, container names ${STACK}-<svc>, a pinned scratch subnet, high
# ports probed free, the external ${STACK}_traefik_acme volume created here, and
# the override, env file and GREMION_ROOT under test-results/ (git-ignored).
# Teardown is `docker rm -f` / `docker volume rm` / `docker network rm` BY
# EXPLICIT NAME. This script never runs `docker compose down` and never prunes.
#
# THE SCRATCH CA. Pebble and pebble-challtestsrv are pinned by digest below.
# Where the registry's blob store is unreachable, the same release is built
# from its Go module instead (go.sum-verified; the module hash is asserted), as
# a scratch-based image with the upstream layout (/app, /test).
#
# Prints for the TASK-038 checklist:
#   EDGE-STATIC: health=ok ports=ok api=ok mount=ok hot=ok issue=ok renew=ok v6=ok
#
# Exit codes: 0 ok · 1 an assertion failed · 2 missing precondition.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

PEBBLE_VERSION="2.10.1"
PEBBLE_IMAGE="ghcr.io/letsencrypt/pebble:${PEBBLE_VERSION}@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199"
CHALLTESTSRV_IMAGE="ghcr.io/letsencrypt/pebble-challtestsrv:${PEBBLE_VERSION}@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b"
# go.sum hash of github.com/letsencrypt/pebble/v2@v${PEBBLE_VERSION}, asserted on the fallback build.
PEBBLE_MODULE_SUM="h1:oKHx3lgN4e5Nno2LKTMrVx+b+NkDptkO9aDireiBDGE="

TEST_HOST="edge-static.test"
HOT_HOST="hot.edge-static.test"
# Pebble's default-profile certificate validity, seconds. Traefik with
# certificatesDuration: 1 renews a certificate once it has less than 20 minutes
# left and checks every minute (measured, see RENEW below), so 21 minutes makes
# the first renewal due about a minute after issuance.
CERT_VALIDITY_SECONDS=1260
HEALTH_SECONDS="${HEALTH_SECONDS:-90}"
ISSUE_SECONDS="${ISSUE_SECONDS:-180}"
RENEW_SECONDS="${RENEW_SECONDS:-420}"

fail_count=0
declare -A RESULT=([health]=fail [ports]=fail [api]=fail [mount]=fail [hot]=fail [issue]=fail [renew]=fail [v6]=fail)
pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*" >&2; fail_count=$((fail_count + 1)); }
precondition() { echo "PRECONDITION: $*" >&2; exit 2; }

for c in docker curl jq openssl git sed awk; do
    command -v "$c" >/dev/null 2>&1 || precondition "missing command: $c"
done
docker compose version >/dev/null 2>&1 || precondition "docker compose plugin missing"

SHA8="$(git rev-parse --short=8 HEAD)"
STACK="t022-${SHA8}"
WORK_REL="test-results/edge-static-${SHA8}"
WORK="${REPO_ROOT}/${WORK_REL}"
ROOT="${WORK}/root"
OVERRIDE_REL="${WORK_REL}/docker-compose.local-edge.yml"
ENV_FILE="${WORK}/state.env"
ACME_VOLUME="${STACK}_traefik_acme"
LOGS_VOLUME="${STACK}_traefik_logs"
NETWORK="${STACK}_net"
C_TRAEFIK="${STACK}-traefik"
C_PROXY="${STACK}-socket-proxy"
C_PEBBLE="${STACK}-pebble"
C_CHALL="${STACK}-challtestsrv"

# A pinned scratch /24, derived from the commit so two checkouts rarely meet;
# refused outright if any docker network already holds it.
OCTET=$(( 16#${SHA8:0:2} % 200 + 20 ))
SUBNET="10.231.${OCTET}.0/24"
IP_TRAEFIK="10.231.${OCTET}.10"
IP_CHALL="10.231.${OCTET}.20"
IP_PEBBLE="10.231.${OCTET}.30"

# ── teardown, by explicit name only ─────────────────────────────────────────
cleanup() {
    local rc=$?
    if [[ "${EDGE_STATIC_KEEP:-0}" != 1 ]]; then
        docker rm -f "$C_TRAEFIK" "$C_PROXY" "$C_PEBBLE" "$C_CHALL" >/dev/null 2>&1 || true
        docker volume rm "$ACME_VOLUME" "$LOGS_VOLUME" >/dev/null 2>&1 || true
        docker network rm "$NETWORK" >/dev/null 2>&1 || true
        rm -rf "$WORK"
    else
        echo "EDGE_STATIC_KEEP=1: left ${STACK} running; remove by name: $C_TRAEFIK $C_PROXY $C_PEBBLE $C_CHALL $ACME_VOLUME $LOGS_VOLUME $NETWORK $WORK" >&2
    fi
    exit "$rc"
}
trap cleanup EXIT

# Leftovers of an interrupted run of THIS commit are removed by name first.
docker rm -f "$C_TRAEFIK" "$C_PROXY" "$C_PEBBLE" "$C_CHALL" >/dev/null 2>&1 || true
docker volume rm "$ACME_VOLUME" "$LOGS_VOLUME" >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true
if docker network ls -q | xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
        | tr ' ' '\n' | grep -qx "$SUBNET"; then
    precondition "scratch subnet ${SUBNET} is already used by another docker network"
fi

# ── ports: allocated, not asserted ──────────────────────────────────────────
port_free() {
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then exec 3<&- 3>&-; return 1; fi
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->" && return 1
    return 0
}
TAKEN=" "
alloc_port() {
    local candidate
    for _ in $(seq 1 200); do
        candidate=$(( 20000 + RANDOM % 10000 ))
        if [[ "$TAKEN" != *" ${candidate} "* ]] && port_free "$candidate"; then
            TAKEN+="${candidate} "
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}
if ! { HTTP_PORT="$(alloc_port)" && HTTPS_PORT="$(alloc_port)" && API_PORT="$(alloc_port)" && IT_PORT="$(alloc_port)"; }; then
    precondition "could not find four free ports in 20000-29999"
fi

# Q6: the v6 publishes bind EDGE_BIND_IP6=::1. A kernel without IPv6 refuses
# that socket outright ("address family not supported by protocol") and the
# whole container fails to start, so on such a box the v6 SLOT of the committed
# port list is fed a second loopback address instead. The committed list is
# still what runs -- only the value changes -- and the v6 result is reported as
# a residual, never as a pass.
if [[ -e /proc/net/if_inet6 ]]; then
    BIND6="::1"
    V6_MODE=ipv6
else
    BIND6="127.0.0.2"
    V6_MODE=absent
fi
echo "  (${STACK}: web=${HTTP_PORT} websecure=${HTTPS_PORT} api=${API_PORT} internaltest=${IT_PORT} subnet=${SUBNET})"

# ── the scratch CA images ───────────────────────────────────────────────────
build_from_module() {
    # <image-tag> <cmd-name>
    local tag="$1" cmd="$2" ctx gobin sum
    command -v go >/dev/null 2>&1 || return 1
    ctx="$(mktemp -d)"
    gobin="${ctx}/bin"
    mkdir -p "$gobin"
    # Checksum database and proxy pinned, whatever the caller's go env says:
    # every dependency is verified against sum.golang.org, not just the main
    # module hash asserted below.
    CGO_ENABLED=0 GOBIN="$gobin" GOFLAGS=-mod=mod GOSUMDB=sum.golang.org GONOSUMDB= GONOSUMCHECK= GOPRIVATE= \
        GOPROXY=https://proxy.golang.org GOINSECURE= go install \
        "github.com/letsencrypt/pebble/v2/cmd/${cmd}@v${PEBBLE_VERSION}" >/dev/null 2>&1 || { rm -rf "$ctx"; return 1; }
    sum="$(go version -m "${gobin}/${cmd}" | awk '$1 == "mod" && $2 == "github.com/letsencrypt/pebble/v2" { print $4 }')"
    if [[ "$sum" != "$PEBBLE_MODULE_SUM" ]]; then
        echo "module hash mismatch for ${cmd}: '${sum}' != '${PEBBLE_MODULE_SUM}'" >&2
        rm -rf "$ctx"
        return 1
    fi
    cp -r "$(go env GOMODCACHE)/github.com/letsencrypt/pebble/v2@v${PEBBLE_VERSION}/test" "${ctx}/test"
    chmod -R u+w "${ctx}/test"
    cp "${gobin}/${cmd}" "${ctx}/app"
    printf 'FROM scratch\nCOPY app /app\nCOPY test /test\nENTRYPOINT ["/app"]\n' > "${ctx}/Dockerfile"
    docker build -q -t "$tag" "$ctx" >/dev/null || { rm -rf "$ctx"; return 1; }
    rm -rf "$ctx"
}
PEBBLE_SOURCE="registry digest"
if ! { docker image inspect "$PEBBLE_IMAGE" >/dev/null 2>&1 || docker pull -q "$PEBBLE_IMAGE" >/dev/null 2>&1; } \
   || ! { docker image inspect "$CHALLTESTSRV_IMAGE" >/dev/null 2>&1 || docker pull -q "$CHALLTESTSRV_IMAGE" >/dev/null 2>&1; }; then
    PEBBLE_IMAGE="t022-pebble-src:${PEBBLE_VERSION}"
    CHALLTESTSRV_IMAGE="t022-challtestsrv-src:${PEBBLE_VERSION}"
    if ! { build_from_module "$PEBBLE_IMAGE" pebble && build_from_module "$CHALLTESTSRV_IMAGE" pebble-challtestsrv; }; then
        precondition "neither the pinned Pebble images nor a build from the Go module (v${PEBBLE_VERSION}) are available"
    fi
    PEBBLE_SOURCE="go module v${PEBBLE_VERSION} ${PEBBLE_MODULE_SUM}"
fi
echo "  (scratch CA: pebble ${PEBBLE_VERSION} from ${PEBBLE_SOURCE})"

# ── the scratch root ────────────────────────────────────────────────────────
rm -rf "$WORK"
mkdir -p "$ROOT/etc/edge" "$WORK/pebble"
# legal/legal.env: created EMPTY if absent and left in place (what ci.yml's
# `touch` leaves), so a concurrent render never loses it mid-run.
mkdir -p legal
[[ -f legal/legal.env ]] || : >> legal/legal.env

# Pebble's own trust root, lifted out of the image so Traefik can trust it via
# LEGO_CA_CERTIFICATES.
cid="$(docker create "$PEBBLE_IMAGE")"
docker cp "${cid}:/test/certs/pebble.minica.pem" "$WORK/pebble/pebble.minica.pem" >/dev/null
docker rm "$cid" >/dev/null

# Pebble validates HTTP-01 against port 80 of whatever challtestsrv resolves
# the host to: Traefik's container, i.e. Traefik's `web` entrypoint.
cat > "$WORK/pebble/pebble-config.json" <<EOF
{
  "pebble": {
    "listenAddress": "0.0.0.0:14000",
    "managementListenAddress": "0.0.0.0:15000",
    "certificate": "/test/certs/localhost/cert.pem",
    "privateKey": "/test/certs/localhost/key.pem",
    "httpPort": 80,
    "tlsPort": 443,
    "ocspResponderURL": "",
    "externalAccountBindingRequired": false,
    "keyAlgorithm": "ecdsa",
    "retryAfter": { "authz": 1, "order": 1 },
    "profiles": {
      "default": { "description": "TASK-022 short-lived", "validityPeriod": ${CERT_VALIDITY_SECONDS} }
    }
  }
}
EOF

# The PROOF-ONLY copy of the committed static file: the shipped file plus
# certificatesDuration: 1 (so Traefik's renewal window is 20 minutes) and an
# INFO log level (so the renewal is logged). Each insertion is asserted; the
# markers stay in place for the container's own start-up render.
PROOF_YML="$WORK/traefik.proof.yml"
grep -q '^log:' docker/traefik/traefik.yml && precondition "docker/traefik/traefik.yml now has a log: block; adjust the proof copy"
sed '/^      caServer: "@ACME_CA_SERVER@"$/a\      certificatesDuration: 1' docker/traefik/traefik.yml > "$PROOF_YML"
printf '\nlog:\n  level: INFO\n' >> "$PROOF_YML"
[[ "$(grep -c '^      certificatesDuration: 1$' "$PROOF_YML")" == 1 ]] \
    || precondition "could not insert certificatesDuration into the proof copy (caServer line moved?)"
if diff <(grep -v -e '^      certificatesDuration: 1$' -e '^log:$' -e '^  level: INFO$' "$PROOF_YML" | sed '/^$/d') \
        <(sed '/^$/d' docker/traefik/traefik.yml) >/dev/null; then :; else
    precondition "the proof copy differs from the shipped file by more than the two proof-only knobs"
fi

# The router that must obtain a certificate, present before Traefik starts.
cat > "$ROOT/etc/edge/issue.yml" <<EOF
http:
  routers:
    edge-static:
      rule: "Host(\`${TEST_HOST}\`)"
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: le-http
EOF

# ── the override and the env file ───────────────────────────────────────────
cat > "$REPO_ROOT/$OVERRIDE_REL" <<EOF
# GENERATED by test/host/integration/edge-static.sh for ${STACK}; removed on exit.
services:
  traefik:
    container_name: ${C_TRAEFIK}
    environment:
      LEGO_CA_CERTIFICATES: /pebble/pebble.minica.pem
    volumes:
      - ${PROOF_YML}:/etc/traefik/traefik.yml:ro
      - ${WORK}/pebble/pebble.minica.pem:/pebble/pebble.minica.pem:ro
    networks:
      gremion-net:
        ipv4_address: ${IP_TRAEFIK}
  docker-socket-proxy:
    container_name: ${C_PROXY}
  pebble:
    profiles: [production]
    image: ${PEBBLE_IMAGE}
    container_name: ${C_PEBBLE}
    command: ["-config", "/t022/pebble-config.json", "-dnsserver", "${IP_CHALL}:8053"]
    environment:
      PEBBLE_VA_NOSLEEP: "1"
      PEBBLE_WFE_NONCEREJECT: "0"
      PEBBLE_AUTHZREUSE: "0"
    volumes:
      - ${WORK}/pebble/pebble-config.json:/t022/pebble-config.json:ro
    networks:
      gremion-net:
        ipv4_address: ${IP_PEBBLE}
  challtestsrv:
    profiles: [production]
    image: ${CHALLTESTSRV_IMAGE}
    container_name: ${C_CHALL}
    command: ["-defaultIPv4", "${IP_TRAEFIK}", "-defaultIPv6", "", "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", ""]
    networks:
      gremion-net:
        ipv4_address: ${IP_CHALL}
volumes:
  traefik-logs:
    name: ${LOGS_VOLUME}
networks:
  gremion-net:
    name: ${NETWORK}
    ipam:
      config:
        - subnet: ${SUBNET}
EOF

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=${STACK}
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:${OVERRIDE_REL}
COMPOSE_PATH_SEPARATOR=:
COMPOSE_PROFILES=production
STACK=${STACK}
GREMION_ROOT=${ROOT}
DOMAIN=example.org
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=${BIND6}
EDGE_HTTP_PORT=${HTTP_PORT}
EDGE_HTTPS_PORT=${HTTPS_PORT}
TRAEFIK_API_PORT=${API_PORT}
INTERNALTEST_PORT=${IT_PORT}
EDGE_V4_SUBNET=${SUBNET}
EDGE_V6_SUBNET=fd5a:90::/64
ACME_EMAIL=edge-static@example.org
ACME_CA_SERVER=https://pebble:14000/dir
TRAEFIK_CERT_RESOLVER=le-http
EOF

compose() {
    env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
        docker compose --env-file "$ENV_FILE" "$@"
}

# ── bring up ONLY the four services; the ACME volume exists first ───────────
docker volume create "$ACME_VOLUME" >/dev/null
compose up -d pebble challtestsrv >/dev/null 2>"$WORK/up-ca.err" \
    || { cat "$WORK/up-ca.err" >&2; precondition "the scratch CA did not start"; }
ca_ready=false
for _ in $(seq 1 30); do
    if docker logs "$C_PEBBLE" 2>&1 | grep -q "ACME directory available"; then ca_ready=true; break; fi
    sleep 1
done
[[ "$ca_ready" == true ]] || { docker logs "$C_PEBBLE" 2>&1 | tail -20 >&2; precondition "Pebble never announced its directory"; }
compose up -d traefik docker-socket-proxy >/dev/null 2>"$WORK/up-edge.err" \
    || { cat "$WORK/up-edge.err" >&2; fail "compose could not start traefik"; exit 1; }
STARTED_AT="$(docker inspect -f '{{.State.StartedAt}}' "$C_TRAEFIK")"

echo "HEALTH — the ping healthcheck, and no wildcard publish"
health=""
for _ in $(seq 1 "$HEALTH_SECONDS"); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$C_TRAEFIK" 2>/dev/null || true)"
    [[ "$health" == healthy ]] && break
    [[ "$(docker inspect -f '{{.State.Running}}' "$C_TRAEFIK" 2>/dev/null)" == true ]] || break
    sleep 1
done
probe="$(docker inspect -f '{{range .Config.Healthcheck.Test}}{{.}} {{end}}' "$C_TRAEFIK")"
if [[ "$health" == healthy && "$probe" == *"127.0.0.1:8082/ping"* ]]; then
    pass "traefik is healthy through ${probe% }"
    RESULT[health]=ok
else
    fail "traefik health=${health:-<none>} probe='${probe}'"
    docker logs --tail 30 "$C_TRAEFIK" 2>&1 | sed 's/^/        /' >&2
fi
host_ips="$(docker inspect "$C_TRAEFIK" | jq -r '.[0].NetworkSettings.Ports | to_entries[] | select(.value != null) | .value[] | "\(.HostIp)|\(.HostPort)"')"
while IFS= read -r l; do echo "        HostIp|HostPort ${l}"; done <<<"$host_ips"
if [[ -n "$host_ips" ]] && ! grep -qE '^(0\.0\.0\.0|::|\[::\]|)\|' <<<"$host_ips"; then
    pass "no published HostIp is 0.0.0.0, :: or empty"
    RESULT[ports]=ok
else
    fail "a publish binds every interface, or nothing is published"
fi
if ! grep -q "|8082$" <<<"$host_ips" && [[ "$(docker inspect "$C_TRAEFIK" | jq -r '.[0].NetworkSettings.Ports["8082/tcp"] // "none"')" == none ]]; then
    pass "the ping entrypoint (:8082) is not published"
else
    fail "the ping entrypoint is published"
    RESULT[ports]=fail
fi
echo ""

echo "API — loopback answers, the host's other address refuses"
api_ok=false
for _ in $(seq 1 20); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/api/http/routers" -o "$WORK/routers.json" 2>/dev/null; then api_ok=true; break; fi
    sleep 1
done
# This host's first non-loopback IPv4 address: `ip` where installed, else
# `hostname -I`. Neither is load-bearing on its own, so neither may abort.
PUBLIC_IP="$({ ip -4 -o addr show scope global 2>/dev/null || true; } | awk '{ split($4, a, "/"); print a[1]; exit }')"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$({ hostname -I 2>/dev/null || true; } | awk '{ print $1 }')"
if [[ "$api_ok" == true ]] && jq -e 'type == "array"' "$WORK/routers.json" >/dev/null; then
    pass "curl http://127.0.0.1:${API_PORT}/api/http/routers answers ($(jq length "$WORK/routers.json") routers)"
    if [[ -z "$PUBLIC_IP" ]]; then
        fail "this host has no non-loopback IPv4 address to probe the refusal on"
    else
        set +e
        curl -sS --max-time 3 "http://${PUBLIC_IP}:${API_PORT}/api/http/routers" -o /dev/null 2>"$WORK/public.err"
        rc_api=$?
        curl -sS --max-time 3 "http://${PUBLIC_IP}:${IT_PORT}/" -o /dev/null 2>/dev/null
        rc_it=$?
        set -e
        # 7 = could not connect. Anything else (a response, a timeout) is not the
        # refusal the post-condition names.
        if [[ "$rc_api" -eq 7 && "$rc_it" -eq 7 ]]; then
            pass "the host's non-loopback address refuses the API and internaltest ports (curl exit 7)"
            RESULT[api]=ok
        else
            fail "the host's non-loopback address did not refuse: api curl exit ${rc_api}, internaltest curl exit ${rc_it}"
        fi
    fi
else
    fail "the API did not answer on 127.0.0.1:${API_PORT}"
fi
echo ""

echo "MOUNT — one read-only /etc/traefik/dynamic"
mounts="$(docker inspect "$C_TRAEFIK" | jq -c '[.[0].Mounts[] | select(.Destination == "/etc/traefik/dynamic") | {Source, RW}]')"
echo "        ${mounts}"
if [[ "$(jq length <<<"$mounts")" == 1 && "$(jq -r '.[0].RW' <<<"$mounts")" == false \
      && "$(jq -r '.[0].Source' <<<"$mounts")" == "${ROOT}/etc/edge" ]]; then
    if docker exec "$C_TRAEFIK" touch /etc/traefik/dynamic/probe-write >/dev/null 2>&1; then
        fail "the container could write into /etc/traefik/dynamic"
    else
        pass "exactly one mount targets /etc/traefik/dynamic, RW=false, and a write from inside is refused"
        RESULT[mount]=ok
    fi
else
    fail "the /etc/traefik/dynamic mounts are not exactly one read-only ${ROOT}/etc/edge"
fi
echo ""

echo "HOT — a router file dropped into etc/edge registers with no restart"
cat > "$ROOT/etc/edge/hot.yml" <<EOF
http:
  routers:
    hot-probe:
      rule: "Host(\`${HOT_HOST}\`)"
      entryPoints: [websecure]
      service: noop@internal
EOF
hot=false
for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/api/http/routers" 2>/dev/null | jq -e 'any(.[]; .name == "hot-probe@file")' >/dev/null; then
        hot=true; break
    fi
    sleep 1
done
restarts="$(docker inspect -f '{{.RestartCount}}' "$C_TRAEFIK")"
if [[ "$hot" == true && "$(docker inspect -f '{{.State.StartedAt}}' "$C_TRAEFIK")" == "$STARTED_AT" && "$restarts" == 0 ]]; then
    pass "hot-probe@file registered; StartedAt unchanged, RestartCount 0"
    RESULT[hot]=ok
else
    fail "hot reload: registered=${hot} restarts=${restarts}"
fi
echo ""

acme_serial() {
    docker exec "$C_TRAEFIK" cat /letsencrypt/acme.json 2>/dev/null \
        | jq -r --arg h "$TEST_HOST" '.["le-http"].Certificates // [] | map(select(.domain.main == $h)) | .[0].certificate // empty' \
        | base64 -d 2>/dev/null | openssl x509 -noout -serial 2>/dev/null | sed 's/^serial=//'
}
served() {
    openssl s_client -connect "127.0.0.1:${HTTPS_PORT}" -servername "$TEST_HOST" </dev/null 2>/dev/null \
        | openssl x509 -noout "$@" 2>/dev/null
}

echo "ISSUE — le-http obtains a certificate from the scratch CA over HTTP-01"
serial1=""
for _ in $(seq 1 "$ISSUE_SECONDS"); do
    serial1="$(acme_serial || true)"
    [[ -n "$serial1" ]] && break
    sleep 1
done
issuer="$(served -issuer || true)"
echo "        acme.json serial: ${serial1:-<none>}"
echo "        served ${issuer:-<no certificate>}"
if [[ -n "$serial1" && "$issuer" == *Pebble* ]]; then
    pass "a certificate for ${TEST_HOST} is in acme.json and is served, issued by the scratch CA"
    RESULT[issue]=ok
else
    fail "no certificate for ${TEST_HOST} was obtained; last Traefik log lines follow"
    docker logs --tail 30 "$C_TRAEFIK" 2>&1 | sed 's/^/        /' >&2
fi
# The exchange was a REAL HTTP-01: Pebble fetched the token from the test host
# (resolved by challtestsrv to Traefik) and marked the authorization valid. No
# always-valid shortcut is configured (PEBBLE_VA_ALWAYS_VALID is unset).
pebble_log="$(docker logs "$C_PEBBLE" 2>&1)"
if grep -q "Attempting to validate w/ HTTP: http://${TEST_HOST}:80/.well-known/acme-challenge/" <<<"$pebble_log" \
   && grep -q "set VALID by completed challenge" <<<"$pebble_log" \
   && ! docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C_PEBBLE" | grep -q '^PEBBLE_VA_ALWAYS_VALID='; then
    pass "Pebble fetched the HTTP-01 token from Traefik's :80 and validated it (no always-valid shortcut)"
else
    fail "Pebble's log shows no completed HTTP-01 validation of ${TEST_HOST}"
    RESULT[issue]=fail
fi
echo ""

echo "RENEW — a short validity is renewed: a log line and a new serial"
serial2=""
if [[ -n "$serial1" ]]; then
    for _ in $(seq 1 "$RENEW_SECONDS"); do
        serial2="$(acme_serial || true)"
        [[ -n "$serial2" && "$serial2" != "$serial1" ]] && break
        sleep 1
    done
fi
# Traefik v3.7.1 logs "Renewing ACME certificate: {Main:<host> ...}" at INFO,
# which only the proof copy's log level makes visible.
renew_line="$(docker logs "$C_TRAEFIK" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -m1 "Renewing ACME certificate: {Main:${TEST_HOST}" || true)"
# Authorization reuse is off (PEBBLE_AUTHZREUSE=0), so the renewal order had
# to pass HTTP-01 again: two completed validations, not one.
valid_count="$(docker logs "$C_PEBBLE" 2>&1 | grep -c "set VALID by completed challenge" || true)"
echo "        serial ${serial1:-<none>} -> ${serial2:-<none>}"
echo "        log: ${renew_line:-<no renewal line>}"
echo "        completed HTTP-01 validations: ${valid_count}"
if [[ -n "$serial2" && "$serial2" != "$serial1" && -n "$renew_line" && "$valid_count" -ge 2 ]]; then
    pass "Traefik logged a renewal, acme.json holds a new serial, and the renewal re-passed HTTP-01"
    RESULT[renew]=ok
else
    fail "no renewal within ${RENEW_SECONDS}s"
fi
echo ""

echo "V6 — web publishes on EDGE_BIND_IP6 (${BIND6})"
if [[ "$V6_MODE" == ipv6 ]]; then
    v6_code="$(curl -g -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${TEST_HOST}" "http://[::1]:${HTTP_PORT}/anything" || true)"
else
    v6_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${TEST_HOST}" "http://${BIND6}:${HTTP_PORT}/anything" || true)"
fi
v6_published="$(grep -cx "${BIND6}|${HTTP_PORT}" <<<"$host_ips" || true)"
if [[ "$v6_published" == 1 && "$v6_code" == 301 ]]; then
    if [[ "$V6_MODE" == ipv6 ]]; then
        pass "[::1]:${HTTP_PORT} is published and answers the redirect (301)"
        RESULT[v6]=ok
    else
        echo "  RESIDUAL  this kernel has no IPv6 (/proc/net/if_inet6 absent): the committed v6 publish slot was bound to ${BIND6} and answered 301; [::1] itself is unproven here"
        RESULT[v6]=residual
    fi
else
    fail "v6 slot ${BIND6}:${HTTP_PORT}: published=${v6_published} answer=${v6_code}"
fi
echo ""

echo "EDGE-STATIC: health=${RESULT[health]} ports=${RESULT[ports]} api=${RESULT[api]} mount=${RESULT[mount]} hot=${RESULT[hot]} issue=${RESULT[issue]} renew=${RESULT[renew]} v6=${RESULT[v6]}"
if [[ $fail_count -ne 0 ]]; then
    echo "edge-static: ${fail_count} check(s) FAILED" >&2
    exit 1
fi
echo "edge-static: all checks hold (scratch CA: pebble ${PEBBLE_VERSION}, ${PEBBLE_SOURCE})"
