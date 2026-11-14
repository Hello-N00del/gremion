#!/usr/bin/env bats
# Unit tests for infra/host/bin/gremion-verify.
#
# Every external command is a fake: `curl` serves fixture files, `openssl` answers
# SAN/expiry from fixtures, `docker` answers inspect/exec from fixtures. The
# running-system proof is test/host/integration/edge-proto.sh.

load 'test_helper/host'

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
VERIFY="${REPO_ROOT}/infra/host/bin/gremion-verify"

# The slug gremion-verify's fake curl derives from a URL. The shim below computes
# it the same way; both must stay identical.
slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '-'; }

fake_http() {   # <url> <code> <body> [forged]
    local s
    s="$(slug "$1")"
    [ "${4:-}" = "forged" ] && s="${s}-forged"
    printf '%s' "$2" > "${FAKE_HTTP}/probe-${s}.code"
    printf '%s' "$3" > "${FAKE_HTTP}/probe-${s}.body"
}

# A URL curl cannot connect to: prints 000 (the -w code) and exits 7, as curl does.
fake_http_unreachable() {   # <url> [forged]
    local s
    s="$(slug "$1")"
    [ "${2:-}" = "forged" ] && s="${s}-forged"
    : > "${FAKE_HTTP}/probe-${s}.unreachable"
}

fake_cert() {   # <host> <san-line> <checkend-exit>
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n' > "${FAKE_TLS}/$1.pem"
    # EXACTLY the shape `openssl x509 -noout -ext subjectAltName` prints: a
    # header line, then the comma-separated entries indented beneath it. An
    # earlier version of this fake emitted the bare entries, which let a SAN
    # check that cannot cope with the header pass here and fail against every
    # real certificate (caught by test/host/integration/edge-proto.sh).
    printf 'X509v3 Subject Alternative Name: \n    %s\n' "$2" > "${FAKE_TLS}/$1.san"
    printf '%s' "$3"   > "${FAKE_TLS}/$1.checkend"
}

fake_container() {  # <id> <name> <aliases> <status> <health> <exitcode> [ip] [labels-json]
    printf '%s\n' "$1" >> "${FAKE_DOCKER}/ps"
    printf '/%s\n' "$2" > "${FAKE_DOCKER}/$1.name"
    printf '%s\n' "$3"  > "${FAKE_DOCKER}/$1.aliases"
    printf '%s\n' "$4"  > "${FAKE_DOCKER}/$1.status"
    printf '%s\n' "$5"  > "${FAKE_DOCKER}/$1.health"
    printf '%s\n' "$6"  > "${FAKE_DOCKER}/$1.exitcode"
    printf '%s\n' "${7:-}" > "${FAKE_DOCKER}/$1.ips"
    printf '%s\n' "${8:-"{}"}" > "${FAKE_DOCKER}/$1.labels"
    : > "${FAKE_DOCKER}/$2.env"
    : > "${FAKE_DOCKER}/$2.hosts"
}

install_shims() {
    shim curl '
url=""; outfile=""; hdrfile=""; want_code=0; forged=0; prev=""
for a in "$@"; do
  case "$prev" in -o) outfile="$a" ;; -D) hdrfile="$a" ;; esac
  case "$a" in
    -w) want_code=1 ;;
    X-Forwarded-Host:*) forged=1 ;;
    http://*|https://*) url="$a" ;;
  esac
  prev="$a"
done
case "$url" in
  */api/*)
    if [ -n "$hdrfile" ] && [ -f "$FAKE_HTTP/api-next-page" ]; then
      printf "HTTP/1.1 200 OK\r\nX-Next-Page: %s\r\n\r\n" "$(cat "$FAKE_HTTP/api-next-page")" > "$hdrfile"
    fi ;;
esac
case "$url" in
  */api/http/routers|*/api/http/routers\?*)         cat "$FAKE_HTTP/api-http-routers.json"; exit 0 ;;
  */api/http/services|*/api/http/services\?*)
    # services.json.next: what traefik reports on the NEXT read (a health probe that lands between two reads)
    cat "$FAKE_HTTP/api-http-services.json"
    [ -f "$FAKE_HTTP/api-http-services.json.next" ] && mv "$FAKE_HTTP/api-http-services.json.next" "$FAKE_HTTP/api-http-services.json"
    exit 0 ;;
  */api/http/middlewares|*/api/http/middlewares\?*) cat "$FAKE_HTTP/api-http-middlewares.json"; exit 0 ;;
  */api/tcp/routers|*/api/tcp/routers\?*)           cat "$FAKE_HTTP/api-tcp-routers.json"; exit 0 ;;
  */api/udp/routers|*/api/udp/routers\?*)           cat "$FAKE_HTTP/api-udp-routers.json"; exit 0 ;;
esac
s="$(printf "%s" "$url" | tr -c "A-Za-z0-9" "-")"
[ "$forged" = 1 ] && s="${s}-forged"
# F1-FIX-09 (K6#0): a real curl that cannot connect prints the -w code 000 AND
# exits non-zero (7). The shim used to print 000 and exit 0, which is the one
# shape that hid `|| echo 000` appending a second 000 (-> "000000").
if [ -f "$FAKE_HTTP/probe-$s.tlsrefused" ]; then
  [ "$want_code" = 1 ] && printf "000"
  echo "curl: (35) TLS connect error: error:0A000410:SSL routines::ssl/tls alert handshake failure" >&2
  exit 35
fi
if [ -f "$FAKE_HTTP/probe-$s.tlseof" ]; then
  [ "$want_code" = 1 ] && printf "000"
  echo "curl: (35) TLS connect error: error:0A000126:SSL routines::unexpected eof while reading" >&2
  exit 35
fi
if [ -f "$FAKE_HTTP/probe-$s.unreachable" ]; then
  [ "$want_code" = 1 ] && printf "000"
  exit 7
fi
if [ "$want_code" = 1 ]; then
  if [ -n "$outfile" ] && [ -f "$FAKE_HTTP/probe-$s.body" ]; then
    cat "$FAKE_HTTP/probe-$s.body" > "$outfile" 2>/dev/null || true
  fi
  cat "$FAKE_HTTP/probe-$s.code" 2>/dev/null || { printf "000"; exit 7; }
else
  cat "$FAKE_HTTP/probe-$s.body" 2>/dev/null || true
fi
'
    shim openssl '
sub="$1"; shift
case "$sub" in
  s_client)
      host=""; prev=""
      for a in "$@"; do [ "$prev" = "-servername" ] && host="$a"; prev="$a"; done
      if [ -f "$FAKE_TLS/$host.flip-after" ]; then
        n=$(( $(cat "$FAKE_TLS/$host.calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_TLS/$host.calls"
        [ "$n" -gt "$(cat "$FAKE_TLS/$host.flip-after")" ] && cp "$FAKE_TLS/$host.good-san" "$FAKE_TLS/$host.san"
      fi
      cat "$FAKE_TLS/$host.pem" 2>/dev/null || printf "NO-CERT\n"
      ;;
  x509)
      inf=""; mode=""; prev=""
      for a in "$@"; do
        [ "$prev" = "-in" ] && inf="$a"
        case "$a" in -ext) mode=ext ;; -checkend) mode=checkend ;; esac
        prev="$a"
      done
      if grep -q "FAKE-CA" "$inf" 2>/dev/null; then
        case "$mode" in
          ext) if grep -q "FAKE-CA-LEAF" "$inf"; then printf "X509v3 Basic Constraints: \n    CA:FALSE\n"; else printf "X509v3 Basic Constraints: critical\n    CA:TRUE\n"; fi ;;
          checkend) grep -q "FAKE-CA-EXPIRING" "$inf" && exit 1 ;;
        esac
        exit 0
      fi
      host="$(sed -n "s/^# host=//p" "$inf" | head -1)"
      case "$mode" in
        ext)      cat "$FAKE_TLS/$host.san" 2>/dev/null ;;
        checkend) exit "$(cat "$FAKE_TLS/$host.checkend" 2>/dev/null || echo 1)" ;;
      esac
      ;;
esac
'
    shim docker '
cmd="$1"; shift
case "$cmd" in
  ps) [ -f "$FAKE_DOCKER/ps-fails" ] && exit 1; cat "$FAKE_DOCKER/ps" 2>/dev/null; exit 0 ;;
  inspect)
      fmt=""; id=""; prev=""
      for a in "$@"; do
        [ "$prev" = "--format" ] && { fmt="$a"; prev="$a"; continue; }
        case "$a" in -*) ;; *) id="$a" ;; esac
        prev="$a"
      done
      # Real docker accepts an id OR a name, and gremion-verify inspects what
      # container_for_alias handed back, which is a NAME. The fixture files are
      # keyed by id, so resolve a name to its id before reading them — otherwise
      # every inspect answers with an empty string and the census reads green.
      if [ ! -f "$FAKE_DOCKER/$id.status" ]; then
        for cand in $(cat "$FAKE_DOCKER/ps" 2>/dev/null); do
          if [ "$(cat "$FAKE_DOCKER/$cand.name" 2>/dev/null)" = "/$id" ]; then
            id="$cand"; break
          fi
        done
      fi
      case "$fmt" in
        *Labels*)            cat "$FAKE_DOCKER/$id.labels" 2>/dev/null || printf "{}\n" ;;
        *".Name"*)           cat "$FAKE_DOCKER/$id.name" ;;
        *Aliases*)           cat "$FAKE_DOCKER/$id.aliases" ;;
        *IPAddress*)         cat "$FAKE_DOCKER/$id.ips" ;;
        *".State.Status"*)   cat "$FAKE_DOCKER/$id.status" ;;
        *Health*)            cat "$FAKE_DOCKER/$id.health" ;;
        *".State.ExitCode"*) cat "$FAKE_DOCKER/$id.exitcode" ;;
      esac
      exit 0 ;;
  exec)
      c="$1"; shift
      case "$1" in
        env)    cat "$FAKE_DOCKER/$c.env" 2>/dev/null; exit 0 ;;
        getent) grep -qx "$3" "$FAKE_DOCKER/$c.hosts" 2>/dev/null; exit $? ;;
      esac
      exit 0 ;;
  compose) exit 0 ;;
esac
'
}

# An emitted tenant file in etc/edge, in exactly the shape renderTenantRouter
# produces (packages/edge-routers; infra/host/templates/edge/
# tenant-router.example.yml is its byte-exact render).
emitted_file() {  # <slug> <host>
    local slug="$1" host="$2"
    {
        printf '# tenant-<slug>.yml — GENERATED by @gremion/edge-routers (renderTenantRouter).\n'
        printf 'http:\n  routers:\n    tenant-%s:\n' "$slug"
        printf '      entryPoints: ["websecure"]\n'
        printf '      rule: "Host(`%s`)"\n' "$host"
        printf '      service: "app@file"\n      priority: 10\n      middlewares:\n'
        printf '        - "edge-hostpin-%s@file"\n' "$slug"
        printf '        - "edge-hsts-custom@docker"\n        - "edge-ratelimit-app@docker"\n'
        printf '        - "edge-perip-%s@file"\n' "$slug"
        printf '      tls:\n        certResolver: "le-http"\n'
        printf '  middlewares:\n    edge-hostpin-%s:\n' "$slug"
        printf '      headers:\n        customRequestHeaders:\n'
        printf '          X-Forwarded-Host: "%s"\n' "$host"
        printf '    edge-perip-%s:\n      inFlightReq:\n        amount: 500\n' "$slug"
        printf '        sourceCriterion:\n          ipStrategy:\n            depth: 0\n'
    } > "${GREMION_ROOT}/etc/edge/tenant-${slug}.yml"
}

# jq-edit one fake API document in place: api_edit <routers|services|middlewares> <filter>
api_edit() {
    local f="${FAKE_HTTP}/api-http-$1.json"
    jq "$2" "$f" > "${f}.new"
    mv "${f}.new" "$f"
}

# The green baseline every test perturbs: two tenant routers on app@file, two
# state-bound routers, the internaltest router and acme-http@internal, valid
# certificates, pinned responses that DIFFER per host, an ACME 404 and two
# healthy containers. Every public router satisfies the router universal
# (certresolver; exactly one pin, naming its own literal host, chained first;
# an HSTS and an edge-ratelimit-* middleware), each tenant's pin is declared in
# its own emitted file under etc/edge, and every other middleware is @docker.
fixture_green() {
    cat > "${FAKE_HTTP}/api-http-routers.json" <<'EOF'
[
  {"name":"tenant-a@file","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`)","service":"app@file","tls":{"certResolver":"le-http"},
   "middlewares":["edge-hostpin-a@file","edge-hsts-custom@docker","edge-ratelimit-app@docker","edge-perip-a@file"]},
  {"name":"tenant-b@file","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-b.example.org`)","service":"app@file","tls":{"certResolver":"le-http"},
   "middlewares":["edge-hostpin-b@file","edge-hsts-custom@docker","edge-ratelimit-app@docker","edge-perip-b@file"]},
  {"name":"keycloak@docker","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`) && PathPrefix(`/auth`)","service":"keycloak@docker",
   "tls":{"certResolver":"le-http"},
   "middlewares":["edge-hostpin-a@file","edge-hsts-custom@docker","edge-ratelimit-auth@docker"]},
  {"name":"test-app@file","status":"enabled","entryPoints":["internaltest"],
   "rule":"HostRegexp(`.+`)","service":"app-next@file"},
  {"name":"acme-http@internal","status":"enabled","entryPoints":["web"],
   "rule":"PathPrefix(`/.well-known/acme-challenge/`)","service":"acme-http@internal"},
  {"name":"whoami@docker","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`) && PathPrefix(`/whoami`)","service":"whoami",
   "tls":{"certResolver":"le-http"},
   "middlewares":["edge-hostpin-a@file","edge-hsts-custom@docker","edge-ratelimit-app@docker"]}
]
EOF
    cat > "${FAKE_HTTP}/api-http-services.json" <<'EOF'
[
  {"name":"app@file","loadBalancer":{"servers":[{"url":"http://gremion-ui-blue:3000"}]}},
  {"name":"public@file","loadBalancer":{"servers":[{"url":"http://gremion-public-blue:3000"}]}},
  {"name":"app-next@file","loadBalancer":{"servers":[{"url":"http://gremion-ui-green:3000"}]}},
  {"name":"keycloak@docker","loadBalancer":{"servers":[{"url":"http://keycloak:8080"}]}},
  {"name":"whoami@docker","loadBalancer":{"servers":[{"url":"http://10.90.250.4:8080"}]}},
  {"name":"acme-http@internal","loadBalancer":{"servers":[]}}
]
EOF
    cat > "${FAKE_HTTP}/api-http-middlewares.json" <<'EOF'
[
  {"name":"edge-hostpin-a@file","provider":"file","type":"headers",
   "headers":{"customRequestHeaders":{"X-Forwarded-Host":"tenant-a.example.org"}}},
  {"name":"edge-hostpin-b@file","provider":"file","type":"headers",
   "headers":{"customRequestHeaders":{"X-Forwarded-Host":"tenant-b.example.org"}}},
  {"name":"edge-perip-a@file","provider":"file","type":"inflightreq","inFlightReq":{"amount":50}},
  {"name":"edge-perip-b@file","provider":"file","type":"inflightreq","inFlightReq":{"amount":50}},
  {"name":"edge-hsts-custom@docker","provider":"docker","type":"headers",
   "headers":{"stsSeconds":31536000}},
  {"name":"edge-ratelimit-app@docker","provider":"docker","type":"ratelimit",
   "rateLimit":{"average":300,"burst":100,"period":"1m"}},
  {"name":"edge-ratelimit-auth@docker","provider":"docker","type":"ratelimit",
   "rateLimit":{"average":30,"burst":10,"period":"1m"}},
  {"name":"edge-ratelimit-portal@docker","provider":"docker","type":"ratelimit",
   "rateLimit":{"average":100,"burst":50,"period":"1m"}}
]
EOF
    printf '[]\n' > "${FAKE_HTTP}/api-tcp-routers.json"
    printf '[]\n' > "${FAKE_HTTP}/api-udp-routers.json"
    emitted_file a tenant-a.example.org
    emitted_file b tenant-b.example.org
    local h
    for h in tenant-a.example.org tenant-b.example.org; do
        fake_cert "$h" "DNS:${h}" 0
        fake_http "https://${h}:8443/whoami" 200 "colour=blue xfh=${h}"
        fake_http "https://${h}:8443/whoami" 200 "colour=blue xfh=${h}" forged
        fake_http "http://${h}:8090/.well-known/acme-challenge/probe" 404 ""
    done
    fake_container c1 gremion-ui-blue "gremion-ui-blue gremion-public-blue" running healthy 0
    fake_container c2 keycloak        "keycloak"                            running healthy 0 10.90.250.4
    fake_traefik
}

# The traefik container, declaring every @docker middleware the fixture chains
# on its own labels (compose service `traefik`) — check_middleware_placement.
fake_traefik() {
    fake_container c9 traefik "traefik" running healthy 0 "" \
        '{"com.docker.compose.service":"traefik","com.docker.compose.project":"staging-state",
          "traefik.http.middlewares.edge-hsts-custom.headers.stsseconds":"31536000",
          "traefik.http.middlewares.edge-hsts-platform.headers.stsseconds":"31536000",
          "traefik.http.middlewares.edge-hostpin-control.headers.customrequestheaders.x-forwarded-host":"control.example.org",
          "traefik.http.middlewares.edge-ratelimit-app.ratelimit.average":"300",
          "traefik.http.middlewares.edge-ratelimit-auth.ratelimit.average":"30",
          "traefik.http.middlewares.edge-ratelimit-portal.ratelimit.average":"100"}'
}


# The release tree carries docs/ (gremion-deploy:208 clones the whole repo and
# :537-539 points `current` at it), so the ledger the verifier parses is the
# repository's own ledger bytes, not a fixture that can disagree with them.
install_ledger() {
    mkdir -p "${GREMION_ROOT}/current/docs/ops"
    cp "${REPO_ROOT}/docs/ops/release-1-waivers.md" \
       "${GREMION_ROOT}/current/docs/ops/release-1-waivers.md"
}

# The host's verifier is an INSTALLED COPY under $(gremion_root)/bin with no
# sibling repository tree: bootstrap.sh stage_timers (:897-903) only asserts
# that it is there. Every test that runs the in-tree $VERIFY is therefore blind
# to the shape the host actually has, which is how a verifier that hard-dies
# without $ROOT/current shipped: it never dies in-tree, because in-tree it
# reads its own checkout's ledger.
install_verifier() {
    mkdir -p "${GREMION_ROOT}/bin" "${GREMION_ROOT}/lib"
    cp "${REPO_ROOT}/infra/host/bin/gremion-verify" "${GREMION_ROOT}/bin/gremion-verify"
    cp "${REPO_ROOT}/infra/host/lib/common.sh"      "${GREMION_ROOT}/lib/common.sh"
    chmod +x "${GREMION_ROOT}/bin/gremion-verify"
    printf '%s' "${GREMION_ROOT}/bin/gremion-verify"
}

setup() {
    setup_host_root
    FAKE="${BATS_TEST_TMPDIR}/fake"
    export FAKE_HTTP="${FAKE}/http" FAKE_TLS="${FAKE}/tls" FAKE_DOCKER="${FAKE}/docker"
    mkdir -p "$FAKE_HTTP" "$FAKE_TLS" "$FAKE_DOCKER"
    export TRAEFIK_API="http://127.0.0.1:8080"
    export VERIFY_MARKER_PATH="/whoami"
    export REBOOT_SETTLE_SECONDS=0
    export CONTROL_CERT_WAIT_SECONDS=0
    export PANEL_UP_WAIT_SECONDS=0
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=staging
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=127.0.0.1
EDGE_HTTP_PORT=8090
EDGE_HTTPS_PORT=8443
HEALTH_EXEMPT_SERVICES=minio-mc
EOF
    HOSTS="${BATS_TEST_TMPDIR}/hosts.txt"
    printf 'tenant-a.example.org\ntenant-b.example.org\n' > "$HOSTS"
    install_shims
    fixture_green
    install_ledger
}

@test "gremion-verify passes against a well-formed edge" {
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
}

@test "gremion-verify classifies colour-bound and state-bound routers" {
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    run jq -r '.routers[] | select(.name=="tenant-a@file") | .class' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "colour-bound" ]
    run jq -r '.routers[] | select(.name=="keycloak@docker") | .class' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "state-bound" ]
}

@test "a docker router whose service is unqualified resolves against its own provider" {
    # Traefik reports a docker router's service WITHOUT the provider suffix
    # ("whoami"), and resolves it against the router's own provider
    # ("whoami@docker"). Defaulting an unsuffixed name to @file makes every such
    # router UNCLASSIFIED — which is what the bare-Traefik prototype hit on the
    # traefik container's own dashboard router.
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    run jq -r '.routers[] | select(.name=="whoami@docker") | .class' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "state-bound" ]
}

@test "a router whose service traefik does not know is unclassified and fails" {
    jq '.[0].service = "ghost@file"' "${FAKE_HTTP}/api-http-routers.json" > "${FAKE_HTTP}/r.json"
    mv "${FAKE_HTTP}/r.json" "${FAKE_HTTP}/api-http-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNCLASSIFIED router tenant-a@file"* ]]
}

@test "a router that is not enabled fails" {
    jq '.[1].status = "warning"' "${FAKE_HTTP}/api-http-routers.json" > "${FAKE_HTTP}/r.json"
    mv "${FAKE_HTTP}/r.json" "${FAKE_HTTP}/api-http-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: status=warning"* ]]
}

@test "a router chaining an absent middleware fails" {
    jq '.[0].middlewares = ["edge-hostpin-orphan@docker"]' "${FAKE_HTTP}/api-http-routers.json" > "${FAKE_HTTP}/r.json"
    mv "${FAKE_HTTP}/r.json" "${FAKE_HTTP}/api-http-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"middleware edge-hostpin-orphan@docker is referenced but absent"* ]]
}

@test "an unreachable traefik API is a precondition failure, not an assertion failure" {
    shim curl 'exit 7'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"traefik API unreachable"* ]]
}

@test "a certificate whose SAN does not name the host fails" {
    fake_cert tenant-b.example.org "DNS:somewhere-else.example.org" 0
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for tenant-b.example.org has no matching SAN"* ]]
}

@test "a certificate expiring inside the 20-day window fails" {
    fake_cert tenant-a.example.org "DNS:tenant-a.example.org" 1
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for tenant-a.example.org expires within 20 days"* ]]
}

@test "a host that does not serve the marker fails" {
    fake_http "https://tenant-a.example.org:8443/whoami" 503 ""
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"returned 503"* ]]
}

@test "an unpinned router that honours a forged X-Forwarded-Host fails" {
    # the forged request comes back with the OTHER tenant's content: the host-pin
    # middleware is missing or is chained after something that reads the header
    fake_http "https://tenant-a.example.org:8443/whoami" 200 \
              "colour=blue xfh=tenant-b.example.org" forged
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"host-pin: forged X-Forwarded-Host"* ]]
    [[ "$output" == *"tenant-a.example.org"* ]]
}

@test "an acme-challenge path answered with a redirect fails" {
    fake_http "http://tenant-a.example.org:8090/.well-known/acme-challenge/probe" 301 ""
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"acme-challenge probe for tenant-a.example.org returned 301"* ]]
}

# F1-FIX-09 / K6#0: `curl -w '%{http_code}' ... || echo 000` printed the code
# curl itself wrote (000) and then a second 000, so a probe that could not connect
# read "000000". That is neither "000" nor >= 400 in arithmetic, so the internaltest
# probe in check_colour passed on a dead entrypoint. The shim above now prints 000
# AND exits 7, as real curl does; each case asserts the failure NAMES code 000.
@test "a host whose marker request cannot connect fails as 000, never as 000000" {
    fake_http_unreachable "https://tenant-a.example.org:8443/whoami"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"returned 000 (expected < 400)"* ]]
    [[ "$output" != *"000000"* ]]
}

@test "an acme-challenge probe that cannot connect fails as 000, never as 000000" {
    fake_http_unreachable "http://tenant-a.example.org:8090/.well-known/acme-challenge/probe"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"acme-challenge probe for tenant-a.example.org returned 000 (expected 404"* ]]
    [[ "$output" != *"000000"* ]]
}

@test "--colour fails when the internaltest probe cannot connect (000, not a pass)" {
    prepare_green_colour
    fake_http_unreachable "http://127.0.0.1:8081/whoami"
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"internaltest entrypoint returned 000 for example.org"* ]]
    [[ "$output" != *"000000"* ]]
}

@test "the default host list is PLATFORM_DOMAIN, control. and etc/tenant-hosts.txt" {
    printf 'tenant-a.example.org\n' > "${GREMION_ROOT}/etc/tenant-hosts.txt"
    run "$VERIFY"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control.example.org"* ]]
    [[ "$output" == *"example.org"* ]]
}

@test "the default marker path is /healthz" {
    unset VERIFY_MARKER_PATH
    local h
    for h in tenant-a.example.org tenant-b.example.org; do
        # byte-stable per host, and different between hosts: the two halves of
        # the marker contract
        fake_http "https://${h}:8443/healthz" 200 "{\"ok\":true,\"tenant\":\"${h}\"}"
        fake_http "https://${h}:8443/healthz" 200 "{\"ok\":true,\"tenant\":\"${h}\"}" forged
    done
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    assert_recorded curl ":8443/healthz"
}

@test "a marker path that returns the same bytes for every host is rejected as vacuous" {
    local h
    for h in tenant-a.example.org tenant-b.example.org; do
        fake_http "https://${h}:8443/whoami" 200 "static body, same for everyone"
        fake_http "https://${h}:8443/whoami" 200 "static body, same for everyone" forged
    done
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"returns identical bytes for every host"* ]]
    [[ "$output" == *"cannot fail and proves nothing"* ]]
}

@test "an unhealthy backing container fails" {
    printf 'unhealthy\n' > "${FAKE_DOCKER}/c1.health"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"container gremion-ui-blue"* ]]
    [[ "$output" == *"health=unhealthy"* ]]
}

@test "a backing alias no container answers to fails" {
    : > "${FAKE_DOCKER}/ps"
    fake_container c2 keycloak "keycloak" running healthy 0 10.90.250.4
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no container answers to 'gremion-ui-blue'"* ]]
}

@test "a service on the health-exemption list must have exited 0" {
    jq '.[0].loadBalancer.servers = [{"url":"http://minio-mc:9000"}]' \
        "${FAKE_HTTP}/api-http-services.json" > "${FAKE_HTTP}/s.json"
    mv "${FAKE_HTTP}/s.json" "${FAKE_HTTP}/api-http-services.json"
    : > "${FAKE_DOCKER}/ps"
    fake_container c3 minio-mc "minio-mc" exited none 0
    fake_container c2 keycloak "keycloak" running healthy 0 10.90.250.4
    fake_traefik
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"exempt container minio-mc exited 0"* ]]
}

@test "an exempt service that exited non-zero fails" {
    jq '.[0].loadBalancer.servers = [{"url":"http://minio-mc:9000"}]' \
        "${FAKE_HTTP}/api-http-services.json" > "${FAKE_HTTP}/s.json"
    mv "${FAKE_HTTP}/s.json" "${FAKE_HTTP}/api-http-services.json"
    : > "${FAKE_DOCKER}/ps"
    fake_container c3 minio-mc "minio-mc" exited none 2
    fake_container c2 keycloak "keycloak" running healthy 0 10.90.250.4
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"exempt container minio-mc: status=exited exit=2"* ]]
}

@test "last-verify.json records ok, the router rows and the failures" {
    fake_cert tenant-b.example.org "DNS:wrong.example.org" 0
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    run jq -r '.ok' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "false" ]
    run jq -r '.failures | length' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "1" ]
    run jq -r '.routers | map(select(.class=="colour-bound")) | length' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "3" ]
    run jq -r '.ts | length > 0' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "true" ]
}

prepare_green_colour() {
    fake_container c4 gremion-ui-green "gremion-ui-green gremion-public-green" running healthy 0
    {
        printf 'INTERNAL_BASE_URL=http://gremion-ui-green:3000\n'
        printf 'KERNEL_BASE_URL=http://gremion-ui-green:3000\n'
        printf 'CONTENT_SERVICE_URL=http://content-service-green:8080\n'
    } > "${FAKE_DOCKER}/gremion-ui-green.env"
    local leaf
    for leaf in content finance files votes messages newsletter calendar board vault; do
        printf '%s-service-green\n' "$leaf" >> "${FAKE_DOCKER}/gremion-ui-green.hosts"
    done
    fake_http "http://127.0.0.1:8081/whoami" 200 "colour=green xfh=example.org"
}

@test "--colour verifies the inactive colour end to end" {
    prepare_green_colour
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
}

@test "--colour fails when INTERNAL_BASE_URL names the wrong colour" {
    prepare_green_colour
    printf 'INTERNAL_BASE_URL=http://gremion-ui-blue:3000\n' > "${FAKE_DOCKER}/gremion-ui-green.env"
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"INTERNAL_BASE_URL is not http://gremion-ui-green:3000"* ]]
}

@test "--colour fails when a leaf alias does not resolve to that colour" {
    prepare_green_colour
    grep -v '^finance-service-green$' "${FAKE_DOCKER}/gremion-ui-green.hosts" > "${FAKE_DOCKER}/h" || true
    mv "${FAKE_DOCKER}/h" "${FAKE_DOCKER}/gremion-ui-green.hosts"
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"finance-service-green does not resolve"* ]]
}

@test "--colour fails when an internal URL names the public domain" {
    prepare_green_colour
    printf 'CONTENT_SERVICE_URL=https://content.example.org\n' >> "${FAKE_DOCKER}/gremion-ui-green.env"
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"internal URL names the public domain"* ]]
}

@test "--reboot restarts the active colour once and re-verifies" {
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    printf 'unhealthy\n' > "${FAKE_DOCKER}/c1.health"
    run "$VERIFY" --reboot --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    assert_recorded docker "compose"
    assert_recorded docker "app-blue.env"
    assert_recorded docker "restart"
    [[ "$output" == *"still failing after one restart"* ]]
}

@test "--reboot does not restart anything when the first pass is green" {
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    run "$VERIFY" --reboot --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    ! grep -q 'restart' "$SHIM_LOG"
}

@test "--reboot reports a precondition failure instead of restarting anything" {
    # A missing waiver ledger is exit 2 - "could not verify" - and it reaches
    # the boot path, because the INSTALLED verifier is not versioned with the
    # release tree whose docs/ it reads. Before the gate read the exit code,
    # that laundered into: restart the whole app project, fail again, and alert
    # "still failing after one restart of app-blue". Forty containers restarted
    # for nothing, and the one sentence that named the real cause - a markdown
    # file the release tree does not carry - appeared nowhere in the alert.
    local v; v="$(install_verifier)"
    rm -rf "${GREMION_ROOT}/current"
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
    run "$VERIFY" --reboot --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"REBOOT-GATE: verify=precondition-failure restarted=0"* ]]
    # the verifier's own message travels into the alert
    [[ "$output" == *"release-1-waivers.md"* ]]
    # and the wrong diagnosis is not issued
    [[ "$output" != *"still failing after one restart"* ]]
    refute_recorded docker "restart"
}

@test "usage lists exactly the flags the parser accepts" {
    run "$VERIFY" --help
    [ "$status" -eq 2 ]
    [[ "$output" == *"--reboot"* ]]
}

# ── the router universal (TASK-034a, TDD 7) ─────────────────────────────────
# Asserted over EVERY router Traefik's API reports, never over a checklist of
# names: each web/websecure router (not @internal, not internaltest-only)
# carries a certresolver, exactly one host pin whose X-Forwarded-Host is its
# own literal host and which is FIRST in its chain, an HSTS and an
# edge-ratelimit-* middleware. The failure names the router.

@test "universal: a public router without a certresolver fails, naming it" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")) |= del(.tls)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: no certresolver"* ]]
}

@test "universal: tls without a resolver name is the same failure" {
    api_edit routers '(.[] | select(.name=="whoami@docker")).tls = {}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router whoami@docker: no certresolver"* ]]
}

@test "universal: two host pins fail" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).middlewares |= ["edge-hostpin-b@file","edge-hostpin-a@file"] + .[1:]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: 2 host pins (expected exactly 1)"* ]]
}

@test "universal: zero host pins fail" {
    api_edit routers '(.[] | select(.name=="keycloak@docker")).middlewares |= .[1:]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router keycloak@docker: 0 host pins (expected exactly 1)"* ]]
}

@test "universal: a pin naming ANOTHER host fails (foreign pin host)" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares[0] = "edge-hostpin-b@file"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: pin edge-hostpin-b@file sets X-Forwarded-Host 'tenant-b.example.org', not its own host 'tenant-a.example.org'"* ]]
}

@test "universal: a pin-named middleware that sets no X-Forwarded-Host fails" {
    api_edit middlewares '(.[] | select(.name=="edge-hostpin-a@file")).headers = {"customRequestHeaders":{"X-Other":"tenant-a.example.org"}}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: pin edge-hostpin-a@file sets X-Forwarded-Host '', not its own host 'tenant-a.example.org'"* ]]
}

@test "universal: a router without HSTS fails" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares |= map(select(startswith("edge-hsts-") | not))'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: no HSTS middleware"* ]]
}

@test "universal: an HSTS-named middleware that sends no max-age is not HSTS" {
    api_edit middlewares '(.[] | select(.name=="edge-hsts-custom@docker")).headers = {"stsSeconds":0}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: no HSTS middleware"* ]]
}

@test "universal: a router without an edge-ratelimit-* middleware fails" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).middlewares |= map(select(startswith("edge-ratelimit-") | not))'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: no edge-ratelimit-* middleware"* ]]
}

@test "universal: a bare edge-ratelimit (no tier) does not count" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).middlewares[2] = "edge-ratelimit@docker"'
    api_edit middlewares '. + [{"name":"edge-ratelimit@docker","provider":"docker","type":"ratelimit","rateLimit":{"average":300}}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: no edge-ratelimit-* middleware"* ]]
}

@test "universal: a pin that is not FIRST in the chain fails" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares |= [.[1], .[0]] + .[2:]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: host pin edge-hostpin-a@file is not first in the chain"* ]]
}

@test "universal: a public router matching a host PATTERN cannot be pinned and fails" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).rule = "HostRegexp(`^[a-z0-9-]+\\.example\\.org$`)"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule does not begin with exactly one literal Host"* ]]
}

@test "universal: a public router naming two literal hosts fails" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).rule = "Host(`tenant-b.example.org`) || Host(`tenant-a.example.org`)"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule carries 2 host matchers (expected exactly 1)"* ]]
}

@test "universal: a router with NO entryPoints listens everywhere and is held to it" {
    api_edit routers '. + [{"name":"stray@docker","status":"enabled","rule":"Host(`tenant-a.example.org`) && PathPrefix(`/x`)","service":"keycloak@docker"}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router stray@docker: no certresolver"* ]]
    [[ "$output" == *"router stray@docker: 0 host pins"* ]]
}

@test "universal: a router on internaltest AND websecure is not exempt" {
    api_edit routers '(.[] | select(.name=="test-app@file")).entryPoints = ["internaltest","websecure"]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router test-app@file: no certresolver"* ]]
}

@test "universal: internaltest-only and @internal routers are exempt" {
    api_edit routers '. + [{"name":"test-public@file","status":"enabled","entryPoints":["internaltest"],"rule":"HostRegexp(`.+`) && PathPrefix(`/portal`)","service":"public@file"},
                             {"name":"api@internal","status":"enabled","entryPoints":["websecure"],"rule":"PathPrefix(`/api`)","service":"api@internal"}]'
    api_edit services '. + [{"name":"api@internal","loadBalancer":{"servers":[]}}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
    [[ "$output" != *"test-public@file"* ]]
    [[ "$output" != *"api@internal"* ]]
}

@test "universal: an EMPTY router list is a failure, not a vacuous pass" {
    printf '[]\n' > "${FAKE_HTTP}/api-http-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router universal: traefik reports no public router"* ]]
}

@test "universal: a router list with only exempt routers is the same failure" {
    api_edit routers 'map(select(.name=="test-app@file" or .name=="acme-http@internal"))'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router universal: traefik reports no public router"* ]]
}

@test "check_routers: an unclassified router fails even when the universal is satisfied" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")).service = "ghost@file"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNCLASSIFIED router tenant-a@file"* ]]
}

# Review round 1 (security / silent-failure): rule shapes that answer more than
# their host, later middlewares that undo the pin, L4 routers, pagination.

rule_case() {  # <router> <rule> -> runs verify with that router's rule replaced
    jq --arg n "$1" --arg r "$2" '(.[] | select(.name == $n)).rule = $r' \
        "${FAKE_HTTP}/api-http-routers.json" > "${FAKE_HTTP}/r.new"
    mv "${FAKE_HTTP}/r.new" "${FAKE_HTTP}/api-http-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
}

@test "universal: Host || PathPrefix fails (not a conjunction)" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`) || PathPrefix(`/`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule continues with something other than &&"* ]]
}

@test "universal: Host && Path || PathPrefix fails (top-level || after the conjunction)" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`) && Path(`/x`) || PathPrefix(`/`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule has a top-level || and answers more than its host"* ]]
}

@test "universal: a lower-case second host matcher fails" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`) || host(`evil.example.net`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule carries 2 host matchers"* ]]
}

@test "universal: a lower-case hostregexp disjunction fails" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`) || hostregexp(`.+`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule carries 2 host matchers"* ]]
}

@test "universal: a double-quoted second Host fails" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`) || Host("evil.example.net")'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule carries 2 host matchers"* ]]
}

@test "universal: a negated Host answers every OTHER host and fails" {
    rule_case tenant-b@file '!Host(`tenant-b.example.org`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule does not begin with exactly one literal Host"* ]]
}

@test "universal: a two-argument Host fails" {
    rule_case tenant-b@file 'Host(`tenant-b.example.org`,`evil.example.net`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule does not begin with exactly one literal Host"* ]]
}

@test "universal: an upper-case host literal fails (the pin could never match it byte for byte)" {
    rule_case tenant-b@file 'Host(`TENANT-B.example.org`)'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule does not begin with exactly one literal Host"* ]]
}

@test "universal: || INSIDE a parenthesised && conjunct is fine" {
    rule_case keycloak@docker 'Host(`tenant-a.example.org`) && (PathPrefix(`/auth/realms`) || PathPrefix(`/auth/js`))'
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
}

@test "universal: a later middleware that rewrites X-Forwarded-Host fails" {
    api_edit middlewares '. + [{"name":"unpin@docker","provider":"docker","type":"headers","headers":{"customRequestHeaders":{"x-forwarded-host":"tenant-b.example.org"}}}]'
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares += ["unpin@docker"]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: middleware unpin@docker sets X-Forwarded-Host after the pin"* ]]
}

@test "universal: a forwardAuth that copies response headers by regex fails" {
    api_edit middlewares '. + [{"name":"auth@docker","provider":"docker","type":"forwardauth","forwardAuth":{"address":"http://a","authResponseHeadersRegex":"^X-"}}]'
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares += ["auth@docker"]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: middleware auth@docker is a forwardAuth that can copy X-Forwarded-Host"* ]]
}

@test "universal: a chain middleware cannot be read and fails" {
    api_edit middlewares '. + [{"name":"bundle@docker","provider":"docker","type":"chain","chain":{"middlewares":["x"]}}]'
    api_edit routers '(.[] | select(.name=="tenant-a@file")).middlewares += ["bundle@docker"]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: middleware bundle@docker is a chain/plugin middleware"* ]]
}

@test "universal: a pin carrying a second, lower-case X-Forwarded-Host key fails" {
    api_edit middlewares '(.[] | select(.name=="edge-hostpin-a@file")).headers.customRequestHeaders["x-forwarded-host"] = "tenant-b.example.org"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: pin edge-hostpin-a@file sets X-Forwarded-Host 'tenant-a.example.org,tenant-b.example.org'"* ]]
}

@test "universal: a TCP router on websecure fails" {
    printf '[{"name":"passthru@docker","entryPoints":["websecure"],"rule":"HostSNI(`*`)","tls":{"passthrough":true}}]\n' \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: passthru@docker"* ]]
}

# The video relay (TURN over TLS on 443) is the ONE TCP router a public entrypoint may carry: exactly
# livekit-turn@docker, on websecure alone, answering HostSNI(`turn.<PILOT_TENANT_HOST>`) with the host
# read from state.env, terminating TLS with a certificate resolver (not passthrough). Every other TCP
# router stays refused, and with no PILOT_TENANT_HOST there is no exception at all.
relay_host() { printf 'PILOT_TENANT_HOST=customer.example.org\n' >> "${GREMION_ROOT}/etc/env/state.env"; }
# relay_json <name> <entryPoints-json> <rule> <tls-json>
relay_json() {
    jq -cn --arg n "$1" --argjson e "$2" --arg r "$3" --argjson t "$4" \
        '{name:$n, entryPoints:$e, rule:$r, tls:$t, service:"livekit-turn"}'
}
RELAY_RULE='HostSNI(`turn.customer.example.org`)'

@test "relay: the exact livekit-turn router on websecure passes" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
    [[ "$output" != *"TCP router(s) on a public entrypoint"* ]]
}

@test "relay: a catch-all HostSNI rule on the relay router fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' 'HostSNI(`*`)' '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: a passthrough relay router fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http","passthrough":true}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: a relay router for another host fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' 'HostSNI(`turn.other.example.org`)' '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: the right rule under a different router name fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'relay@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: relay@docker"* ]]
}

@test "relay: a relay router without a certificate resolver fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: a relay router on the plain-HTTP entrypoint as well as websecure fails" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["web","websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: a second TCP router next to the good one fails, and only the second is named" {
    relay_host
    printf '[%s,%s]\n' \
        "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        "$(relay_json 'passthru@docker' '["websecure"]' 'HostSNI(`*`)' '{"passthrough":true}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: passthru@docker"* ]]
    [[ "$output" != *"public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: without PILOT_TENANT_HOST there is no exception, the exact router fails" {
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"TCP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "relay: a UDP router named livekit-turn is never excepted" {
    relay_host
    printf '[%s]\n' "$(relay_json 'livekit-turn@docker' '["websecure"]' "$RELAY_RULE" '{"certResolver":"le-http"}')" \
        > "${FAKE_HTTP}/api-udp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UDP router(s) on a public entrypoint: livekit-turn@docker"* ]]
}

@test "universal: a UDP router with no entryPoints fails; a TCP router on a private entrypoint does not" {
    printf '[{"name":"u@docker"}]\n' > "${FAKE_HTTP}/api-udp-routers.json"
    printf '[{"name":"smtp@docker","entryPoints":["smtp"],"rule":"HostSNI(`*`)"}]\n' > "${FAKE_HTTP}/api-tcp-routers.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UDP router(s) on a public entrypoint: u@docker"* ]]
    [[ "$output" != *"smtp@docker"* ]]
}

@test "api: a response that fills the page is a truncated read, exit 2" {
    export API_PER_PAGE=6
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"traefik API /api/http/routers is truncated (6 items, per_page=6"* ]]
}

@test "api: an X-Next-Page beyond page 1 is a truncated read, exit 2" {
    printf '2' > "${FAKE_HTTP}/api-next-page"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"is truncated"* ]]
    [[ "$output" == *"X-Next-Page=2"* ]]
}

@test "api: a list endpoint that is not a JSON list is exit 2, not an empty universal" {
    printf '{"oops":1}\n' > "${FAKE_HTTP}/api-http-middlewares.json"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"/api/http/middlewares did not return a JSON list"* ]]
}

@test "the verifier requests every list with per_page" {
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    local e
    for e in http/routers http/services http/middlewares tcp/routers udp/routers; do
        assert_recorded curl "/api/${e}?per_page=10000&page=1"
    done
}

@test "placement: an @docker middleware NOT declared on the traefik container fails" {
    api_edit middlewares '. + [{"name":"stray@docker","provider":"docker","type":"headers","headers":{}}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"middleware stray@docker is not declared on the traefik container's labels"* ]]
}

@test "placement: without exactly one traefik container the @docker placement cannot be established" {
    : > "${FAKE_DOCKER}/ps"
    fake_container c1 gremion-ui-blue "gremion-ui-blue gremion-public-blue" running healthy 0
    fake_container c2 keycloak "keycloak" running healthy 0 10.90.250.4
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"0 containers carry com.docker.compose.service=traefik"* ]]
}

@test "placement: docker ps failing is a failure, not an empty census" {
    : > "${FAKE_DOCKER}/ps-fails"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"middleware placement: docker ps failed"* ]]
}

@test "placement: a mixed-case middleware label on an app-tier container is still found" {
    fake_container c7 gremion-public-green "gremion-public-green" running healthy 0 "" \
        '{"Traefik.HTTP.Middlewares.Sneaky.headers.stsseconds":"1"}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"container gremion-public-green (app tier) declares middleware(s): sneaky"* ]]
}

@test "emitted: the same router name in two tenant files fails (slug a host #1 = slug a-1 host #0)" {
    emitted_file a-1 tenant-a1.example.org
    # slug a gains a second host whose router is named tenant-a-1 as well
    awk '{print} /^  routers:$/ && !d {print "    tenant-a-1:\n      rule: \"Host(`a2.example.org`)\""; d=1}' \
        "${GREMION_ROOT}/etc/edge/tenant-a.yml" > "${GREMION_ROOT}/etc/edge/t.new"
    mv "${GREMION_ROOT}/etc/edge/t.new" "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    api_edit routers '. + [{"name":"tenant-a-1@file","status":"enabled","entryPoints":["websecure"],
        "rule":"Host(`tenant-a1.example.org`)","service":"app@file","tls":{"certResolver":"le-http"},
        "middlewares":["edge-hostpin-a-1@file","edge-hsts-custom@docker","edge-ratelimit-app@docker"]}]'
    api_edit middlewares '. + [{"name":"edge-hostpin-a-1@file","provider":"file","type":"headers",
        "headers":{"customRequestHeaders":{"X-Forwarded-Host":"tenant-a1.example.org"}}},
        {"name":"edge-perip-a-1@file","provider":"file","type":"inflightreq","inFlightReq":{"amount":50}}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router name tenant-a-1 is declared in both etc/edge/tenant-a-1.yml and etc/edge/tenant-a.yml"* ]]
    [[ "$output" == *"emitted router tenant-a-1@file: traefik serves rule 'Host(\`tenant-a1.example.org\`)', but etc/edge/tenant-a.yml says 'Host(\`a2.example.org\`)'"* ]]
}

@test "emitted: a tenant-*.yaml sibling fails" {
    cp "${GREMION_ROOT}/etc/edge/tenant-a.yml" "${GREMION_ROOT}/etc/edge/tenant-z.yaml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-z.yaml: a tenant router file with a .yaml suffix"* ]]
}

@test "emitted: a tenant file whose name is not a slug is refused, not regex-interpolated" {
    cp "${GREMION_ROOT}/etc/edge/tenant-a.yml" "${GREMION_ROOT}/etc/edge/tenant-.+.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-.+.yml: not a tenant slug the emitter can produce"* ]]
}

@test "emitted: a missing etc/edge is a failure, not a pass" {
    rm -rf "${GREMION_ROOT}/etc/edge"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge does not exist"* ]]
}

@test "universal: an escaped double quote cannot hide a top-level ||" {
    rule_case whoami@docker 'Host(`tenant-a.example.org`) && Header(`X-Q`, "x\"") || PathPrefix(`/`) || Header(`X-Y`, "z")'
    [ "$status" -eq 1 ]
    [[ "$output" == *"router whoami@docker: rule contains a backslash escape"* ]]
}

@test "universal: an edge-ratelimit-* that is not a rate limiter does not count" {
    api_edit middlewares '(.[] | select(.name=="edge-ratelimit-app@docker")) |= {name, provider, type: "headers", headers: {}}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: no edge-ratelimit-* middleware"* ]]
}

@test "universal: a rate limiter with average 0 (no limit in traefik) does not count" {
    api_edit middlewares '(.[] | select(.name=="edge-ratelimit-app@docker")).rateLimit.average = 0'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-a@file: no edge-ratelimit-* middleware"* ]]
}

# ── middleware placement ─────────────────────────────────────────────────────

@test "placement: a middleware declared on an app-tier container fails, naming it" {
    : > "${FAKE_DOCKER}/ps"
    fake_container c1 gremion-ui-blue "gremion-ui-blue gremion-public-blue" running healthy 0 "" \
        '{"com.docker.compose.project":"prod-app-blue","traefik.http.middlewares.gremion-ui-starting.errors.status":"502-504"}'
    fake_container c2 keycloak "keycloak" running healthy 0 10.90.250.4
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"container gremion-ui-blue (app tier) declares middleware(s): gremion-ui-starting"* ]]
}

@test "placement: an app-tier container is recognised by its compose project too" {
    fake_container c5 prod-app-green-worker-1 "worker" running healthy 0 "" \
        '{"com.docker.compose.project":"prod-app-green","traefik.http.middlewares.x.headers.stsseconds":"1"}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"container prod-app-green-worker-1 (app tier) declares middleware(s): x"* ]]
}

@test "placement: middlewares on the traefik container are the design, not a failure" {
    # the green fixture's c9 is the traefik container declaring every @docker middleware
    grep -qx c9 "${FAKE_DOCKER}/ps"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" != *"placement"* ]]
    [[ "$output" != *"not declared on the traefik container"* ]]
}

@test "placement: a file-provider middleware outside the emitter contract fails" {
    api_edit middlewares '. + [{"name":"sneaky@file","provider":"file","type":"headers","headers":{}}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"middleware sneaky@file is declared by the file provider"* ]]
}

# ── check_emitted_routers ────────────────────────────────────────────────────

@test "emitted: a tenant file whose router traefik does not report fails" {
    emitted_file c tenant-c.example.org
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"emitted router tenant-c@file (etc/edge/tenant-c.yml) is not live in traefik"* ]]
}

@test "emitted: a tenant file declaring a middleware other than its pins and per-IP cap fails" {
    printf '    extra-mw:\n      headers:\n        stsSeconds: 1\n' >> "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-a.yml declares middleware extra-mw"* ]]
}

@test "emitted: a tenant file with a section other than routers and middlewares fails" {
    printf '  services:\n    x:\n      loadBalancer: {}\n' >> "${GREMION_ROOT}/etc/edge/tenant-b.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-b.yml declares http.services"* ]]
}

@test "emitted: a tenant file that declares no router fails" {
    printf 'http:\n  middlewares: {}\n' > "${GREMION_ROOT}/etc/edge/tenant-d.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-d.yml declares no router"* ]]
}

@test "emitted: a router in tenant-a.yml not named for tenant a fails" {
    sed -i 's/^    tenant-a:$/    tenant-b-1:/' "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-a.yml declares router tenant-b-1"* ]]
}

# A second router in tenant-a.yml, live in the fake traefik with the rule the file carries, the way
# the services wave emits tenant-<slug>.office (Collabora) and tenant-<slug>.kc beside the host router.
emitted_extra_router() {  # <router name> <service>
    local name="$1" svc="$2" rule='Host(`tenant-a.example.org`) && PathPrefix(`/office`)'
    awk -v n="$name" -v s="$svc" -v r="$rule" '
        {print}
        /^  routers:$/ && !d {
            print "    " n ":"
            print "      entryPoints: [\"websecure\"]"
            print "      rule: \"" r "\""
            print "      service: \"" s "\""
            print "      priority: 100"
            print "      middlewares:"
            print "        - \"edge-hostpin-a@file\""
            print "        - \"edge-hsts-custom@docker\""
            print "        - \"edge-ratelimit-app@docker\""
            print "      tls:"
            print "        certResolver: \"le-http\""
            d=1
        }' "${GREMION_ROOT}/etc/edge/tenant-a.yml" > "${GREMION_ROOT}/etc/edge/t.new"
    mv "${GREMION_ROOT}/etc/edge/t.new" "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    api_edit routers ". + [{\"name\":\"${name}@file\",\"status\":\"enabled\",\"entryPoints\":[\"websecure\"],
        \"rule\":\"${rule}\",\"service\":\"${svc}\",\"tls\":{\"certResolver\":\"le-http\"},
        \"middlewares\":[\"edge-hostpin-a@file\",\"edge-hsts-custom@docker\",\"edge-ratelimit-app@docker\"]}]"
    # collabora's docker-label service, which the office router targets
    api_edit services 'if any(.[]; .name == "collabora@docker") then . else . + [{"name":"collabora@docker","loadBalancer":{"servers":[{"url":"http://collabora:9980"}]}}] end'
}

@test "emitted: the services-wave routers tenant-<slug>.office and tenant-<slug>.kc are accepted" {
    emitted_extra_router tenant-a.office collabora@docker
    emitted_extra_router tenant-a.kc keycloak@docker
    run "$VERIFY" --hosts "$HOSTS"
    [[ "$output" != *"which is not tenant-a"* ]]
    [[ "$output" != *"tenant-a.office"* ]]
    [[ "$output" != *"tenant-a.kc"* ]]
}

@test "emitted: tenant-<slug>-<i>.office is accepted on an indexed host" {
    emitted_extra_router tenant-a-2.office collabora@docker
    run "$VERIFY" --hosts "$HOSTS"
    [[ "$output" != *"which is not tenant-a"* ]]
    [[ "$output" != *"tenant-a-2.office"* ]]
}

@test "emitted: a foreign or wider router name is still refused (other tenant, other suffix, indexed .kc, stacked suffixes)" {
    local bad
    for bad in tenant-b.office tenant-a.evil tenant-a-1.kc tenant-a.kc.office tenant-a.office.office tenant-a. tenant-ax.office; do
        emitted_file a tenant-a.example.org
        emitted_extra_router "$bad" collabora@docker
        run "$VERIFY" --hosts "$HOSTS"
        [ "$status" -eq 1 ]
        [[ "$output" == *"etc/edge/tenant-a.yml declares router ${bad}, which is not tenant-a"* ]]
    done
}

# ── the public portal's own host (docs/runbooks/public-portal-host.md) ───────
# etc/edge/public-host.yml is the one router file a person places by hand. The
# helpers below place the SHIPPED template (the host substituted, exactly what
# the runbook tells the operator to do) and add what traefik reports once it has
# loaded that file, so the file the repository ships is the file under test.
PORTAL_HOST="portal.customer.example"
PORTAL_TEMPLATE="${REPO_ROOT}/infra/host/templates/edge/public-host.example.yml"

portal_file() {  # <host>
    sed "s/portal\.customer\.example/$1/g" "$PORTAL_TEMPLATE" > "${GREMION_ROOT}/etc/edge/public-host.yml"
    grep -qF "Host(\`$1\`)" "${GREMION_ROOT}/etc/edge/public-host.yml"
}

portal_live() {  # <host> [service]
    local f svc="${2:-public@file}"
    f="${FAKE_HTTP}/api-http-routers.json"
    jq --arg h "$1" --arg s "$svc" '. + [{name: "public-host@file", status: "enabled", entryPoints: ["websecure"],
        rule: ("Host(`" + $h + "`)"), service: $s, tls: {certResolver: "le-http"},
        middlewares: ["edge-hostpin-public.portal@file", "edge-hsts-custom@docker", "edge-ratelimit-portal@docker"]}]' \
        "$f" > "${f}.new" && mv "${f}.new" "$f"
    f="${FAKE_HTTP}/api-http-middlewares.json"
    jq --arg h "$1" '. + [
        {name: "edge-hostpin-public.portal@file", provider: "file", type: "headers",
         headers: {customRequestHeaders: {"X-Forwarded-Host": $h}}},
        {name: "edge-ratelimit-portal@docker", provider: "docker", type: "ratelimit",
         rateLimit: {average: 100, burst: 50, period: "1m"}}]' "$f" > "${f}.new" && mv "${f}.new" "$f"
    f="${FAKE_DOCKER}/c9.labels"
    jq '. + {"traefik.http.middlewares.edge-ratelimit-portal.ratelimit.average": "100"}' "$f" > "${f}.new" && mv "${f}.new" "$f"
}

@test "portal host: the shipped template, placed and live, passes, and its host is certified like any other" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    printf '%s\n' "$PORTAL_HOST" >> "$HOSTS"
    fake_cert "$PORTAL_HOST" "DNS:${PORTAL_HOST}" 0
    fake_http "https://${PORTAL_HOST}:8443/whoami" 200 '{"ok":true,"app":"gremion-public"}'
    fake_http "https://${PORTAL_HOST}:8443/whoami" 200 '{"ok":true,"app":"gremion-public"}' forged
    fake_http "http://${PORTAL_HOST}:8090/.well-known/acme-challenge/probe" 404 ""
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"all checks passed"* ]]
    run jq -r '.routers[] | select(.name == "public-host@file") | "\(.class) \(.host) \(.san) \(.healthy)"' \
        "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "colour-bound ${PORTAL_HOST} true true" ]
}

@test "portal host: a placed file whose router traefik does not serve fails" {
    portal_file "$PORTAL_HOST"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"placed router public-host@file (etc/edge/public-host.yml) is not live in traefik (status=absent)"* ]]
}

@test "portal host: a rule in the placed file that is not the rule traefik serves fails" {
    portal_file "$PORTAL_HOST"
    portal_live "other.customer.example"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"placed router public-host@file: traefik serves rule 'Host(\`other.customer.example\`)', but etc/edge/public-host.yml says 'Host(\`${PORTAL_HOST}\`)'"* ]]
}

@test "portal host: a router that targets the app instead of the portal fails" {
    portal_file "$PORTAL_HOST"
    sed -i 's/service: "public@file"/service: "app@file"/' "${GREMION_ROOT}/etc/edge/public-host.yml"
    portal_live "$PORTAL_HOST" app@file
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router public-host@file targets 'app@file', not public@file"* ]]
}

# The router universal accepts ANY edge-ratelimit-* tier and says nothing about a
# middleware it does not know, so these two chains are green without the portal
# check: the app tier's 30-times-wider limit, and the app's shared-secret stamp.
@test "portal host: a chain with the app tier's rate limit instead of the portal's fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    api_edit routers 'map(if .name == "public-host@file" then .middlewares |= map(if . == "edge-ratelimit-portal@docker" then "edge-ratelimit-app@docker" else . end) else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router public-host@file chains 'edge-hostpin-public.portal@file edge-hsts-custom@docker edge-ratelimit-app@docker', not 'edge-hostpin-public.portal@file edge-hsts-custom@docker edge-ratelimit-portal@docker'"* ]]
}

@test "portal host: a chain that also carries the app's proxy-trust stamp fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    api_edit routers 'map(if .name == "public-host@file" then .middlewares += ["gremion-ui-proxytrust@docker"] else . end)'
    api_edit middlewares '. + [{"name":"gremion-ui-proxytrust@docker","provider":"docker","type":"headers","headers":{"customRequestHeaders":{"x-proxy-trust":"fixture"}}}]'
    jq '. + {"traefik.http.middlewares.gremion-ui-proxytrust.headers.customrequestheaders.x-proxy-trust": "fixture"}' \
        "${FAKE_DOCKER}/c9.labels" > "${FAKE_DOCKER}/c9.labels.new"
    mv "${FAKE_DOCKER}/c9.labels.new" "${FAKE_DOCKER}/c9.labels"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router public-host@file chains '"*"gremion-ui-proxytrust@docker', not 'edge-hostpin-public.portal@file edge-hsts-custom@docker edge-ratelimit-portal@docker'"* ]]
}

@test "portal host: a second router in the placed file fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    sed -i 's/^  middlewares:$/    tenant-a-9:\n      rule: "Host(`x.customer.example`)"\n  middlewares:/' "${GREMION_ROOT}/etc/edge/public-host.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/public-host.yml declares router tenant-a-9"* ]]
}

@test "portal host: a middleware other than its own pin in the placed file fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    printf '    edge-hostpin-a-7:\n      headers:\n        customRequestHeaders:\n          X-Forwarded-Host: "tenant-a.example.org"\n' \
        >> "${GREMION_ROOT}/etc/edge/public-host.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/public-host.yml declares middleware edge-hostpin-a-7"* ]]
}

@test "portal host: a section other than routers and middlewares in the placed file fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    printf '  services:\n    public:\n      loadBalancer: {}\n' >> "${GREMION_ROOT}/etc/edge/public-host.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/public-host.yml declares http.services"* ]]
}

@test "portal host: a placed file that declares no router fails" {
    printf 'http:\n  middlewares: {}\n' > "${GREMION_ROOT}/etc/edge/public-host.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/public-host.yml declares no router"* ]]
}

@test "portal host: a public-host.yaml sibling fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    cp "${GREMION_ROOT}/etc/edge/public-host.yml" "${GREMION_ROOT}/etc/edge/public-host.yaml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/public-host.yaml"* ]]
}

@test "portal host: the router served from a file of another name fails" {
    portal_file "$PORTAL_HOST"
    portal_live "$PORTAL_HOST"
    mv "${GREMION_ROOT}/etc/edge/public-host.yml" "${GREMION_ROOT}/etc/edge/portal.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"traefik serves router public-host@file, but etc/edge/public-host.yml does not exist"* ]]
}

@test "portal host: a tenant file cannot take the portal's router or pin name" {
    sed -i 's/^    tenant-a:$/    public-host:/' "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    printf '    edge-hostpin-public.portal:\n      headers:\n        customRequestHeaders:\n          X-Forwarded-Host: "tenant-a.example.org"\n' \
        >> "${GREMION_ROOT}/etc/edge/tenant-a.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/tenant-a.yml declares router public-host, which is not tenant-a"* ]]
    [[ "$output" == *"etc/edge/tenant-a.yml declares middleware edge-hostpin-public.portal"* ]]
}

@test "the router functions are wired into run_pass, in order" {
    local body
    body="$(sed -n '/^run_pass() {/,/^}/p' "$VERIFY")"
    [[ "$body" == *$'check_routers\n    check_router_universal\n    check_l4_routers\n    check_emitted_routers\n    check_middleware_placement'* ]]
}

# ── the six P4 waivers (B0) ──────────────────────────────────────────────────
# Test names are ASCII: bats 1.13 on the maintainer's Windows box cannot address
# a test whose name carries a non-ASCII byte and silently skips it, which is the
# vacuous pass these guards exist to prevent. "L:n" below means the ledger's
# section-L item n.
WAIVER_IDS=(offsite-backup-remote external-probe-and-alerting mail-bringup
            legal-documents apex-dns pilot-inputs)
WAIVER_LITEMS=(2 6 4 1 5 5)

@test "every P4 waiver is printed as WAIVED with its L item and never on an OK line" {
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" > "${BATS_TEST_TMPDIR}/verify.out"
    # ANSI first, THEN the anchor. ok() prints "$C_OK  OK$C_OFF   …" and C_OK is
    # non-empty whenever stderr is a tty, so `^[[:space:]]*OK` over the raw
    # capture only matches because bats is not a tty. Run against a coloured
    # capture the same assertion would match nothing and pass vacuously — which
    # is the failure class this file's header is about.
    sed -e 's/\x1b\[[0-9;]*m//g' "${BATS_TEST_TMPDIR}/verify.out" \
        > "${BATS_TEST_TMPDIR}/verify.plain"
    grep -E '^[[:space:]]*OK' "${BATS_TEST_TMPDIR}/verify.plain" \
        > "${BATS_TEST_TMPDIR}/verify.ok" || true
    # The vacuity floor for the "never on an OK line" half: with no OK lines at
    # all, "the id is not on one" proves nothing.
    [ -s "${BATS_TEST_TMPDIR}/verify.ok" ] \
        || { echo "no OK lines in the verifier output at all" >&2; false; }
    local i id item
    for i in "${!WAIVER_IDS[@]}"; do
        id="${WAIVER_IDS[$i]}"; item="${WAIVER_LITEMS[$i]}"
        run grep -qE "WAIVED .*${id} \(§L:${item}," "${BATS_TEST_TMPDIR}/verify.out"
        [ "$status" -eq 0 ] || { echo "no WAIVED line for ${id} (§L:${item})" >&2; false; }
        # A waiver rendered by ok() is the exact misreading the ledger exists to
        # prevent, so the OK lines are searched for the id explicitly.
        run grep -qF "${id}" "${BATS_TEST_TMPDIR}/verify.ok"
        [ "$status" -ne 0 ] || { echo "${id} appears on an OK line" >&2; false; }
    done
}

@test "last-verify.json records the six waivers as a third state, not as failures" {
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    run jq -r '.waivers | length' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "6" ]
    run jq -r '.waivers[] | select(.id=="mail-bringup") | "\(.lItem) \(.gate)"' \
        "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "4 G4-MAIL" ]
    run jq -r '.ok' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "true" ]
    run jq -r '.failures | length' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "0" ]
}

@test "a waiver row the reader cannot parse is loud, not a table one row shorter" {
    # Measured on the committed ledger before the parsed count became a
    # post-condition: one markdown-legal escaped pipe inside a cell made the
    # verifier print FIVE waivers, write waivers[] of length 5 and exit 0 -
    # apex-dns simply vanished, and every suite in the repository stayed green.
    # An under-reported waiver is the exact misreading the ledger exists to
    # prevent, so a row that looks like a waiver and does not parse is fatal.
    local scratch="${BATS_TEST_TMPDIR}/ledger.md"
    sed 's/the apex DNS edits/the apex \\| DNS edits/' \
        "${REPO_ROOT}/docs/ops/release-1-waivers.md" > "$scratch"
    grep -qF 'the apex \| DNS edits' "$scratch"   # the mutation really landed
    export GREMION_WAIVER_LEDGER="$scratch"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"6 row(s) look like waivers, 5 parsed"* ]]
}

@test "the installed verifier refuses to run when no ledger is reachable" {
    # An absent ledger is not "no waivers": it is a release tree that cannot
    # say what release 1 did not prove. Silence there is the failure mode the
    # ledger exists to prevent, so the verifier dies instead of printing green.
    # It is run from the INSTALLED layout because that is the only shape with
    # no ledger within reach at all - see install_verifier().
    local v; v="$(install_verifier)"
    rm -rf "${GREMION_ROOT}/current"
    run "$v" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release-1-waivers.md"* ]]
}

@test "the installed verifier verifies a release that has no current symlink yet" {
    # gremion-deploy runs the verifier at steps 9 and 11; $ROOT/current is not
    # moved onto the new release until step 12, and bootstrap.sh never creates
    # it at all. Before gremion-deploy exported the ledger of the release it is
    # deploying, the FIRST deploy on a freshly bootstrapped host died at step 9
    # with exit 2 and could never reach the step that would have created
    # current/ - the release this ledger is written for was undeployable.
    local v rel
    v="$(install_verifier)"
    rm -rf "${GREMION_ROOT}/current"
    rel="${GREMION_ROOT}/releases/dist-v1.2.3"
    mkdir -p "${rel}/docs/ops"
    cp "${REPO_ROOT}/docs/ops/release-1-waivers.md" "${rel}/docs/ops/release-1-waivers.md"
    export GREMION_WAIVER_LEDGER="${rel}/docs/ops/release-1-waivers.md"
    run "$v" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WAIVED"* ]]
    [[ "$output" == *"apex-dns"* ]]
    run jq -r '.waivers | length' "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "6" ]
}

@test "the installed verifier falls back to the ledger under current" {
    # Leg 3 of waiver_ledger_path: the installed copy has no sibling tree, so a
    # bare gremion-verify and the reboot gate read $(gremion_root)/current.
    # setup() put a ledger there.
    local v; v="$(install_verifier)"
    run "$v" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WAIVED"* ]]
}

@test "a verifier run out of a release tree reads that tree's own ledger" {
    # Leg 2. Mid-deploy there are two copies of the table on the box - the new
    # release's and the one current/ still points at - and one of them belongs
    # to the release that is NOT being verified. A verifier invoked from inside
    # a checkout reads that checkout and cannot drift from itself.
    rm -rf "${GREMION_ROOT}/current"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WAIVED"* ]]
    [[ "$output" == *"apex-dns"* ]]
}

@test "bootstrap installs and enables the L:3 reboot gate, and its unit runs the verifier" {
    local bs="${REPO_ROOT}/infra/host/bootstrap.sh"
    local unit="${REPO_ROOT}/infra/host/templates/systemd/gremion-verify.service"
    # The ledger promises section-L item 3 is not waived. Nothing asserted the
    # install: ops.bats pins the unit's CONTENT, this pins that bootstrap ships it.
    [ -f "$unit" ]
    grep -qF 'gremion-verify.service' "$bs"
    grep -qF 'systemctl enable gremion-verify.service' "$bs"
    grep -qF 'assert "gremion-verify.service enabled at boot"' "$bs"
    grep -q  '^WantedBy=multi-user.target' "$unit"
    grep -q  '^ExecStart=${GREMION_ROOT}/bin/gremion-verify --reboot$' "$unit"
    # And the ledger must still refuse to waive it.
    run grep -nE '^\| `[a-z0-9-]+` \| §L:3 \|' "${REPO_ROOT}/docs/ops/release-1-waivers.md"
    [ "$status" -ne 0 ]
}


# ── the control panel's public router (docs/runbooks/control-panel-access.md) ─
# etc/edge/control-panel.yml is rendered by gremion-render on an opt-in install
# only. The verifier holds the running system to the whole of it, and treats the
# control host as the client-certificate host: a TLS handshake refusal WITHOUT a
# certificate is the expected, ASSERTED result there (never skipped), and an HTTP
# answer is the failure.
CONTROL_HOST="control.example.org"
CONTROL_TEMPLATE="${REPO_ROOT}/infra/host/templates/edge/control-panel.yml.tmpl"
CONTROL_RULE='Host(`control.example.org`) && !PathPrefix(`/healthz`) && !PathPrefix(`/api/internal`)'

control_file() {
    sed -e "s/\\\${CONTROL_HOST}/${CONTROL_HOST}/g" -e 's/\${TRAEFIK_CERT_RESOLVER}/le-http/g' \
        "$CONTROL_TEMPLATE" > "${GREMION_ROOT}/etc/edge/control-panel.yml"
    grep -qF "Host(\`${CONTROL_HOST}\`)" "${GREMION_ROOT}/etc/edge/control-panel.yml"
}

control_ca() {
    mkdir -p "${GREMION_ROOT}/etc/edge/mtls"
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE-CA\n-----END CERTIFICATE-----\n' > "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
}

control_live() {
    api_edit routers '. + [{"name":"control-panel@file","status":"enabled","entryPoints":["websecure"],
        "rule":"Host(`'"${CONTROL_HOST}"'`) && !PathPrefix(`/healthz`) && !PathPrefix(`/api/internal`)",
        "service":"panel@file","tls":{"certResolver":"le-http","options":"control-panel-mtls@file"},
        "middlewares":["edge-hostpin-control@docker","edge-hsts-platform@docker","edge-ratelimit-portal@docker"]}]'
    api_edit services '. + [{"name":"panel@file","loadBalancer":{"servers":[{"url":"http://control-panel-blue:3000"}]},"serverStatus":{"http://control-panel-blue:3000":"UP"}}]'
    api_edit middlewares '. + [
        {"name":"edge-hostpin-control@docker","provider":"docker","type":"headers",
         "headers":{"customRequestHeaders":{"X-Forwarded-Host":"'"${CONTROL_HOST}"'"}}},
        {"name":"edge-hsts-platform@docker","provider":"docker","type":"headers","headers":{"stsSeconds":31536000}}]'
    fake_container c5 control-panel-blue "control-panel-blue" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-blue.env"
    fake_cert "$CONTROL_HOST" "DNS:${CONTROL_HOST}" 0
    fake_http "http://${CONTROL_HOST}:8090/.well-known/acme-challenge/probe" 404 ""
    : > "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    printf 'CONTROL_PANEL_ORIGIN=https://%s\n' "$CONTROL_HOST" >> "${GREMION_ROOT}/etc/env/state.env"
    # a host other than the default control.<domain> is the install's CONTROL_PANEL_HOST
    [ "$CONTROL_HOST" = "control.example.org" ] || printf 'CONTROL_PANEL_HOST=%s\n' "$CONTROL_HOST" >> "${GREMION_ROOT}/etc/env/state.env"
    printf '%s\n' "$CONTROL_HOST" >> "$HOSTS"
}

# The same install with the panel on a host OUTSIDE the platform domain (CONTROL_PANEL_HOST).
custom_control_host() {
    CONTROL_HOST="panel.example.com"
    CONTROL_RULE='Host(`panel.example.com`) && !PathPrefix(`/healthz`) && !PathPrefix(`/api/internal`)'
}

control_all() { control_file; control_ca; control_live; }

@test "control panel: the rendered file, its CA and the live router pass, and the refusal without a client certificate is asserted" {
    control_all
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://${CONTROL_HOST}/ refused the handshake without a client certificate (TLS alert)"* ]]
    # the panel's service is colour-bound: its container is censused like gremion-ui's
    run jq -r '.routers[] | select(.name == "control-panel@file") | "\(.class) \(.host) \(.san) \(.healthy)"' \
        "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "colour-bound ${CONTROL_HOST} true true" ]
}

@test "control panel: traefik must report the panel's server UP: a server it cannot reach (DOWN) or one with no status fails, though its container is censused healthy" {
    control_all
    # the container answers to the alias on the STATE network and is healthy there, so the census passes; what
    # fails is Traefik's own dial (the panel is not on the edge network, or not listening)
    api_edit services 'map(if .name == "panel@file" then .serverStatus = {"http://control-panel-blue:3000":"DOWN"} else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"service panel@file: traefik reports its server http://control-panel-blue:3000 as DOWN"* ]]
    [[ "$output" == *"docker-compose.control-public.yml"* ]]
    api_edit services 'map(if .name == "panel@file" then del(.serverStatus) else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"service panel@file: traefik reports no status for its server http://control-panel-blue:3000"* ]]
    api_edit services 'map(if .name == "panel@file" then .serverStatus = {"http://control-panel-blue:3000":"UP"} else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
}

@test "control panel: opted in, a colour with no panel container fails (the origin cannot be judged), with the router live" {
    control_all
    sed -i '/^c5$/d' "${FAKE_DOCKER}/ps"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no container answers to 'control-panel-blue': the panel the control host routes to is not running"* ]]
}

@test "control panel, first opted-in deploy: the colour being verified has no panel container, step 9 fails (it was skipped without a word)" {
    render_step4 nopanel
    prepare_green_colour
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no container answers to 'control-panel-green': the panel the control host routes to is not running"* ]]
}

@test "control panel: the control host is certified like any other host (a certificate without its SAN fails)" {
    control_all
    fake_cert "$CONTROL_HOST" "DNS:other.example.org" 0
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for ${CONTROL_HOST} has no matching SAN"* ]]
}

@test "control panel: a connection WITHOUT a client certificate that gets an HTTP answer fails (the gate is open)" {
    control_all
    rm -f "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    fake_http "https://${CONTROL_HOST}:8443/" 200 "the panel login"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"https://${CONTROL_HOST}/ answered HTTP 200 to a connection WITHOUT a client certificate: the client-certificate gate is open"* ]]
}

@test "control panel: a host that closes the connection with no TLS alert fails (traefik cannot build the option)" {
    control_all
    rm -f "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    : > "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlseof"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"closed the connection with no TLS alert: traefik cannot build the client-certificate option"* ]]
}

@test "control panel: a host that is down proves no refusal and fails" {
    control_all
    rm -f "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    fake_http_unreachable "https://${CONTROL_HOST}:8443/"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the refusal of a connection without a client certificate could not be established (curl exit 7)"* ]] \
        || [[ "$output" == *"could not be established (curl exit"* ]]
}

@test "control panel: the opt-in key without the rendered file fails" {
    control_all
    rm "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"CONTROL_PANEL_ORIGIN is set in state.env but etc/edge/control-panel.yml does not exist"* ]]
    [[ "$output" == *"traefik serves router control-panel@file, but etc/edge/control-panel.yml does not exist"* ]]
}

@test "control panel: a rendered file without the opt-in key fails (a stale router nobody opted into)" {
    control_all
    sed -i '/^CONTROL_PANEL_ORIGIN=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/control-panel.yml exists but CONTROL_PANEL_ORIGIN is empty in state.env"* ]]
}

@test "control panel: a weaker clientAuthType in the file fails" {
    control_all
    sed -i 's/RequireAndVerifyClientCert/VerifyClientCertIfGiven/' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"clientAuthType must appear once and be RequireAndVerifyClientCert"* ]]
}

@test "control panel: a second clientAuthType line in the file fails" {
    control_all
    sed -i 's/^        clientAuthType: RequireAndVerifyClientCert$/&\n        clientAuthType: NoClientCert/' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"clientAuthType must appear once and be RequireAndVerifyClientCert (found 2)"* ]]
}

@test "control panel: a rule that does not exclude the probe paths fails, in the file and in what traefik serves" {
    control_all
    sed -i 's/ \&\& !PathPrefix(`\/healthz`)//' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    api_edit routers 'map(if .name == "control-panel@file" then .rule = "Host(`control.example.org`) && !PathPrefix(`/api/internal`)" else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/control-panel.yml: the rule is 'Host(\`control.example.org\`) && !PathPrefix(\`/api/internal\`)', not '${CONTROL_RULE}'"* ]]
    [[ "$output" == *"router control-panel@file serves rule 'Host(\`control.example.org\`) && !PathPrefix(\`/api/internal\`)', not '${CONTROL_RULE}'"* ]]
}

@test "control panel: a router that traefik serves without the client-certificate option fails" {
    control_all
    api_edit routers 'map(if .name == "control-panel@file" then .tls = {"certResolver":"le-http"} else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file carries TLS option '', not control-panel-mtls: the host would be served without asking for a client certificate"* ]]
}

@test "control panel: a chain without the portal-tier rate limit, or with the app tier's or the auth tier's, fails" {
    control_all
    api_edit routers 'map(if .name == "control-panel@file" then .middlewares |= map(if . == "edge-ratelimit-portal@docker" then "edge-ratelimit-app@docker" else . end) else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file chains 'edge-hostpin-control@docker edge-hsts-platform@docker edge-ratelimit-app@docker', not 'edge-hostpin-control@docker edge-hsts-platform@docker edge-ratelimit-portal@docker'"* ]]
    # the auth tier is the tier of the sign-in path, not of a host that serves a whole page of assets: it would 429 a first load
    api_edit routers 'map(if .name == "control-panel@file" then .middlewares |= map(if . == "edge-ratelimit-app@docker" then "edge-ratelimit-auth@docker" else . end) else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file chains 'edge-hostpin-control@docker edge-hsts-platform@docker edge-ratelimit-auth@docker', not 'edge-hostpin-control@docker edge-hsts-platform@docker edge-ratelimit-portal@docker'"* ]]
}

@test "control panel: a router that targets the app instead of the panel fails" {
    control_all
    api_edit routers 'map(if .name == "control-panel@file" then .service = "app@file" else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file targets 'app@file', not panel@file"* ]]
}

@test "control panel: another router on the control host fails (it would be served without the option)" {
    control_all
    api_edit routers '. + [{"name":"stray@docker","status":"enabled","entryPoints":["websecure"],
        "rule":"Host(`Control.Example.org`) && PathPrefix(`/x`)","service":"keycloak@docker","tls":{"certResolver":"le-http"},
        "middlewares":["edge-hostpin-a@file","edge-hsts-custom@docker","edge-ratelimit-app@docker"]}]'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router(s) stray@docker name the control host ${CONTROL_HOST}"* ]]
}

@test "control panel: a router served without its file, on a host that did not opt in, fails" {
    control_live
    sed -i '/^CONTROL_PANEL_ORIGIN=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"traefik serves router control-panel@file, but etc/edge/control-panel.yml does not exist"* ]]
}

@test "control panel: a file that declares a second router, a service or a certificate store fails" {
    control_all
    printf '    other:\n      rule: "Host(`x.example.org`)"\n  services:\n    s:\n      loadBalancer: {}\n' >> "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/control-panel.yml declares router other"* ]]
    [[ "$output" == *"etc/edge/control-panel.yml declares services"* ]]
}

@test "control panel: a running panel whose ORIGIN is not the opted-in origin fails (read from the container, not from a file)" {
    control_all
    printf 'ORIGIN=http://127.0.0.1:3043\n' > "${FAKE_DOCKER}/control-panel-blue.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-blue: the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN"* ]]
    # the origin is compared as a literal: a dot is not a wildcard (a regex match let a look-alike pass)
    printf 'ORIGIN=https://controlXexample.org\n' > "${FAKE_DOCKER}/control-panel-blue.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-blue: the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN"* ]]
}

@test "control panel: a missing CA file fails" {
    control_all
    rm "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/mtls/operator-ca.pem is missing or empty"* ]]
}

@test "control panel: a CA file that holds a private key fails (the host never holds the CA key)" {
    control_all
    printf -- '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n' >> "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/mtls/operator-ca.pem contains a private key"* ]]
}

@test "control panel: a CA file whose certificate is not a CA, or is about to expire, fails" {
    control_all
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE-CA FAKE-CA-LEAF\n-----END CERTIFICATE-----\n' > "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"holds a certificate (#1 of 1) that is not a CA certificate"* ]]
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE-CA FAKE-CA-EXPIRING\n-----END CERTIFICATE-----\n' > "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"holds a certificate (#1 of 1) that expires within"* ]]
}

@test "control panel: every certificate of the CA file is held to the CA and expiry rules, not only the first" {
    control_all
    # a good CA first, a client (non-CA) certificate behind it
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE-CA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nFAKE-CA FAKE-CA-LEAF\n-----END CERTIFICATE-----\n' > "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"holds a certificate (#2 of 2) that is not a CA certificate"* ]]
    # an old CA that is about to expire, kept beside the new one for a staged rotation
    printf -- '-----BEGIN CERTIFICATE-----\nFAKE-CA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nFAKE-CA FAKE-CA-EXPIRING\n-----END CERTIFICATE-----\n' > "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"holds a certificate (#2 of 2) that expires within"* ]]
}

# An install that has NOT opted in: the panel is the tunnel's, and its running ORIGIN is the loopback.
panel_without_optin() {   # <ORIGIN the running panel carries>
    api_edit services '. + [{"name":"panel@file","loadBalancer":{"servers":[{"url":"http://control-panel-blue:3000"}]}}]'
    fake_container c5 control-panel-blue "control-panel-blue" running healthy 0
    printf 'ORIGIN=%s\n' "$1" > "${FAKE_DOCKER}/control-panel-blue.env"
}

@test "control panel: the key turned off but a colour still running with the public ORIGIN fails (the tunnel would be refused), and the loopback ORIGIN passes" {
    panel_without_optin "https://${CONTROL_HOST}"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-blue: the running panel's ORIGIN is not the loopback default http://127.0.0.1:3043"* ]]
    panel_without_optin "http://127.0.0.1:3043"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
}

@test "control panel: step 9 judges the colour being verified (its panel is the one the switch puts live), not the live colour's panel" {
    render_step4 nopanel
    prepare_green_colour
    # the LIVE (blue) panel still has the previous release's ORIGIN; the colour about to go live is right
    api_edit services '. + [{"name":"panel@file","loadBalancer":{"servers":[{"url":"http://control-panel-blue:3000"}]}}]'
    fake_container c5 control-panel-blue "control-panel-blue" running healthy 0
    printf 'ORIGIN=http://127.0.0.1:3043\n' > "${FAKE_DOCKER}/control-panel-blue.env"
    fake_container c6 control-panel-green "control-panel-green" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    # the colour about to go live still carries the old ORIGIN: the switch would put an unreachable panel live
    printf 'ORIGIN=http://127.0.0.1:3043\n' > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-green: the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN"* ]]
}

@test "control panel: the router universal still holds the control router (a missing pin fails like any other)" {
    control_all
    api_edit routers 'map(if .name == "control-panel@file" then .middlewares |= .[1:] else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file: 0 host pins (expected exactly 1)"* ]]
}

@test "control panel: a host WITHOUT the opt-in verifies the control host over HTTP exactly as before, and asks for no refusal" {
    printf '%s\n' "$CONTROL_HOST" >> "$HOSTS"
    fake_cert "$CONTROL_HOST" "DNS:${CONTROL_HOST}" 0
    fake_http "https://${CONTROL_HOST}:8443/whoami" 200 "colour=blue xfh=${CONTROL_HOST}"
    fake_http "https://${CONTROL_HOST}:8443/whoami" 200 "colour=blue xfh=${CONTROL_HOST}" forged
    fake_http "http://${CONTROL_HOST}:8090/.well-known/acme-challenge/probe" 404 ""
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" != *"refused the handshake"* ]]
    [[ "$output" == *"all checks passed"* ]]
}

@test "control panel: the control host's certificate is awaited, and one that appears within the wait passes" {
    control_all
    # right after the switch the edge still presents the default certificate for the control host
    fake_cert "$CONTROL_HOST" "DNS:traefik-default.invalid" 0
    # the edge presents the right certificate from the THIRD time it is asked (the ACME order finishing)
    printf 'X509v3 Subject Alternative Name: \n    DNS:%s\n' "$CONTROL_HOST" > "${FAKE_TLS}/${CONTROL_HOST}.good-san"
    printf '2' > "${FAKE_TLS}/${CONTROL_HOST}.flip-after"
    CONTROL_CERT_WAIT_SECONDS=40 CONTROL_CERT_POLL_SECONDS=1 run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"waiting up to 40s for its certificate"* ]]
    [[ "$output" == *"refused the handshake without a client certificate"* ]]
}

@test "control panel: a certificate that never appears fails after the wait, with the SAN failure" {
    control_all
    fake_cert "$CONTROL_HOST" "DNS:traefik-default.invalid" 0
    CONTROL_CERT_WAIT_SECONDS=2 CONTROL_CERT_POLL_SECONDS=1 run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for ${CONTROL_HOST} has no matching SAN"* ]]
}

# ── the first opted-in deploy: step 4 (render) -> step 9 (verify) -> step 10 ──
# gremion-deploy renders at step 4 with --defer-control-panel, verifies the new
# colour at step 9 with --control-after-switch, and only step 10 (after the
# switch) writes the router. The state in between is "key set, no file, no
# router in traefik", and step 9 must accept exactly that and nothing wider.
# Each side was green against its own test while the two contradicted each
# other; these tests run the REAL render and the REAL verifier on one root.
RENDER="${REPO_ROOT}/infra/host/bin/gremion-render"

# render_step4 <panel|nopanel> -- the real gremion-render, exactly as deploy step 4
# calls it, on an opted-in root whose etc/edge/active.yml has (or lacks) the panel
# service. The render runs with the shims off PATH (it needs the real openssl);
# the verifier gets its fake CA file back afterwards, since the CA's content is
# not what is under test here.
render_step4() {
    local rel="${GREMION_ROOT}/releases/dist-v1.0.0" realpath="${PATH#"${SHIM_DIR}":}" ca="${BATS_TEST_TMPDIR}/realca"
    mkdir -p "$rel/docker/pgbouncer" "$rel/docker/keycloak/certs" "$rel/legal" "$rel/infra/host/templates/edge" "$ca" "${GREMION_ROOT}/etc/edge/mtls"
    printf '#!/usr/bin/env bash\ncd "$(dirname "$0")"\necho mint > internal-ca.crt; cp internal-ca.crt internal-ca.pem\necho k > internal-ca.key; echo c > keycloak.crt; echo k > keycloak.key\n' \
        > "$rel/docker/keycloak/certs/gen-internal-ca.sh"
    chmod +x "$rel/docker/keycloak/certs/gen-internal-ca.sh"
    tr -d '\r' < "${REPO_ROOT}/legal/legal.env.example" > "$rel/legal/legal.env.example"
    tr -d '\r' < "${REPO_ROOT}/legal/legal.env.example" | sed \
        -e 's|^ORG_NAME=.*|ORG_NAME=Beispielgremium|' \
        -e 's|^ORG_ADDRESS=.*|ORG_ADDRESS=Beispielweg 2, 54321 Beispielstadt|' \
        -e 's|^ORG_EMAIL=.*|ORG_EMAIL=kontakt@beispiel.example|' \
        -e 's|^RESPONSIBLE_PERSON=.*|RESPONSIBLE_PERSON=Erika Beispiel|' \
        -e 's|^RESPONSIBLE_PERSON_EMAIL=.*|RESPONSIBLE_PERSON_EMAIL=datenschutz@beispiel.example|' \
        -e 's|^DOMAIN=.*|DOMAIN=example.org|' > "${GREMION_ROOT}/etc/legal.env"
    cp "$CONTROL_TEMPLATE" "$rel/infra/host/templates/edge/"
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=staging
COMPOSE_PROJECT_NAME=staging-state
COMPOSE_FILE=docker-compose.yml
PLATFORM_DOMAIN=example.org
ACME_EMAIL=ops@example.org
TRAEFIK_CERT_RESOLVER=le-http
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
EDGE_HTTP_PORT=8090
EDGE_HTTPS_PORT=8443
MAIL_BIND_IP=127.0.0.1
MAIL_BIND_IP6=::1
EDGE_V4_SUBNET=10.90.0.0/24
EDGE_V6_SUBNET=fd5a:90::/64
STATE_V4_SUBNET=10.90.1.0/24
STATE_V6_SUBNET=fd5a:91::/64
IMAGE_TAG=dist-v1.0.0
PGBOUNCER_AUTH_PASSWORD=test-secret-pgbouncer
LIVEKIT_API_KEY=lk-key
LIVEKIT_API_SECRET=lk-secret
PILOT_TENANT_HOST=pilot.example.org
HEALTH_EXEMPT_SERVICES=minio-mc
CONTROL_PANEL_ORIGIN=https://control.example.org
EOF
    if [ "$CONTROL_HOST" != "control.example.org" ]; then
        sed -i "s|^CONTROL_PANEL_ORIGIN=.*|CONTROL_PANEL_ORIGIN=https://${CONTROL_HOST}|" "${GREMION_ROOT}/etc/env/state.env"
        printf 'CONTROL_PANEL_HOST=%s\n' "$CONTROL_HOST" >> "${GREMION_ROOT}/etc/env/state.env"
    fi
    env PATH="$realpath" openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$ca/ca.key" -out "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem" \
        -days 30 -subj "/CN=bats operator CA" -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null
    printf 'http:\n  services:\n    app:\n      loadBalancer: {}\n' > "${GREMION_ROOT}/etc/edge/active.yml"
    [ "$1" != "panel" ] || printf '    panel:\n      loadBalancer: {}\n' >> "${GREMION_ROOT}/etc/edge/active.yml"
    run env PATH="$realpath" "$RENDER" --release "$rel" --defer-control-panel
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"the router is written after the switch"* ]]
    [ ! -e "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    cp "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem" "${BATS_TEST_TMPDIR}/real-operator-ca.pem"
    control_ca
    printf '%s\n' "$CONTROL_HOST" >> "$HOSTS"
}

@test "control panel, first opted-in deploy: the real render defers the router and the real step-9 verify accepts that state (no panel service in active.yml yet)" {
    render_step4 nopanel
    prepare_green_colour
    # the colour being verified HAS a panel container (started under the opted-in app env): its ORIGIN is judged
    fake_container c6 control-panel-green "control-panel-green" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"opted in, router not written yet"* ]]
    [[ "$output" == *"its router is written after the switch"* ]]
    [[ "$output" != *"CONTROL_PANEL_ORIGIN is set in state.env"* ]]
    # and the same state with the loopback ORIGIN in that container is a failure, so the pass above judged something
    printf 'ORIGIN=http://127.0.0.1:3043\n' > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-green: the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN"* ]]
}

@test "control panel, opting in on a host that already switched to this release: the same state, the same verdict (panel service already in active.yml)" {
    render_step4 panel
    prepare_green_colour
    fake_container c6 control-panel-green "control-panel-green" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"opted in, router not written yet"* ]]
    printf 'ORIGIN=http://127.0.0.1:3043\n' > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"control-panel-green: the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN"* ]]
}

@test "control panel, a routine redeploy (router already rendered and live): the real step-4 render keeps it, the real step-9 verify holds it to every check, and step 11 passes" {
    render_step4 panel
    # an earlier deploy's switch left the router: render it as the deploy's step 10 does, then let traefik serve it
    cp "${BATS_TEST_TMPDIR}/real-operator-ca.pem" "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run env PATH="${PATH#"${SHIM_DIR}":}" "$RENDER" --release "${GREMION_ROOT}/releases/dist-v1.0.0" --control-panel-only
    echo "$output"
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    control_ca
    control_live
    sort -u "${GREMION_ROOT}/etc/env/state.env" > "${BATS_TEST_TMPDIR}/s.env"
    cp "${BATS_TEST_TMPDIR}/s.env" "${GREMION_ROOT}/etc/env/state.env"
    prepare_green_colour
    fake_container c6 control-panel-green "control-panel-green" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-green.env"
    # step 4 of the next deploy: the router is checked and left in place, not rewritten before the switch
    cp "${BATS_TEST_TMPDIR}/real-operator-ca.pem" "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run env PATH="${PATH#"${SHIM_DIR}":}" "$RENDER" --release "${GREMION_ROOT}/releases/dist-v1.0.0" --defer-control-panel
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/etc/edge/control-panel.yml" ]
    control_ca
    # step 9 (before the switch)
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://${CONTROL_HOST}/ refused the handshake without a client certificate"* ]]
    # step 11 (after the switch): no flag, the live colour
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "control panel: the state step 4 leaves is a FAILURE for every later verify (step 11, a cron run): the flag opens nothing else" {
    render_step4 nopanel
    prepare_green_colour
    run "$VERIFY" --colour green --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"CONTROL_PANEL_ORIGIN is set in state.env but etc/edge/control-panel.yml does not exist"* ]]
    [[ "$output" == *"certificate for ${CONTROL_HOST} has no matching SAN"* ]]
}

@test "control panel: --control-after-switch tolerates only an absent router: Traefik serving one without its file still fails" {
    render_step4 nopanel
    control_live
    # control_live repeats the key and the host line render_step4 already wrote
    sort -u "${GREMION_ROOT}/etc/env/state.env" > "${BATS_TEST_TMPDIR}/s.env"
    cp "${BATS_TEST_TMPDIR}/s.env" "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"traefik serves router control-panel@file, but etc/edge/control-panel.yml does not exist"* ]]
}

@test "control panel: --control-after-switch holds a stray router on the control host" {
    render_step4 nopanel
    api_edit routers '. + [{"name":"stray@docker","status":"enabled","entryPoints":["websecure"],
        "rule":"Host(`control.example.org`) && PathPrefix(`/x`)","service":"keycloak@docker","tls":{"certResolver":"le-http"},
        "middlewares":["edge-hostpin-a@file","edge-hsts-custom@docker","edge-ratelimit-app@docker"]}]'
    run "$VERIFY" --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router(s) stray@docker name the control host ${CONTROL_HOST}"* ]]
}

@test "control panel: --control-after-switch still holds an EXISTING router to every check (a weaker clientAuthType fails)" {
    control_all
    sed -i 's/RequireAndVerifyClientCert/VerifyClientCertIfGiven/' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"clientAuthType must appear once and be RequireAndVerifyClientCert"* ]]
}

@test "control panel: --control-after-switch without the opt-in key changes nothing (a stale router still fails)" {
    control_all
    sed -i '/^CONTROL_PANEL_ORIGIN=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --control-after-switch --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/control-panel.yml exists but CONTROL_PANEL_ORIGIN is empty in state.env"* ]]
}

@test "control panel: a router whose host merely ENDS in control.<domain> is not on the control host (an install without the opt-in stays green)" {
    api_edit routers '. + [{"name":"bird@docker","status":"enabled","entryPoints":["websecure"],
        "rule":"Host(`birdcontrol.example.org`)","service":"whoami",
        "tls":{"certResolver":"le-http"},
        "middlewares":["edge-hostpin-bird@file","edge-hsts-custom@docker","edge-ratelimit-app@docker"]}]'
    api_edit middlewares '. + [{"name":"edge-hostpin-bird@file","provider":"file","type":"headers",
        "headers":{"customRequestHeaders":{"X-Forwarded-Host":"birdcontrol.example.org"}}}]'
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [[ "$output" != *"name the control host"* ]]
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------------------
# CONTROL_PANEL_HOST: the panel on a host OUTSIDE the platform domain. The verifier judges
# the configured host everywhere it used to judge control.<PLATFORM_DOMAIN>: the default
# host list, the certificate's SAN, the handshake refusal without a client certificate,
# the router's rule and the ORIGIN. The real render and the real verifier meet here too.
# ---------------------------------------------------------------------------

@test "control panel host: the default host list names the configured host, not control.<domain>" {
    printf 'CONTROL_PANEL_HOST=panel.example.com\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY"
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for panel.example.com has no matching SAN"* ]]
    [[ "$output" != *"control.example.org"* ]]
}

@test "control panel host: a custom host passes with its own certificate, router rule and ORIGIN, and the refusal without a client certificate is asserted for IT" {
    custom_control_host
    control_all
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://panel.example.com/ refused the handshake without a client certificate (TLS alert)"* ]]
    run jq -r '.routers[] | select(.name == "control-panel@file") | "\(.class) \(.host) \(.san) \(.healthy)"' \
        "${GREMION_ROOT}/runtime/last-verify.json"
    [ "$output" = "colour-bound panel.example.com true true" ]
}

@test "control panel host: with a custom host the SAN, the handshake, the rule and the ORIGIN are each judged against that host" {
    custom_control_host
    control_all
    # the certificate is for the default name: no SAN for the configured host
    fake_cert "$CONTROL_HOST" "DNS:control.example.org" 0
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"certificate for panel.example.com has no matching SAN"* ]]
    fake_cert "$CONTROL_HOST" "DNS:${CONTROL_HOST}" 0
    # a gate that is open on the configured host
    rm -f "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    fake_http "https://${CONTROL_HOST}:8443/" 200 "the panel login"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"https://panel.example.com/ answered HTTP 200 to a connection WITHOUT a client certificate"* ]]
    : > "${FAKE_HTTP}/probe-$(slug "https://${CONTROL_HOST}:8443/").tlsrefused"
    # traefik serves the router on the default name instead
    api_edit routers 'map(if .name == "control-panel@file" then .rule = "Host(`control.example.org`) && !PathPrefix(`/healthz`) && !PathPrefix(`/api/internal`)" else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router control-panel@file serves rule 'Host(\`control.example.org\`)"* ]]
    [[ "$output" == *"not '${CONTROL_RULE}'"* ]]
    api_edit routers 'map(if .name == "control-panel@file" then .rule = "Host(`panel.example.com`) && !PathPrefix(`/healthz`) && !PathPrefix(`/api/internal`)" else . end)'
    # the Traefik container still stamps the default name (its labels are read when it is created, and the
    # deploy does not recreate it): the host pin of the control router must stamp the configured host
    api_edit middlewares 'map(if .name == "edge-hostpin-control@docker" then .headers.customRequestHeaders["X-Forwarded-Host"] = "control.example.org" else . end)'
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"edge-hostpin-control"* ]]
    api_edit middlewares 'map(if .name == "edge-hostpin-control@docker" then .headers.customRequestHeaders["X-Forwarded-Host"] = "panel.example.com" else . end)'
    # the panel runs with the default name's origin
    printf 'ORIGIN=https://control.example.org\n' > "${FAKE_DOCKER}/control-panel-blue.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the running panel's ORIGIN is not CONTROL_PANEL_ORIGIN (https://panel.example.com)"* ]]
}

@test "control panel host: CONTROL_PANEL_ORIGIN that is not https://<the configured host> fails, and an invalid host is refused before any check (exit 2)" {
    custom_control_host
    control_all
    sed -i 's|^CONTROL_PANEL_ORIGIN=.*|CONTROL_PANEL_ORIGIN=https://control.example.org|' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"CONTROL_PANEL_ORIGIN (https://control.example.org) is not https://panel.example.com"* ]]
    sed -i 's|^CONTROL_PANEL_HOST=.*|CONTROL_PANEL_HOST=Panel.example.com|' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CONTROL_PANEL_HOST is refused: it is not lowercase"* ]]
    sed -i 's|^CONTROL_PANEL_HOST=.*|CONTROL_PANEL_HOST=example.org|' "${GREMION_ROOT}/etc/env/state.env"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 2 ]
    [[ "$output" == *"it is the platform domain itself"* ]]
}

@test "control panel host: the real render and the real verifier agree on a custom host across step 4, step 9 and step 11" {
    custom_control_host
    render_step4 panel
    cp "${BATS_TEST_TMPDIR}/real-operator-ca.pem" "${GREMION_ROOT}/etc/edge/mtls/operator-ca.pem"
    run env PATH="${PATH#"${SHIM_DIR}":}" "$RENDER" --release "${GREMION_ROOT}/releases/dist-v1.0.0" --control-panel-only
    echo "$output"
    [ "$status" -eq 0 ]
    grep -qF 'Host(`panel.example.com`)' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    control_ca
    control_live
    sort -u "${GREMION_ROOT}/etc/env/state.env" > "${BATS_TEST_TMPDIR}/s.env"
    cp "${BATS_TEST_TMPDIR}/s.env" "${GREMION_ROOT}/etc/env/state.env"
    prepare_green_colour
    fake_container c6 control-panel-green "control-panel-green" running healthy 0
    printf 'ORIGIN=https://%s\n' "$CONTROL_HOST" > "${FAKE_DOCKER}/control-panel-green.env"
    run "$VERIFY" --colour green --control-after-switch --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://panel.example.com/ refused the handshake without a client certificate"* ]]
    run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    # the file the render wrote for panel.example.com is what verify judges: the default name's rule fails on it
    sed -i 's|panel\.example\.com|control.example.org|' "${GREMION_ROOT}/etc/edge/control-panel.yml"
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"etc/edge/control-panel.yml: the rule is 'Host(\`control.example.org\`)"* ]]
}

# M1: the first health probe of a panel that was just recreated comes a moment after its router loads.
@test "control panel: a panel server with no verdict yet, or DOWN, is asked about again (bounded) and passes once traefik reports it UP; a verdict that stays bad still fails after the last try" {
    control_all
    # a fake curl that has not seen the first probe yet: the service list changes under the verifier
    api_edit services 'map(if .name == "panel@file" then del(.serverStatus) else . end)'
    PANEL_UP_TRIES=3 PANEL_UP_WAIT_SECONDS=0 run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    # one "not UP yet" line per extra try: three tries in all
    [ "$(grep -c 'panel service panel@file: not UP yet' <<<"$output")" -eq 2 ]
    [[ "$output" == *"traefik reports no status for its server"* ]]
    PANEL_UP_TRIES=1 PANEL_UP_WAIT_SECONDS=0 run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" != *"not UP yet"* ]]
    # the first probe lands between the first read and the second: the second read says UP
    api_edit services 'map(if .name == "panel@file" then .serverStatus = {"http://control-panel-blue:3000":"UP"} else . end)'
    cp "${FAKE_HTTP}/api-http-services.json" "${FAKE_HTTP}/up.json"
    api_edit services 'map(if .name == "panel@file" then .serverStatus = {"http://control-panel-blue:3000":"DOWN"} else . end)'
    cp "${FAKE_HTTP}/up.json" "${FAKE_HTTP}/api-http-services.json.next"
    PANEL_UP_TRIES=3 PANEL_UP_WAIT_SECONDS=0 run "$VERIFY" --hosts "$HOSTS"
    echo "$output"
    [ "$status" -eq 0 ]
    [[ "$output" == *"panel service panel@file: not UP yet (try 1 of 3)"* ]]
}
