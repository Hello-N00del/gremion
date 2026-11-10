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
    mkdir -p "$root/docker/pgbouncer" "$root/legal"
    make_ca_generator "$root" ok
    # The release tree's own example, read from this checkout so a key added to
    # it is judged here too. CR-stripped: a Windows checkout may carry CRLF.
    tr -d '\r' < "${PROJECT_ROOT}/legal/legal.env.example" > "$root/legal/legal.env.example"
}

# The host-owned legal env file, filled the way an operator fills it. Every
# value is fictional and none equals the example's placeholder.
write_legal_env() {
    tr -d '\r' < "${PROJECT_ROOT}/legal/legal.env.example" | sed \
        -e 's|^ORG_NAME=.*|ORG_NAME=Beispielgremium|' \
        -e 's|^ORG_ADDRESS=.*|ORG_ADDRESS=Beispielweg 2, 54321 Beispielstadt|' \
        -e 's|^ORG_EMAIL=.*|ORG_EMAIL=kontakt@beispiel.example|' \
        -e 's|^RESPONSIBLE_PERSON=.*|RESPONSIBLE_PERSON=Erika Beispiel|' \
        -e 's|^RESPONSIBLE_PERSON_EMAIL=.*|RESPONSIBLE_PERSON_EMAIL=datenschutz@beispiel.example|' \
        -e 's|^DOMAIN=.*|DOMAIN=example.org|' \
        > "${GREMION_ROOT}/etc/legal.env"
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
PILOT_TENANT_HOST=pilot.example.org
EOF
}

setup() {
    setup_host_root
    RELEASE="${GREMION_ROOT}/releases/dist-v1.0.0"
    make_release_tree "$RELEASE"
    write_state_env
    write_legal_env
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

# Issue #83. PgBouncer runs as uid/gid 70 in its container and bind-mounts the
# userlist read-only; a 0600 file owned by the deploy user is unreadable to it
# on a Linux host (Docker Desktop ignores bind-mount modes, so nothing else
# saw it). The render must leave the file group-readable by gid 70 and closed
# to every other user. These run on a real Linux filesystem (the bats runner
# image, as root; CI as its own user with passwordless sudo). On NTFS the mode
# and group assertions are SKIPPED, visibly, by bats' own skip.
userlist_needs_posix_modes() {
    fs_carries_modes "${RELEASE}/docker/pgbouncer" \
        || skip "this filesystem cannot hold POSIX modes (NTFS); proven on Linux"
}

userlist_stat() { stat -c '%g %a' "${RELEASE}/docker/pgbouncer/userlist.txt"; }

@test "the rendered userlist is mode 0640 with group 70 and nothing for other users" {
    userlist_needs_posix_modes
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ -f "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    [ "$(userlist_stat)" = "70 640" ]
}

@test "a re-render over an existing 0600 userlist still ends 0640 with group 70" {
    userlist_needs_posix_modes
    printf 'stale\n' > "${RELEASE}/docker/pgbouncer/userlist.txt"
    chmod 0600 "${RELEASE}/docker/pgbouncer/userlist.txt"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    grep -q '^"pgbouncer_auth" "test-secret-pgbouncer"$' "${RELEASE}/docker/pgbouncer/userlist.txt"
    [ "$(userlist_stat)" = "70 640" ]
}

@test "GREMION_PGBOUNCER_GID overrides the group the userlist is handed to" {
    userlist_needs_posix_modes
    GREMION_PGBOUNCER_GID=4242 run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(userlist_stat)" = "4242 640" ]
}

@test "a GREMION_PGBOUNCER_GID that is not a numeric gid is refused before anything is written" {
    GREMION_PGBOUNCER_GID=postgres run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"GREMION_PGBOUNCER_GID must be a numeric gid"* ]]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    GREMION_PGBOUNCER_GID=-1 run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
}

@test "when the deploy user cannot chgrp itself, the group is set through sudo -n, on the temp file" {
    userlist_needs_posix_modes
    if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
        skip "needs root, or a real passwordless sudo, to hand a file to gid 70"
    fi
    if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
        skip "needs root, or a real passwordless sudo, to hand a file to gid 70"
    fi
    shim chgrp 'exit 1'
    # Runs the REAL chgrp WITH the privilege sudo would give it: the shim
    # directory is dropped from PATH first, and a non-root runner (CI) goes
    # through the real sudo -n, since an unprivileged chgrp to gid 70 fails.
    shim sudo '[ "$1" = "-n" ] && shift; PATH="${PATH#"${SHIM_DIR}":}"; if [ "$(id -u)" -eq 0 ]; then exec "$@"; fi; exec sudo -n "$@"'
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    assert_recorded sudo "-n chgrp -- 70 ${RELEASE}/docker/pgbouncer/userlist.txt.tmp"
    [ "$(userlist_stat)" = "70 640" ]
}

@test "a userlist whose group cannot be set fails the render and names both reasons" {
    userlist_needs_posix_modes
    shim chgrp 'echo "chgrp: changing group: Operation not permitted" >&2; exit 1'
    shim sudo 'echo "sudo: a password is required" >&2; exit 1'
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot hand"*"userlist.txt"*"group 70"* ]]
    [[ "$output" == *"Operation not permitted"* ]]
    [[ "$output" == *"a password is required"* ]]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt.tmp" ]
}

@test "a group that cannot be set leaves the previous good userlist untouched" {
    userlist_needs_posix_modes
    printf '"pgbouncer_auth" "earlier-good"\n' > "${RELEASE}/docker/pgbouncer/userlist.txt"
    chmod 0640 "${RELEASE}/docker/pgbouncer/userlist.txt"
    shim chgrp 'exit 1'
    shim sudo 'exit 1'
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 1 ]
    [ "$(cat "${RELEASE}/docker/pgbouncer/userlist.txt")" = '"pgbouncer_auth" "earlier-good"' ]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt.tmp" ]
}

# The deploy that gremion-hostd drives runs gremion-render as the deploy user
# under NoNewPrivileges (the unit sets it), where sudo is refused and a plain
# chgrp works only for a group the user already belongs to. Root cannot show
# that, so these run the render as a real unprivileged uid under no_new_privs
# (setpriv, util-linux). The deploy user's membership of gid 70 is what
# bootstrap's `user` stage provides; the second test is the failure that
# membership prevents.
nnp_prereqs() {
    [[ "$(uname -s)" == Linux ]] || skip "no_new_privs is a Linux kernel feature"
    userlist_needs_posix_modes
    command -v setpriv >/dev/null 2>&1 || { echo "setpriv (util-linux) is required for this guard" >&2; return 1; }
    if [ "$(id -u)" -ne 0 ]; then
        sudo -n true 2>/dev/null || { echo "this guard needs root or passwordless sudo" >&2; return 1; }
    fi
}

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }

# nnp_render <supplementary gids, comma separated>
nnp_render() {
    local groups="$1" rc=0
    mkdir -p "${GREMION_ROOT}/hostsrc/bin" "${GREMION_ROOT}/hostsrc/lib"
    cp "$RENDER" "${GREMION_ROOT}/hostsrc/bin/gremion-render"
    cp "$(dirname "$RENDER")/../lib/common.sh" "${GREMION_ROOT}/hostsrc/lib/common.sh"
    as_root chown -R 65534:65534 "$GREMION_ROOT"
    as_root setpriv --reuid=65534 --regid=65534 --groups="$groups" --no-new-privs \
        env PATH="$PATH" GREMION_ROOT="$GREMION_ROOT" GEN_CA_CALLS="$GEN_CA_CALLS" \
        "${GREMION_ROOT}/hostsrc/bin/gremion-render" --release "$RELEASE" || rc=$?
    # Owner only, so the group the render set (the thing under test) survives.
    as_root chown -R "$(id -u)" "$GREMION_ROOT"
    return "$rc"
}

@test "as a non-root deploy user under no_new_privs, a member of group 70 renders the userlist 0640 group 70" {
    nnp_prereqs
    run nnp_render 65534,70
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(userlist_stat)" = "70 640" ]
    grep -q '^"pgbouncer_auth" "test-secret-pgbouncer"$' "${RELEASE}/docker/pgbouncer/userlist.txt"
}

@test "as a non-root deploy user under no_new_privs, a user outside group 70 fails loudly and keeps the old userlist" {
    nnp_prereqs
    printf '"pgbouncer_auth" "earlier-good"\n' > "${RELEASE}/docker/pgbouncer/userlist.txt"
    chmod 0640 "${RELEASE}/docker/pgbouncer/userlist.txt"
    run nnp_render 65534
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot hand"*"group 70"* ]]
    [[ "$output" == *"bootstrap"* ]]
    [ "$(cat "${RELEASE}/docker/pgbouncer/userlist.txt")" = '"pgbouncer_auth" "earlier-good"' ]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt.tmp" ]
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

# The pilot's Element Call config is rendered from the REAL template in this checkout, never from a
# stand-in: PILOT_TENANT_HOST is allow-listed (and therefore required once a template names it), the
# output carries both hosts and no placeholder, and the rendered file is gitignored so a render never
# dirties the release tree (gremion-isolation and verify refuse a dirty tree).
@test "the real Element Call template renders from state.env: platform domain and pilot tenant host, no placeholder" {
    mkdir -p "${RELEASE}/docker/element-call"
    tr -d '\r' < "${PROJECT_ROOT}/docker/element-call/config.json.tmpl" > "${RELEASE}/docker/element-call/config.json.tmpl"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ -s "${RELEASE}/docker/element-call/config.json" ]
    grep -q '"base_url": "https://example.org"' "${RELEASE}/docker/element-call/config.json"
    grep -q '"server_name": "example.org"' "${RELEASE}/docker/element-call/config.json"
    grep -q '"livekit_service_url": "https://pilot.example.org/livekit/jwt"' "${RELEASE}/docker/element-call/config.json"
    ! grep -q '\${' "${RELEASE}/docker/element-call/config.json"
}

@test "the Element Call template without PILOT_TENANT_HOST in state.env exits 2 and names the key" {
    mkdir -p "${RELEASE}/docker/element-call"
    tr -d '\r' < "${PROJECT_ROOT}/docker/element-call/config.json.tmpl" > "${RELEASE}/docker/element-call/config.json.tmpl"
    sed -i '/^PILOT_TENANT_HOST=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing env key PILOT_TENANT_HOST"* ]]
    [ ! -f "${RELEASE}/docker/element-call/config.json" ]
}

# The video relay (TURN over TLS on 443) is rendered from the REAL LiveKit template in this checkout.
# PILOT_TENANT_HOST decides: set, the relay is on at turn.<host> and the media range is shortened to
# leave the top of the published block to the relay; unset or empty, the relay is off, the media range
# is today's 45000-45100 and no public name appears.
render_livekit_template() {
    mkdir -p "${RELEASE}/docker/livekit"
    tr -d '\r' < "${PROJECT_ROOT}/docker/livekit/livekit.yaml.tmpl" > "${RELEASE}/docker/livekit/livekit.yaml.tmpl"
}

@test "the real LiveKit template with PILOT_TENANT_HOST: relay enabled at turn.<host>, media range leaves the relay its ports, no placeholder" {
    render_livekit_template
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local out="${RELEASE}/docker/livekit/livekit.yaml"
    [ -s "$out" ]
    grep -q '^  enabled: true$' "$out"
    grep -q '^  domain: turn\.pilot\.example\.org$' "$out"
    grep -q '^  tls_port: 5349$' "$out"
    grep -q '^  external_tls: true$' "$out"
    grep -q '^  port_range_end: 45050$' "$out"
    grep -q '^  relay_range_start: 45051$' "$out"
    grep -q '^  relay_range_end: 45100$' "$out"
    ! grep -q '\${' "$out"
}

@test "the real LiveKit template without PILOT_TENANT_HOST: relay disabled, today's media range, no public name" {
    render_livekit_template
    sed -i '/^PILOT_TENANT_HOST=/d' "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local out="${RELEASE}/docker/livekit/livekit.yaml"
    [ -s "$out" ]
    grep -q '^  enabled: false$' "$out"
    grep -q '^  port_range_end: 45100$' "$out"
    grep -q '^  domain: turn\.relay\.invalid$' "$out"
    assert_absent 'example\.org' "$out" 'no placeholder public name rendered'
    ! grep -q '\${' "$out"
}

@test "the real LiveKit template with an EMPTY PILOT_TENANT_HOST renders like an unset one" {
    render_livekit_template
    sed -i 's/^PILOT_TENANT_HOST=.*/PILOT_TENANT_HOST=/' "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    grep -q '^  enabled: false$' "${RELEASE}/docker/livekit/livekit.yaml"
    grep -q '^  port_range_end: 45100$' "${RELEASE}/docker/livekit/livekit.yaml"
}

# The pinned livekit-server v1.7.2 logs "created TURN password" (username AND password) at INFO
# for every participant that joins while the relay is on (service/roommanager.go, global logger,
# which no component_levels entry reaches). The global level is the only switch: at warn the line
# is gone and warnings and errors stay. Proved against the pinned image; do not raise it back.
@test "the real LiveKit template keeps the global log level at warn so a TURN password never reaches the log" {
    render_livekit_template
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local out="${RELEASE}/docker/livekit/livekit.yaml"
    [ "$(awk '/^logging:/{f=1;next} /^[^ ]/{f=0} f && /^  level:/{print $2}' "$out")" = "warn" ]
    assert_absent '^[[:space:]]+level:[[:space:]]*(debug|info)' "$out" 'global log level is not debug or info'
    ! grep -Eq '^[[:space:]]+(component_levels|pion_level)' "$out"
}

@test "a PILOT_TENANT_HOST that is not a lower-case host name is refused before anything is rendered" {
    render_livekit_template
    sed -i 's/^PILOT_TENANT_HOST=.*/PILOT_TENANT_HOST=Pilot.Example.org/' "${GREMION_ROOT}/etc/env/state.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"PILOT_TENANT_HOST is not a lower-case host name"* ]]
    [ ! -f "${RELEASE}/docker/livekit/livekit.yaml" ]
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
    [[ "$output" =~ RENDER:\ outputs=10\ release=${RELEASE}\ staging=yes ]]
}

# ---------------------------------------------------------------------------
# 6. legal/legal.env (kernel #84)
#
# docker-compose.yml gives the state project's `legal` service
# `env_file: legal/legal.env`, resolved in the release tree for EVERY compose
# verb. Nothing used to create it, so the state project could not start on a
# fresh release tree. The operator's values live once on the host in
# etc/legal.env (the way the Keycloak CA lives in etc/secrets/keycloak) and
# every release tree is given a copy.
# ---------------------------------------------------------------------------

# legal_example_keys — every key legal/legal.env.example declares.
legal_example_keys() {
    grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "${RELEASE}/legal/legal.env.example" | tr -d '='
}

@test "legal: a filled etc/legal.env is copied into the release tree as legal/legal.env" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ -s "${RELEASE}/legal/legal.env" ]
    local k
    for k in $(legal_example_keys); do
        grep -q "^${k}=" "${RELEASE}/legal/legal.env" || { echo "legal/legal.env lacks ${k}"; false; }
    done
    grep -qx 'ORG_NAME=Beispielgremium' "${RELEASE}/legal/legal.env"
    cmp "${GREMION_ROOT}/etc/legal.env" "${RELEASE}/legal/legal.env"
}

@test "legal: every later release tree is given its own copy" {
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    local next="${GREMION_ROOT}/releases/dist-v1.0.1"
    make_release_tree "$next"
    [ ! -e "${next}/legal/legal.env" ]
    run "$RENDER" --release "$next"
    [ "$status" -eq 0 ]
    cmp "${GREMION_ROOT}/etc/legal.env" "${next}/legal/legal.env"
}

@test "legal: a render never rewrites an operator-edited etc/legal.env" {
    printf '# edited by the operator\nORG_NAME_NOTE=kept\n' >> "${GREMION_ROOT}/etc/legal.env"
    local before
    before="$(cat "${GREMION_ROOT}/etc/legal.env")"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/legal.env")" = "$before" ]
    run "$RENDER" --release "$RELEASE" --legal-env-only
    [ "$status" -eq 0 ]
    run "$RENDER" --release "$RELEASE" --init-legal-env
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/etc/legal.env")" = "$before" ]
}

@test "legal: a refused render leaves a legal/legal.env already in the release tree as it was" {
    printf 'ORG_NAME=Hand placed\n' > "${RELEASE}/legal/legal.env"
    sed -i 's|^ORG_NAME=.*|ORG_NAME=CHANGE_ME_OPERATOR_ORG_NAME|' "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [ "$(cat "${RELEASE}/legal/legal.env")" = "ORG_NAME=Hand placed" ]
}

@test "legal: the rendered file and its host source are mode 0600 (Linux only)" {
    [[ "$(uname -s)" == Linux ]] || skip "file modes are not meaningful on Windows"
    rm -f "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE" --init-legal-env
    [ "$status" -eq 0 ]
    [ "$(stat -c '%a' "${GREMION_ROOT}/etc/legal.env")" = "600" ]
    write_legal_env
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 0 ]
    [ "$(stat -c '%a' "${RELEASE}/legal/legal.env")" = "600" ]
}

@test "legal: an absent etc/legal.env is created with operator placeholders and the render stops (exit 2)" {
    rm -f "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"legal env file absent"* ]]
    [[ "$output" == *"${GREMION_ROOT}/etc/legal.env"* ]]
    [ -s "${GREMION_ROOT}/etc/legal.env" ]
    [ ! -e "${RELEASE}/legal/legal.env" ]
    local k
    for k in ORG_NAME ORG_ADDRESS ORG_EMAIL RESPONSIBLE_PERSON RESPONSIBLE_PERSON_EMAIL; do
        grep -qx "${k}=CHANGE_ME_OPERATOR_${k}" "${GREMION_ROOT}/etc/legal.env" \
            || { echo "${k} is not an operator placeholder in the created file"; false; }
    done
    # the domain is the platform domain, not something to fill in
    grep -qx 'DOMAIN=example.org' "${GREMION_ROOT}/etc/legal.env"
    # every key of the example is declared
    for k in $(legal_example_keys); do
        grep -q "^${k}=" "${GREMION_ROOT}/etc/legal.env" || { echo "created file lacks ${k}"; false; }
    done
}

@test "legal: the created placeholders are refused on the next render and the file is not rewritten" {
    rm -f "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    local first
    first="$(cat "${GREMION_ROOT}/etc/legal.env")"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CHANGE_ME_OPERATOR_"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
    [ "$(cat "${GREMION_ROOT}/etc/legal.env")" = "$first" ]
}

@test "legal: a key still holding the example's placeholder is refused, by key name, without its value" {
    local k ph
    for k in ORG_NAME ORG_ADDRESS ORG_EMAIL RESPONSIBLE_PERSON RESPONSIBLE_PERSON_EMAIL DOMAIN; do
        write_legal_env
        ph="$(grep -E "^${k}=" "${RELEASE}/legal/legal.env.example" | head -n 1)"
        sed -i "s|^${k}=.*|${ph}|" "${GREMION_ROOT}/etc/legal.env"
        run "$RENDER" --release "$RELEASE"
        [ "$status" -eq 2 ] || { echo "${k}: status ${status}"; false; }
        [[ "$output" == *"${k}"* ]] || { echo "${k}: not named: ${output}"; false; }
        [[ "$output" != *"${ph#*=}"* ]] || { echo "${k}: the placeholder value was printed"; false; }
        [ ! -e "${RELEASE}/legal/legal.env" ] || { echo "${k}: a legal.env was rendered"; false; }
    done
}

@test "legal: an empty operator key is refused" {
    sed -i 's|^ORG_ADDRESS=.*|ORG_ADDRESS=|' "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"ORG_ADDRESS"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
}

@test "legal: a key the example declares but etc/legal.env lacks is refused by name" {
    sed -i '/^ACCESSIBILITY_DATE=/d' "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"missing key ACCESSIBILITY_DATE"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
}

@test "legal: a duplicate key in etc/legal.env is refused" {
    printf 'ORG_NAME=Zweites Gremium\n' >> "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"duplicate"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
}

@test "legal: a release tree without legal/legal.env.example exits 2" {
    rm -f "${RELEASE}/legal/legal.env.example"
    run "$RENDER" --release "$RELEASE"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no legal/legal.env.example"* ]]
}

@test "legal: --legal-env-only renders the legal file and nothing else" {
    run "$RENDER" --release "$RELEASE" --legal-env-only
    [ "$status" -eq 0 ]
    cmp "${GREMION_ROOT}/etc/legal.env" "${RELEASE}/legal/legal.env"
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt" ]
    [ ! -e "$GEN_CA_CALLS" ]
    [ ! -e "${GREMION_ROOT}/etc/secrets/ipcrypt_key.txt" ]
    [[ "$output" =~ RENDER:\ outputs=1\ release=${RELEASE} ]]
}

@test "legal: --legal-env-only refuses what the full render refuses" {
    sed -i 's|^ORG_NAME=.*|ORG_NAME=CHANGE_ME_OPERATOR_ORG_NAME|' "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE" --legal-env-only
    [ "$status" -eq 2 ]
    [[ "$output" == *"ORG_NAME"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
}

@test "legal: --init-legal-env creates etc/legal.env, reports what is left, and touches no release file" {
    rm -f "${GREMION_ROOT}/etc/legal.env"
    run "$RENDER" --release "$RELEASE" --init-legal-env
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/etc/legal.env" ]
    [[ "$output" == *"LEGAL-ENV:"* ]]
    [[ "$output" == *"unfilled=5"* ]]
    [ ! -e "${RELEASE}/legal/legal.env" ]
    [ ! -e "${RELEASE}/docker/pgbouncer/userlist.txt" ]
}

@test "legal: --init-legal-env keeps an existing etc/legal.env as it is" {
    printf '# kept\n' >> "${GREMION_ROOT}/etc/legal.env"
    local first
    first="$(cat "${GREMION_ROOT}/etc/legal.env")"
    run "$RENDER" --release "$RELEASE" --init-legal-env
    [ "$status" -eq 0 ]
    [[ "$output" == *"unfilled=0"* ]]
    [ "$(cat "${GREMION_ROOT}/etc/legal.env")" = "$first" ]
}

@test "legal: --init-legal-env and --legal-env-only cannot be combined" {
    run "$RENDER" --release "$RELEASE" --init-legal-env --legal-env-only
    [ "$status" -eq 2 ]
    [[ "$output" == *"cannot be combined"* ]]
}
