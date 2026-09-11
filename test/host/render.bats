#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-render (spec A §E, plan Task 5).
# Run: bats test/host/render.bats   (Git Bash on Windows and Debian both)
#
# UNIT tests only. No real docker, no real release checkout, no real host:
# `docker` is shimmed, the release tree is a fixture built per test, and the
# internal-CA generator is a stub with the same idempotence contract as the
# kernel's docker/keycloak/certs/gen-internal-ca.sh.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
RENDER="${PROJECT_ROOT}/infra/host/bin/gremion-render"

# make_ca_generator <release-dir> [ok|noop|dir|empty]
# Writes the stub generator. `ok` mimics the kernel script: mint once, then
# no-op. The other three model broken generators, which is how the three
# branches of assert_rendered are exercised without breaking the script.
make_ca_generator() {
    local root="$1" mode="${2:-ok}"
    mkdir -p "$root/docker/keycloak/certs"
    cat > "$root/docker/keycloak/certs/gen-internal-ca.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "\$(dirname "\$0")"
echo call >> "\${GEN_CA_CALLS:-/dev/null}"
if [ -f internal-ca.crt ] && [ -f keycloak.crt ]; then
  echo "[gen-internal-ca] certs already present"
  exit 0
fi
case "${mode}" in
  noop)  exit 0 ;;
  dir)   mkdir -p keycloak.crt; echo mint > internal-ca.crt; cp internal-ca.crt internal-ca.pem
         echo k > internal-ca.key; echo k > keycloak.key; exit 0 ;;
  empty) echo mint > internal-ca.crt; cp internal-ca.crt internal-ca.pem
         echo k > internal-ca.key; echo c > keycloak.crt; : > keycloak.key; exit 0 ;;
esac
echo "mint \$\$ \$(date +%s%N)" > internal-ca.crt
cp internal-ca.crt internal-ca.pem
echo ca-key   > internal-ca.key
echo srv-cert > keycloak.crt
echo srv-key  > keycloak.key
EOF
    chmod +x "$root/docker/keycloak/certs/gen-internal-ca.sh"
}

make_release_tree() {
    local root="$1"
    mkdir -p "$root/docker/pgbouncer"
    make_ca_generator "$root" ok
}

# A STAGING state.env: TRAEFIK_CERT_RESOLVER is deliberately BLANK. The
# template Task 1's gremion-init-secrets renders from ships le-http, so a
# staging root must have this key blanked before --staging is used; the
# "--staging refuses a non-empty TRAEFIK_CERT_RESOLVER" test below pins the
# refusal that catches a root where that was forgotten.
write_state_env() {
    cat > "${GREMION_ROOT}/etc/env/state.env" <<'EOF'
STACK=staging
COMPOSE_PROJECT_NAME=staging-state
COMPOSE_FILE=docker-compose.yml
PLATFORM_DOMAIN=example.org
ACME_EMAIL=ops@example.org
TRAEFIK_CERT_RESOLVER=
EDGE_BIND_IP=127.0.0.1
EDGE_BIND_IP6=::1
EDGE_HTTP_PORT=8080
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
EOF
}

setup() {
    setup_host_root
    RELEASE="${GREMION_ROOT}/releases/dist-v1.0.0"
    make_release_tree "$RELEASE"
    write_state_env
    GEN_CA_CALLS="${GREMION_ROOT}/gen-ca-calls.log"
    export GEN_CA_CALLS
}

# Same convention as common.bats and init-secrets.bats: every test's throwaway
# root is removed again, so a full suite run does not leave one mktemp -d per
# test behind.
teardown() {
    teardown_host_root
}

# ---------------------------------------------------------------------------
# Structure, usage, preconditions
# ---------------------------------------------------------------------------

@test "gremion-render exists and is executable" {
    [ -x "$RENDER" ]
}

@test "gremion-render has strict mode, sources common.sh, and declares the source path" {
    grep -q 'set -euo pipefail' "$RENDER"
    grep -q '\. "\$SCRIPT_DIR/\.\./lib/common\.sh"' "$RENDER"
    grep -q '^# shellcheck source=\.\./lib/common\.sh$' "$RENDER"
}

@test "--help prints usage and exits 0" {
    run "$RENDER" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"usage: gremion-render"* ]]
}

@test "an unknown argument exits 2" {
    run "$RENDER" --wat
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown argument: --wat"* ]]
}

@test "--release without a directory exits 2" {
    run "$RENDER" --release
    [ "$status" -eq 2 ]
    [[ "$output" == *"--release needs a directory"* ]]
}

@test "a missing release tree exits 2 and names the directory" {
    run "$RENDER" --release "${GREMION_ROOT}/releases/nope"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release tree not found: ${GREMION_ROOT}/releases/nope"* ]]
}

@test "the default release tree is GREMION_ROOT/current" {
    run "$RENDER"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release tree not found: ${GREMION_ROOT}/current"* ]]
}

@test "a release tree without docker/ exits 2" {
    mkdir -p "${GREMION_ROOT}/releases/bare"
    run "$RENDER" --release "${GREMION_ROOT}/releases/bare"
    [ "$status" -eq 2 ]
    [[ "$output" == *"has no docker/ directory"* ]]
}

@test "a missing state.env exits 2" {
    rm -f "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"state env file not found"* ]]
}

# ---------------------------------------------------------------------------
# 1. pgbouncer userlist
# ---------------------------------------------------------------------------

@test "renders docker/pgbouncer/userlist.txt from PGBOUNCER_AUTH_PASSWORD" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ -f "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    grep -q '^"pgbouncer_auth" "test-secret-pgbouncer"$' "${RELEASE}/docker/pgbouncer/userlist.txt"
}

@test "the rendered userlist carries no CHANGE_ME_ sentinel" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    # -f first: without it `! grep` on an ABSENT file succeeds, and the
    # assertion would pass vacuously against a render that wrote nothing.
    [ -f "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    ! grep -q 'CHANGE_ME_' "${RELEASE}/docker/pgbouncer/userlist.txt"
}

@test "a state.env still carrying a CHANGE_ME_ sentinel is refused" {
    sed -i 's/^PGBOUNCER_AUTH_PASSWORD=.*/PGBOUNCER_AUTH_PASSWORD=CHANGE_ME_GEN_password_pgbouncer/' \
        "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [ ! -f "${RELEASE}/docker/pgbouncer/userlist.txt" ]
}

@test "a release tree without docker/pgbouncer exits 2" {
    rm -rf "${RELEASE}/docker/pgbouncer"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no docker/pgbouncer directory"* ]]
}

# ---------------------------------------------------------------------------
# 2. Keycloak internal CA + server cert
# ---------------------------------------------------------------------------

@test "mints the internal CA through the release tree's gen-internal-ca.sh" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    for f in internal-ca.crt internal-ca.pem internal-ca.key keycloak.crt keycloak.key; do
        [ -s "${RELEASE}/docker/keycloak/certs/${f}" ]
    done
    [ "$(wc -l < "$GEN_CA_CALLS")" -eq 1 ]
}

@test "persists the CA under etc/secrets/keycloak" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    for f in internal-ca.crt internal-ca.pem internal-ca.key keycloak.crt keycloak.key; do
        [ -s "${GREMION_ROOT}/etc/secrets/keycloak/${f}" ]
    done
    cmp "${RELEASE}/docker/keycloak/certs/internal-ca.crt" \
        "${GREMION_ROOT}/etc/secrets/keycloak/internal-ca.crt"
}

@test "a second render does not re-mint the CA" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local first
    first="$(cat "${RELEASE}/docker/keycloak/certs/internal-ca.crt")"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"certs already present"* ]]
    [ "$(cat "${RELEASE}/docker/keycloak/certs/internal-ca.crt")" = "$first" ]
}

@test "a fresh release tree is re-seeded from etc/secrets/keycloak, not re-minted" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local first
    first="$(cat "${GREMION_ROOT}/etc/secrets/keycloak/internal-ca.crt")"
    local next="${GREMION_ROOT}/releases/dist-v1.0.1"
    make_release_tree "$next"
    run "$RENDER" --release "$next"
    [ "$status" -eq 0 ]
    [ "$(cat "${next}/docker/keycloak/certs/internal-ca.crt")" = "$first" ]
    [ "$(cat "${next}/docker/keycloak/certs/keycloak.key")" = "srv-key" ]
}

@test "a release tree without an executable gen-internal-ca.sh exits 2" {
    rm -f "${RELEASE}/docker/keycloak/certs/gen-internal-ca.sh"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"gen-internal-ca.sh"* ]]
}

@test "a generator that writes nothing fails the missing-output assert" {
    make_ca_generator "$RELEASE" noop
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"render output missing: ${RELEASE}/docker/keycloak/certs/internal-ca.crt"* ]]
}

@test "a generator that writes a directory fails the not-a-directory assert" {
    make_ca_generator "$RELEASE" dir
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"render output is a directory: ${RELEASE}/docker/keycloak/certs/keycloak.crt"* ]]
}

@test "a generator that writes an empty file fails the non-empty assert" {
    make_ca_generator "$RELEASE" empty
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"render output is empty: ${RELEASE}/docker/keycloak/certs/keycloak.key"* ]]
}

# ---------------------------------------------------------------------------
# 3. ipcrypt key (etc/secrets — §A; never rotated here)
# ---------------------------------------------------------------------------

@test "generates etc/secrets/ipcrypt_key.txt as 32 hex characters" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    grep -Eq '^[0-9a-f]{32}$' "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt"
}

@test "seeds etc/secrets/ipcrypt_epoch.txt with 0" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/secrets/ipcrypt_epoch.txt")" = "0" ]
}

@test "a second render never regenerates the ipcrypt key" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local first
    first="$(cat "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt")"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt")" = "$first" ]
}

@test "a rotated key and a bumped epoch survive a render" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    printf '%s\n' "ffffffffffffffffffffffffffffffff" > "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt"
    printf '7\n' > "${GREMION_ROOT}/etc/secrets/ipcrypt_epoch.txt"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt")" = "ffffffffffffffffffffffffffffffff" ]
    [ "$(cat "${GREMION_ROOT}/etc/secrets/ipcrypt_epoch.txt")" = "7" ]
}

@test "the ipcrypt key is mode 0600 (Linux only)" {
    [[ "$(uname -s)" == Linux ]] || skip "file modes are not meaningful on Windows"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(stat -c '%a' "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt")" = "600" ]
}

# ---------------------------------------------------------------------------
# 4. Release templates (LiveKit, Element Call, anything spec B adds)
# ---------------------------------------------------------------------------

@test "renders every release template under docker/ whose name ends in .tmpl" {
    mkdir -p "${RELEASE}/docker/livekit" "${RELEASE}/docker/element-call"
    printf 'keys:\n  %s: %s\nrtc:\n  use_external_ip: false\n' \
        '${LIVEKIT_API_KEY}' '${LIVEKIT_API_SECRET}' \
        > "${RELEASE}/docker/livekit/livekit.yaml.tmpl"
    printf '{"livekit_url":"wss://%s/livekit-sfu"}\n' '${PLATFORM_DOMAIN}' \
        > "${RELEASE}/docker/element-call/config.json.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    grep -q '^  lk-key: lk-secret$' "${RELEASE}/docker/livekit/livekit.yaml"
    grep -q 'wss://example.org/livekit-sfu' "${RELEASE}/docker/element-call/config.json"
    [[ "$output" == *"release templates rendered: 2"* ]]
}

@test "no dollar-brace placeholder survives in a rendered file" {
    mkdir -p "${RELEASE}/docker/livekit"
    printf 'domain: %s\n' '${PLATFORM_DOMAIN}' > "${RELEASE}/docker/livekit/livekit.yaml.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    # -f first, for the same reason as the userlist sentinel test: `! grep` on
    # an ABSENT file succeeds, so without this the assertion would be satisfied
    # by a render that produced no file at all.
    [ -f "${RELEASE}/docker/livekit/livekit.yaml" ]
    ! grep -q '\${' "${RELEASE}/docker/livekit/livekit.yaml"
}

@test "a template variable outside the allow-list exits 2 and names it" {
    mkdir -p "${RELEASE}/docker/livekit"
    printf 'secret: %s\n' '${POSTGRES_PASSWORD}' > "${RELEASE}/docker/livekit/livekit.yaml.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown variable \${POSTGRES_PASSWORD}"* ]]
    [[ "$output" == *"not in the render allow-list"* ]]
    [ ! -f "${RELEASE}/docker/livekit/livekit.yaml" ]
}

@test "an allow-listed but unset variable exits 2 and names the key" {
    mkdir -p "${RELEASE}/docker/element-call"
    printf 'url: %s\n' '${ELEMENT_CALL_LIVEKIT_URL}' \
        > "${RELEASE}/docker/element-call/config.json.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing env key ELEMENT_CALL_LIVEKIT_URL"* ]]
}

@test "an empty release template exits 2 and names the path" {
    mkdir -p "${RELEASE}/docker/livekit"
    : > "${RELEASE}/docker/livekit/livekit.yaml.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"release template is empty: ${RELEASE}/docker/livekit/livekit.yaml.tmpl"* ]]
}

@test "a release tree with no templates renders zero and still succeeds" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"release templates rendered: 0"* ]]
}

# ---------------------------------------------------------------------------
# 5. --staging: the extra_hosts compose fragment
# ---------------------------------------------------------------------------

stub_compose_services() {
    shim docker '
case "$*" in
  *"config --services"*) printf "%s\n" gremion-ui gremion-public traefik ;;
  *) exit 0 ;;
esac
'
}

@test "--staging writes one extra_hosts block per compose service" {
    stub_compose_services
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 0 ]
    local out="${GREMION_ROOT}/etc/edge/extra-hosts.yml"
    [ -s "$out" ]
    grep -q '^services:$'          "$out"
    grep -q '^  gremion-ui:$'      "$out"
    grep -q '^  gremion-public:$'  "$out"
    grep -q '^  traefik:$'         "$out"
    [ "$(grep -c 'extra_hosts:' "$out")" -eq 3 ]
}

@test "--staging maps the three platform hosts to EDGE_BIND_IP" {
    stub_compose_services
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 0 ]
    local out="${GREMION_ROOT}/etc/edge/extra-hosts.yml"
    [ "$(grep -c '"example.org:127.0.0.1"' "$out")" -eq 3 ]
    [ "$(grep -c '"control.example.org:127.0.0.1"' "$out")" -eq 3 ]
    [ "$(grep -c '"mail.example.org:127.0.0.1"' "$out")" -eq 3 ]
}

@test "--staging adds every host in etc/tenant-hosts.txt" {
    stub_compose_services
    printf '# tenants\nstura.example.org\n\nfsr.example.org\n' \
        > "${GREMION_ROOT}/etc/tenant-hosts.txt"
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 0 ]
    local out="${GREMION_ROOT}/etc/edge/extra-hosts.yml"
    [ "$(grep -c '"stura.example.org:127.0.0.1"' "$out")" -eq 3 ]
    [ "$(grep -c '"fsr.example.org:127.0.0.1"' "$out")" -eq 3 ]
    ! grep -q 'tenants' "$out"
}

@test "--staging asks compose for the service list with --env-file only" {
    stub_compose_services
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 0 ]
    assert_recorded docker "config --services"
    assert_recorded docker "--env-file ${GREMION_ROOT}/etc/env/state.env"
}

@test "gremion-render never passes -f, -p or --profile to docker compose" {
    ! grep -nE 'docker compose[^|;]*( -f | --profile | -p )' "$RENDER"
}

@test "--staging refuses a non-empty TRAEFIK_CERT_RESOLVER" {
    stub_compose_services
    sed -i 's/^TRAEFIK_CERT_RESOLVER=.*/TRAEFIK_CERT_RESOLVER=le-http/' \
        "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 2 ]
    [[ "$output" == *"staging never holds public certificates"* ]]
    [ ! -f "${GREMION_ROOT}/etc/edge/extra-hosts.yml" ]
}

@test "--staging fails when compose reports zero services" {
    shim docker 'exit 0'
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 1 ]
    [[ "$output" == *"compose reported zero services"* ]]
}

@test "without --staging no extra-hosts.yml is written" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ ! -f "${GREMION_ROOT}/etc/edge/extra-hosts.yml" ]
    [[ "$output" == *"staging=no"* ]]
}

@test "the proof line names the output count and the staging flag" {
    stub_compose_services
    run "$RENDER" --release "$RELEASE" --staging
    [ "$status" -eq 0 ]
    [[ "$output" =~ RENDER:\ outputs=9\ release=${RELEASE}\ staging=yes ]]
}
