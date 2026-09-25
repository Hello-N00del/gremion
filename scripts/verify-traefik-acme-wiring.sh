#!/usr/bin/env bash
# ============================================================
# Mechanism proof for the ACME edge (TASK-022; ported from the StuRa tree's
# T04 proof, spec B "Edge" §2).
#
# Usage:  bash scripts/verify-traefik-acme-wiring.sh
#
# docker/traefik/traefik.yml and the traefik service in docker-compose.yml
# rest on three claims about Traefik that documentation states and nobody
# had watched, plus two claims about OUR wiring. This script watches all
# five against the image the stack pins, and exits non-zero if any of them
# stops being true. Claims 1-4 talk to no CA and need no DNS: the resolver
# points at an unreachable caServer on purpose, because none of them is about
# issuance (test/host/integration/edge-static.sh proves issuance and renewal
# against a scratch CA).
#
#   CLAIM 1  A router that terminates TLS does NOT inherit the entrypoint's
#            certResolver. If TRUE -- and it is -- a router missing its own
#            resolver silently serves the default certificate.
#            Proof: two routers on the same entrypoint, one with `tls: {}` and
#            one with no `tls` key at all, read back from /api/rawdata.
#
#   CLAIM 2  The `web` -> `websecure` redirection does NOT capture
#            /.well-known/acme-challenge/. If FALSE, HTTP-01 can never
#            complete and first issuance deadlocks.
#            Proof: two live requests on :80.
#
#   CLAIM 3  With --configFile, Traefik ignores CLI flags (and, by the same
#            mutual exclusion, TRAEFIK_* env), and performs no ${} expansion in
#            the file. This is WHY docker/traefik/traefik.yml carries @MARKER@s
#            that the compose command substitutes, instead of reading env vars
#            Traefik never sees.
#            Proof: a resolver defined ONLY on the command line, and a static
#            value written ONLY as ${VAR}.
#
#   CLAIM 4  The COMMITTED traefik.yml, run by the command compose RENDERS for
#            the production composition, loads: the ACME address comes from
#            the environment, the le-http resolver is accepted, and the
#            conditional ACME_EMAIL guard refuses (resolver set, no email) and
#            admits (no resolver, no email) -- both sides measured.
#
#   CLAIM 5  All FOUR markers survive nowhere: the committed file carries
#            exactly @ACME_EMAIL@ @ACME_CA_SERVER@ @EDGE_V4_SUBNET@
#            @EDGE_V6_SUBNET@, and the rendered command substitutes each with
#            the environment's value. Non-vacuous by construction: the same
#            check is run once per marker with that marker's `-e` expression
#            cut out of the command, and must go RED every time.
#
# Every assertion below is a POST-CONDITION read back out of a running
# container or a rendered file. No step is asserted by its exit code.
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# The image the stack pins. Read from compose so this proof can never drift on
# to a version the stack does not run.
IMAGE="$(grep -oE 'image: traefik:v[0-9.]+' docker-compose.yml | head -n1 | sed 's/image: //')"
if [[ -z "$IMAGE" ]]; then
    echo "FAIL: could not read the pinned Traefik image out of docker-compose.yml" >&2
    exit 1
fi

WORK="$(mktemp -d)"

# Docker takes HOST paths for a bind mount. Under Git Bash / MSYS the shell's
# own /tmp/... is not a path the Windows Docker daemon can resolve — it silently
# creates a DIRECTORY at the mount point instead, and Traefik then fails with
# "read /etc/traefik/traefik.yml: is a directory". Translate once here; a no-op
# on Linux, which is where this runs in CI and on the target host.
host_path() {
    if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
WORK_HOST="$(host_path "$WORK")"
NAME_A="traefik-acme-proof-a-$$"
NAME_B="traefik-acme-proof-b-$$"

# Ports are ALLOCATED, not asserted (T04 round 2). They used to be the literals
# 18470/18471 with no probe and no fallback, so a second concurrent invocation —
# including this script's own leftover containers — made docker fail the RUN with
#   Bind for 127.0.0.1:18470 failed: port is already allocated
# and the script exited 125. That is a docker-level failure wearing the costume
# of a proof result, which is the exact opposite of this script's own rule that
# no step is asserted by its exit code: claims 1-3 were never evaluated at all.
#
# A port is PROBED from a random offset in a fixed mid-range band, not taken
# from the kernel's ephemeral range.
#
# Binding :0 and reading back the assignment is the usual trick and it does not
# work here: on Windows the ephemeral range overlaps WinNAT's reserved
# exclusions, so docker accepts the publish and the port then never answers —
# measured, `-p 127.0.0.1:56107:80` bound cleanly and every curl to it failed,
# which is the same silent-success failure this script exists to avoid.
#
# 20000-29999 sits below the ephemeral range on both Linux and Windows. The
# offset is randomised so two concurrent invocations do not converge on the same
# first candidate, which is what made the old literals collide.
port_free() {
    # No `ss`/`netstat` dependency: ask docker, which is the only thing that
    # will actually contend for the port here, plus a direct connect attempt.
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
        exec 3<&- 3>&-
        return 1
    fi
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->" && return 1
    return 0
}
alloc_port() {
    local candidate
    for _ in $(seq 1 200); do
        candidate=$(( 20000 + RANDOM % 10000 ))
        if [[ "$candidate" != "${1:-}" ]] && port_free "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}
if ! WEB_PORT="$(alloc_port)" || ! API_PORT="$(alloc_port "$WEB_PORT")"; then
    echo "FATAL: could not find two free ports in 20000-29999 after 200 attempts." >&2
    exit 2
fi
echo "  (allocated ports: web=${WEB_PORT} api=${API_PORT})"
failures=0

cleanup() {
    docker rm -f "$NAME_A" "$NAME_B" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*" >&2; failures=$((failures + 1)); }

echo "Traefik ACME wiring proof — image: ${IMAGE}"
echo ""

# ------------------------------------------------------------
# Fixture A — the real shape: web+websecure, entrypoint resolver, HTTP-01.
# ------------------------------------------------------------
mkdir -p "$WORK/dyn"
cat > "$WORK/traefik.yml" <<'YAML'
api:
  insecure: true
  dashboard: false
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: le-http
certificatesResolvers:
  le-http:
    acme:
      email: "proof@example.org"
      storage: /tmp/acme.json
      # Deliberately unreachable: this proof is about wiring, not issuance.
      caServer: "https://127.0.0.1:1/directory"
      httpChallenge:
        entryPoint: web
providers:
  file:
    directory: /etc/traefik/dyn
    watch: false
log:
  level: INFO
YAML

cat > "$WORK/dyn/probe.yml" <<'YAML'
http:
  routers:
    # The shape a `traefik.http.routers.X.tls=true` docker label produces.
    probe-tlsempty:
      rule: "Host(`a.example.org`)"
      entryPoints: [websecure]
      service: noop
      tls: {}
    # Control: no tls key at all, so Traefik's TLS is nil for this router.
    probe-notls:
      rule: "Host(`b.example.org`)"
      entryPoints: [websecure]
      service: noop
  services:
    noop:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9"
YAML

docker rm -f "$NAME_A" >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name "$NAME_A" \
    -p "127.0.0.1:${WEB_PORT}:80" \
    -p "127.0.0.1:${API_PORT}:8080" \
    -v "$WORK_HOST/traefik.yml:/etc/traefik/traefik.yml:ro" \
    -v "$WORK_HOST/dyn:/etc/traefik/dyn:ro" \
    "$IMAGE" --configFile=/etc/traefik/traefik.yml >/dev/null

# Wait for the API to answer rather than sleeping a guessed interval.
for _ in $(seq 1 30); do
    if curl -sf -o "$WORK/rawdata.json" "http://127.0.0.1:${API_PORT}/api/rawdata"; then break; fi
    sleep 1
done
if [[ ! -s "$WORK/rawdata.json" ]]; then
    echo "FAIL: Traefik API never answered; container logs follow" >&2
    docker logs "$NAME_A" >&2 || true
    exit 1
fi

echo "CLAIM 1 — a tls=true router does not inherit the entrypoint resolver"
inherited_empty="$(node -e '
  const d = require(process.argv[1]);
  const r = d.routers["probe-tlsempty@file"];
  process.stdout.write(!r ? "<missing>" : r.tls && r.tls.certResolver ? r.tls.certResolver : "<none>");
' "$WORK/rawdata.json")"
inherited_none="$(node -e '
  const d = require(process.argv[1]);
  const r = d.routers["probe-notls@file"];
  process.stdout.write(!r ? "<missing>" : r.tls && r.tls.certResolver ? r.tls.certResolver : "<none>");
' "$WORK/rawdata.json")"

echo "        router with tls: {}   -> certResolver = ${inherited_empty}"
echo "        router with no tls    -> certResolver = ${inherited_none}"
# A router that never loaded reads as "<missing>", never as "<none>": without
# this, a fixture Traefik did not load would PASS claim 1 vacuously.
if [[ "$inherited_empty" == "<missing>" || "$inherited_none" == "<missing>" ]]; then
    fail "a probe router did not load (tls={}: ${inherited_empty}, no tls: ${inherited_none}) -- claim 1 proves nothing"
elif [[ "$inherited_empty" == "<none>" ]]; then
    pass "tls={} opts OUT of the entrypoint resolver — every router needs its own certresolver label"
else
    fail "tls={} INHERITED '${inherited_empty}' — the per-router labels may no longer be required; re-derive before trusting them"
fi
if [[ "$inherited_none" == "le-http" ]]; then
    pass "the control router DID inherit — the entrypoint resolver is genuinely configured, so claim 1 is not a false negative"
else
    fail "the control router did not inherit either (got '${inherited_none}') — the fixture is broken, claim 1 proves nothing"
fi
echo ""

echo "CLAIM 2 — the HTTPS redirect does not capture the ACME challenge"
challenge_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: a.example.org' \
    "http://127.0.0.1:${WEB_PORT}/.well-known/acme-challenge/proof-token")"
challenge_redirect="$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Host: a.example.org' \
    "http://127.0.0.1:${WEB_PORT}/.well-known/acme-challenge/proof-token")"
ordinary_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: a.example.org' \
    "http://127.0.0.1:${WEB_PORT}/anything")"
ordinary_redirect="$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Host: a.example.org' \
    "http://127.0.0.1:${WEB_PORT}/anything")"

echo "        /.well-known/acme-challenge/proof-token -> ${challenge_code} ${challenge_redirect:-(no redirect)}"
echo "        /anything                               -> ${ordinary_code} ${ordinary_redirect:-(no redirect)}"
# 404 is the challenge handler answering for a token it never issued. Any 3xx
# means the redirect swallowed the challenge and HTTP-01 can never complete.
if [[ "$challenge_code" =~ ^3 ]]; then
    fail "the ACME challenge path was REDIRECTED (${challenge_code}) — HTTP-01 issuance would deadlock"
else
    pass "the challenge path is served, not redirected (${challenge_code})"
fi
if [[ "$ordinary_code" == "301" ]]; then
    pass "an ordinary path IS redirected to ${ordinary_redirect} — the redirect is on, so claim 2 is not a false negative"
else
    fail "an ordinary path was not redirected (${ordinary_code}) — the fixture is broken, claim 2 proves nothing"
fi
echo ""

# ------------------------------------------------------------
# Fixture B — the static-configuration source rules.
# ------------------------------------------------------------
echo "CLAIM 3 — with --configFile, CLI flags are ignored and \${} is not expanded"
cat > "$WORK/traefik-nores.yml" <<'YAML'
api:
  insecure: false
  dashboard: false
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
providers:
  file:
    directory: /etc/traefik/dyn2
    watch: false
log:
  level: "${PROOF_LOG_LEVEL}"
YAML

mkdir -p "$WORK/dyn2"
cat > "$WORK/dyn2/probe.yml" <<'YAML'
http:
  routers:
    probe-cliresolver:
      rule: "Host(`c.example.org`)"
      entryPoints: [websecure]
      service: noop
      tls:
        certResolver: le-http
  services:
    noop:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9"
YAML

docker rm -f "$NAME_B" >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --name "$NAME_B" \
    -e PROOF_LOG_LEVEL=DEBUG \
    -v "$WORK_HOST/traefik-nores.yml:/etc/traefik/traefik.yml:ro" \
    -v "$WORK_HOST/dyn2:/etc/traefik/dyn2:ro" \
    "$IMAGE" --configFile=/etc/traefik/traefik.yml \
    --certificatesresolvers.le-http.acme.email=cli@example.org \
    --certificatesresolvers.le-http.acme.storage=/tmp/acme.json \
    --certificatesresolvers.le-http.acme.httpchallenge.entrypoint=web >/dev/null

for _ in $(seq 1 30); do
    docker logs "$NAME_B" > "$WORK/logs-b.txt" 2>&1 || true
    if grep -q "certificate resolver\|Configuration loaded\|log level" "$WORK/logs-b.txt"; then break; fi
    sleep 1
done
docker logs "$NAME_B" > "$WORK/logs-b.txt" 2>&1 || true

if grep -q "nonexistent certificate resolver" "$WORK/logs-b.txt"; then
    pass "a resolver defined only on the CLI does not exist -> CLI flags are IGNORED alongside --configFile"
    grep -o "Router uses a nonexistent certificate resolver.*" "$WORK/logs-b.txt" | head -n1 | sed 's/^/        /'
else
    fail "the CLI-defined resolver was accepted — static-config precedence changed; the @ACME_EMAIL@ marker may no longer be necessary"
fi

if grep -qi 'Unknown Level String' "$WORK/logs-b.txt"; then
    pass "\${PROOF_LOG_LEVEL} was taken LITERALLY -> the static file performs no environment expansion"
    grep -o "Unknown Level String[^\"]*" "$WORK/logs-b.txt" | head -n1 | sed 's/^/        /'
else
    fail "\${PROOF_LOG_LEVEL} appears to have been expanded — re-derive how the ACME email should reach Traefik"
fi
echo ""


# ------------------------------------------------------------
# Fixture C — the REAL committed config, run by the command compose RENDERS.
# ------------------------------------------------------------
# Claims 1-3 are about Traefik. Claims 4 and 5 are about OUR wiring. The
# command is read OUT OF THE RENDER of the production composition -- the same
# `docker compose --env-file <state.env> config` the host runs, with the fixed
# fixture scripts/check-compose-edge.test.mjs renders -- rather than retyped,
# so this proof cannot drift away from what compose runs.
FIXTURE_ENV="test/host/fixtures/edge-render/state.env"

# The kernel composition's `legal` service names the git-ignored
# legal/legal.env; compose refuses to render without it. Created EMPTY only if
# absent and left in place (what ci.yml's `touch` leaves): removing it again
# would race any concurrent render that saw it present.
mkdir -p legal
[[ -f legal/legal.env ]] || : >> legal/legal.env
NAME_C="traefik-acme-proof-c-$$"
NAME_D="traefik-acme-proof-d-$$"
cleanup_all() {
    cleanup
    docker rm -f "$NAME_C" "$NAME_D" >/dev/null 2>&1 || true
}
trap cleanup_all EXIT

# A scrubbed environment, as in the render guard: a shell variable outranks
# --env-file, and this proof must measure the repository, not the caller.
TRAEFIK_CMD=""
if env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
        ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
        ${DOCKER_CERT_PATH:+DOCKER_CERT_PATH="$DOCKER_CERT_PATH"} ${DOCKER_TLS_VERIFY:+DOCKER_TLS_VERIFY="$DOCKER_TLS_VERIFY"} \
        docker compose --env-file "$FIXTURE_ENV" config --format json \
        > "$WORK/render.json" 2>"$WORK/render.err"; then
    # compose config re-escapes a literal $ as $$; the container sees one.
    TRAEFIK_CMD="$(node -e '
      const c = require(process.argv[1]).services?.traefik
      if (!c) { console.error("no traefik service in the render"); process.exit(1) }
      const ep = [].concat(c.entrypoint ?? [])
      const cmd = [].concat(c.command ?? [])
      if (ep.join(" ") !== "/bin/sh -c" || cmd.length !== 1) {
        console.error("traefik is not started as /bin/sh -c <one script>: " + JSON.stringify({ ep, cmd }))
        process.exit(1)
      }
      if (c.image !== process.argv[2]) {
        console.error("the render runs " + c.image + " but this proof measures " + process.argv[2])
        process.exit(1)
      }
      process.stdout.write(cmd[0].replace(/\$\$/g, "$"))
    ' "$WORK/render.json" "$IMAGE")" || TRAEFIK_CMD=""
else
    cat "$WORK/render.err" >&2
fi

echo "CLAIM 4 — the committed traefik.yml, run by the rendered compose command, loads"
if [[ -z "$TRAEFIK_CMD" ]]; then
    fail "could not read the traefik command out of the production render; claims 4 and 5 cannot run"
else
    PROOF_EMAIL="acme-proof@example.org"
    PROOF_CA="https://127.0.0.1:1/directory"
    PROOF_V4="10.99.4.0/24"
    PROOF_V6="fd5a:94::/64"
    # /letsencrypt is the external ACME volume on the real stack. Traefik does
    # NOT create it: without it the resolver is dropped ("unable to get ACME
    # account") and no certificate is ever requested -- reproduce it here.
    mkdir -p "$WORK/letsencrypt" "$WORK/dynamic"
    # A router that NAMES le-http, so the resolver's acceptance is read back
    # positively from the API, not inferred from the absence of a log line.
    cat > "$WORK/dynamic/claim4.yml" <<'YAML'
http:
  routers:
    claim4-probe:
      rule: "Host(`claim4.example.org`)"
      entryPoints: [websecure]
      service: noop@internal
      tls:
        certResolver: le-http
YAML
    MSYS_NO_PATHCONV=1 docker run -d --name "$NAME_C" \
        -e "ACME_EMAIL=${PROOF_EMAIL}" \
        -e "TRAEFIK_CERT_RESOLVER=le-http" \
        -e "ACME_CA_SERVER=${PROOF_CA}" \
        -e "EDGE_V4_SUBNET=${PROOF_V4}" \
        -e "EDGE_V6_SUBNET=${PROOF_V6}" \
        -v "$(host_path "$PWD")/docker/traefik/traefik.yml:/etc/traefik/traefik.yml:ro" \
        -v "${WORK_HOST}/dynamic:/etc/traefik/dynamic:ro" \
        -v "${WORK_HOST}/letsencrypt:/letsencrypt" \
        --entrypoint /bin/sh \
        "$IMAGE" -c "$TRAEFIK_CMD" >/dev/null

    # Post-condition: still UP after settling. Not "the log has a banner" --
    # Traefik v3's default level is ERROR, so a healthy start prints nothing.
    running=false
    for _ in $(seq 1 10); do
        state="$(docker inspect -f '{{.State.Running}}' "$NAME_C" 2>/dev/null || echo false)"
        docker logs "$NAME_C" > "$WORK/logs-c.txt" 2>&1 || true
        if [[ "$state" == "true" ]] && ! grep -q "Command error\|FATAL" "$WORK/logs-c.txt"; then
            running=true
        else
            running=false
            break
        fi
        sleep 1
    done
    docker logs "$NAME_C" > "$WORK/logs-c.txt" 2>&1 || true

    rendered_email="$(docker exec "$NAME_C" sh -c 'grep -m1 "email:" /tmp/traefik.yml' 2>/dev/null || echo '<unreadable>')"
    echo "        rendered acme email line: ${rendered_email}"
    if [[ "$rendered_email" == *"${PROOF_EMAIL}"* ]]; then
        pass "the rendered config carries the ACME address from the ENVIRONMENT (${PROOF_EMAIL})"
    else
        fail "the rendered /tmp/traefik.yml does not carry the environment's ACME address"
    fi
    if [[ "$running" == "true" ]]; then
        pass "Traefik is still running on the rendered config"
    else
        fail "Traefik did not stay up on the rendered config; logs follow"
        sed 's/^/        /' "$WORK/logs-c.txt" >&2
    fi
    probe_router="$(docker exec "$NAME_C" wget -qO- http://127.0.0.1:8080/api/http/routers/claim4-probe@file 2>/dev/null || true)"
    probe_state="$(node -e '
      let r; try { r = JSON.parse(process.argv[1]) } catch { r = null }
      if (!r) { process.stdout.write("<missing>"); process.exit(0) }
      process.stdout.write(r.status + "|" + (r.tls && r.tls.certResolver) + "|" + (r.error || []).join(";"))
    ' "$probe_router")"
    echo "        claim4-probe@file: ${probe_state}"
    if grep -q "ACME resolve is skipped from the resolvers list" "$WORK/logs-c.txt"; then
        fail "the le-http resolver was SKIPPED -- check that /letsencrypt is mounted (compose: traefik-acme volume)"
    elif [[ "$probe_state" == "enabled|le-http|" ]] && ! grep -q "nonexistent certificate resolver" "$WORK/logs-c.txt"; then
        pass "a router naming le-http is enabled with no error -- the resolver exists on the rendered config"
    else
        fail "a router naming le-http is not cleanly enabled (${probe_state}) -- the resolver is not in effect"
    fi
    if [[ "$(docker exec "$NAME_C" wget -qO- http://127.0.0.1:8082/ping 2>/dev/null)" == "OK" ]]; then
        pass "the ping entrypoint the healthcheck probes answers OK on the rendered config"
    else
        fail "the ping entrypoint does not answer OK -- the compose healthcheck would never pass"
    fi

    # The fail-closed half, CONDITIONAL, measured on both sides -- a guard
    # that always refused would pass the first case alone.
    #   resolver set + no email  -> MUST stop, by name.
    #   resolver empty + no email -> MUST start (TLS terminates in front).
    empty_out="$(MSYS_NO_PATHCONV=1 docker run --rm \
        -e "ACME_EMAIL=" \
        -e "TRAEFIK_CERT_RESOLVER=le-http" \
        -e "ACME_CA_SERVER=${PROOF_CA}" \
        -e "EDGE_V4_SUBNET=${PROOF_V4}" \
        -e "EDGE_V6_SUBNET=${PROOF_V6}" \
        -v "$(host_path "$PWD")/docker/traefik/traefik.yml:/etc/traefik/traefik.yml:ro" \
        --entrypoint /bin/sh \
        "$IMAGE" -c "$TRAEFIK_CMD" 2>&1 || true)"
    if grep -q "FATAL.*ACME_EMAIL" <<<"$empty_out"; then
        pass "with a resolver configured, an EMPTY ACME_EMAIL stops the container by name"
        grep "FATAL" <<<"$empty_out" | head -n1 | sed 's/^/        /'
    else
        fail "an empty ACME_EMAIL did NOT stop the container -- it would register an unusable ACME account"
    fi

    MSYS_NO_PATHCONV=1 docker run -d --name "$NAME_D" \
        -e "ACME_EMAIL=" \
        -e "TRAEFIK_CERT_RESOLVER=" \
        -e "ACME_CA_SERVER=${PROOF_CA}" \
        -e "EDGE_V4_SUBNET=${PROOF_V4}" \
        -e "EDGE_V6_SUBNET=${PROOF_V6}" \
        -v "$(host_path "$PWD")/docker/traefik/traefik.yml:/etc/traefik/traefik.yml:ro" \
        -v "${WORK_HOST}/letsencrypt:/letsencrypt" \
        --entrypoint /bin/sh \
        "$IMAGE" -c "$TRAEFIK_CMD" >/dev/null 2>&1 || true
    sleep 5
    d_state="$(docker inspect -f '{{.State.Running}}' "$NAME_D" 2>/dev/null || echo missing)"
    docker logs "$NAME_D" > "$WORK/logs-d.txt" 2>&1 || true
    if [[ "$d_state" == "true" ]] && ! grep -q "FATAL" "$WORK/logs-d.txt"; then
        pass "with NO resolver, an empty ACME_EMAIL is accepted and Traefik STARTS (TLS terminates in front)"
    else
        fail "the no-resolver shape (empty TRAEFIK_CERT_RESOLVER, no ACME_EMAIL) does not start -- state=${d_state}"
        tail -10 "$WORK/logs-d.txt" | sed 's/^/        /' >&2
    fi
    docker rm -f "$NAME_D" >/dev/null 2>&1 || true
fi
echo ""

# ------------------------------------------------------------
# CLAIM 5 — all four markers, and the proof that the check can fail.
# ------------------------------------------------------------
echo "CLAIM 5 — the four markers are exactly the ones the rendered command substitutes"
MARKERS=(ACME_EMAIL ACME_CA_SERVER EDGE_V4_SUBNET EDGE_V6_SUBNET)
declare -A PROBE=(
    [ACME_EMAIL]="claim5@example.org"
    [ACME_CA_SERVER]="https://ca.claim5.example.org/dir"
    [EDGE_V4_SUBNET]="10.99.5.0/24"
    [EDGE_V6_SUBNET]="fd5a:95::/64"
)

in_file="$({ grep -oE '@[A-Z][A-Z0-9_]*@' docker/traefik/traefik.yml || true; } | sort -u | tr '\n' ' ')"
want="$(printf '@%s@\n' "${MARKERS[@]}" | sort -u | tr '\n' ' ')"
echo "        markers in docker/traefik/traefik.yml: ${in_file:-<none>}"
if [[ "$in_file" == "$want" ]]; then
    pass "the committed file carries exactly the four markers"
else
    fail "the committed file's markers are '${in_file}', expected '${want}'"
fi

# render_only <command> — run the command's render half and print the file it
# produced (or the refusal). The trailing exec is swapped for a `cat`, so the
# render is observed without starting Traefik; the swap must have happened.
RENDER_TAIL='exec /entrypoint.sh traefik --configFile=/tmp/traefik.yml'
render_only() {
    local cmd="$1"
    [[ "$cmd" == *"$RENDER_TAIL"* ]] || { echo "NO-EXEC-TAIL"; return 0; }
    MSYS_NO_PATHCONV=1 docker run --rm \
        -e "ACME_EMAIL=${PROBE[ACME_EMAIL]}" \
        -e "TRAEFIK_CERT_RESOLVER=le-http" \
        -e "ACME_CA_SERVER=${PROBE[ACME_CA_SERVER]}" \
        -e "EDGE_V4_SUBNET=${PROBE[EDGE_V4_SUBNET]}" \
        -e "EDGE_V6_SUBNET=${PROBE[EDGE_V6_SUBNET]}" \
        -v "$(host_path "$PWD")/docker/traefik/traefik.yml:/etc/traefik/traefik.yml:ro" \
        --entrypoint /bin/sh \
        "$IMAGE" -c "${cmd/"$RENDER_TAIL"/cat /tmp/traefik.yml}" 2>&1 || true
}

# all_substituted <rendered text> — true iff every probe value is present and
# no marker survived.
all_substituted() {
    local out="$1" m
    grep -qE '@[A-Z][A-Z0-9_]*@' <<<"$out" && return 1
    grep -q "FATAL" <<<"$out" && return 1
    for m in "${MARKERS[@]}"; do
        grep -qF -- "${PROBE[$m]}" <<<"$out" || return 1
    done
    return 0
}

if [[ -z "$TRAEFIK_CMD" ]]; then
    fail "no rendered command to check (see CLAIM 4)"
else
    rendered="$(render_only "$TRAEFIK_CMD")"
    if all_substituted "$rendered"; then
        pass "the rendered command substitutes all four markers with the environment's values"
    else
        fail "the rendered command does not substitute all four markers; its render follows"
        { grep -E '@[A-Z]|FATAL|email:|caServer:|/24|/64|NO-EXEC' <<<"$rendered" || true; } | sed 's/^/        /' >&2
    fi

    # Non-vacuity: cut ONE marker's sed expression out of the command at a
    # time. The check above must go RED for every one of them; a check that
    # stayed green would be proving nothing.
    # And one mutant that KEEPS every expression but substitutes a wrong value:
    # it trips no FATAL guard, so it goes RED only through the probe-value
    # comparison -- proving that half of the check is live too.
    wrong="$(sed -E 's/\|@EDGE_V4_SUBNET@\|[^|]*\|g/|@EDGE_V4_SUBNET@|10.0.0.0\/8|g/' <<<"$TRAEFIK_CMD")"
    if [[ "$wrong" == "$TRAEFIK_CMD" ]]; then
        fail "could not build the wrong-value mutant for @EDGE_V4_SUBNET@"
    elif all_substituted "$(render_only "$wrong")"; then
        fail "a render substituting the WRONG value for @EDGE_V4_SUBNET@ still passed -- the value check is vacuous"
    else
        pass "a render substituting the wrong value for @EDGE_V4_SUBNET@ goes RED (the value comparison is live)"
    fi

    for m in "${MARKERS[@]}"; do
        mutant="$(sed -E "s/-e \"s\\|@${m}@\\|[^\"]*\"//" <<<"$TRAEFIK_CMD")"
        if [[ "$mutant" == "$TRAEFIK_CMD" ]]; then
            fail "no sed expression for @${m}@ found in the rendered command -- nothing substitutes it"
            continue
        fi
        if all_substituted "$(render_only "$mutant")"; then
            fail "with the @${m}@ expression cut out, the check still passed -- CLAIM 5 is vacuous"
        else
            pass "with the @${m}@ expression cut out, the check goes RED (non-vacuous)"
        fi
    done
fi
echo ""

if [[ $failures -ne 0 ]]; then
    echo "verify-traefik-acme-wiring: ${failures} check(s) FAILED against ${IMAGE}" >&2
    exit 1
fi
echo "verify-traefik-acme-wiring: all five claims hold against ${IMAGE}"
