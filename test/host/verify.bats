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
url=""; outfile=""; want_code=0; forged=0; prev=""
for a in "$@"; do
  case "$prev" in -o) outfile="$a" ;; esac
  case "$a" in
    -w) want_code=1 ;;
    X-Forwarded-Host:*) forged=1 ;;
    http://*|https://*) url="$a" ;;
  esac
  prev="$a"
done
case "$url" in
  */api/http/routers)     cat "$FAKE_HTTP/api-http-routers.json"; exit 0 ;;
  */api/http/services)    cat "$FAKE_HTTP/api-http-services.json"; exit 0 ;;
  */api/http/middlewares) cat "$FAKE_HTTP/api-http-middlewares.json"; exit 0 ;;
esac
s="$(printf "%s" "$url" | tr -c "A-Za-z0-9" "-")"
[ "$forged" = 1 ] && s="${s}-forged"
if [ "$want_code" = 1 ]; then
  if [ -n "$outfile" ] && [ -f "$FAKE_HTTP/probe-$s.body" ]; then
    cat "$FAKE_HTTP/probe-$s.body" > "$outfile" 2>/dev/null || true
  fi
  cat "$FAKE_HTTP/probe-$s.code" 2>/dev/null || printf "000"
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
      cat "$FAKE_TLS/$host.pem" 2>/dev/null || printf "NO-CERT\n"
      ;;
  x509)
      inf=""; mode=""; prev=""
      for a in "$@"; do
        [ "$prev" = "-in" ] && inf="$a"
        case "$a" in -ext) mode=ext ;; -checkend) mode=checkend ;; esac
        prev="$a"
      done
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
  ps) cat "$FAKE_DOCKER/ps" 2>/dev/null; exit 0 ;;
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
        printf '    edge-perip-%s:\n      inFlightReq:\n        amount: 50\n' "$slug"
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
   "rateLimit":{"average":30,"burst":10,"period":"1m"}}
]
EOF
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
    [[ "$output" == *"router tenant-b@file: rule matches a host pattern (HostRegexp)"* ]]
}

@test "universal: a public router naming two literal hosts fails" {
    api_edit routers '(.[] | select(.name=="tenant-b@file")).rule = "Host(`tenant-b.example.org`) || Host(`tenant-a.example.org`)"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"router tenant-b@file: rule names 2 literal hosts (expected exactly 1)"* ]]
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

@test "universal: an unclassified router still fails even when fully pinned" {
    api_edit routers '(.[] | select(.name=="tenant-a@file")).service = "ghost@file"'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNCLASSIFIED router tenant-a@file"* ]]
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
    fake_container c6 traefik "traefik" running healthy 0 "" \
        '{"com.docker.compose.project":"prod-state","com.docker.compose.service":"traefik","traefik.http.middlewares.edge-hsts-custom.headers.stsseconds":"31536000"}'
    run "$VERIFY" --hosts "$HOSTS"
    [ "$status" -eq 0 ]
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

@test "the router functions are wired into run_pass, in order" {
    local body
    body="$(sed -n '/^run_pass() {/,/^}/p' "$VERIFY")"
    [[ "$body" == *$'check_routers\n    check_router_universal\n    check_emitted_routers\n    check_middleware_placement'* ]]
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
