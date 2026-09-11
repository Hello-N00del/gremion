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

fake_container() {  # <id> <name> <aliases> <status> <health> <exitcode> [ip]
    printf '%s\n' "$1" >> "${FAKE_DOCKER}/ps"
    printf '/%s\n' "$2" > "${FAKE_DOCKER}/$1.name"
    printf '%s\n' "$3"  > "${FAKE_DOCKER}/$1.aliases"
    printf '%s\n' "$4"  > "${FAKE_DOCKER}/$1.status"
    printf '%s\n' "$5"  > "${FAKE_DOCKER}/$1.health"
    printf '%s\n' "$6"  > "${FAKE_DOCKER}/$1.exitcode"
    printf '%s\n' "${7:-}" > "${FAKE_DOCKER}/$1.ips"
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

# The green baseline every test perturbs: two tenant routers on app@file, one
# state-bound router, the two internaltest routers, valid certificates, pinned
# responses that DIFFER per host, an ACME 404 and two healthy containers.
fixture_green() {
    cat > "${FAKE_HTTP}/api-http-routers.json" <<'EOF'
[
  {"name":"tenant-a@file","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`)","service":"app@file",
   "middlewares":["edge-hostpin-tenant-a@docker","edge-ratelimit@docker"]},
  {"name":"tenant-b@file","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-b.example.org`)","service":"app@file",
   "middlewares":["edge-hostpin-tenant-b@docker"]},
  {"name":"keycloak@docker","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`) && PathPrefix(`/auth`)","service":"keycloak@docker"},
  {"name":"test-app@file","status":"enabled","entryPoints":["internaltest"],
   "rule":"HostRegexp(`.+`)","service":"app-next@file"},
  {"name":"acme-http@internal","status":"enabled","entryPoints":["web"],
   "rule":"PathPrefix(`/.well-known/acme-challenge/`)","service":"acme-http@internal"},
  {"name":"whoami@docker","status":"enabled","entryPoints":["websecure"],
   "rule":"Host(`tenant-a.example.org`) && PathPrefix(`/whoami`)","service":"whoami"}
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
  {"name":"edge-hostpin-tenant-a@docker"},
  {"name":"edge-hostpin-tenant-b@docker"},
  {"name":"edge-ratelimit@docker"}
]
EOF
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

@test "usage lists exactly the flags the parser accepts" {
    run "$VERIFY" --help
    [ "$status" -eq 2 ]
    [[ "$output" == *"--reboot"* ]]
}
