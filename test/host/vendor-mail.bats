#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-vendor-mail (TASK-015), the host launcher of
# the ops/vendor-mail checks. Unit only: docker is a recording shim, and the
# "release" is a throwaway copy laid out the way <root>/current is on a host
# (a full clone, gremion-deploy), so ${SCRIPT_DIR}/../../../ops/vendor-mail
# resolves exactly as it does there.
# Run: bats test/host/vendor-mail.bats

load 'test_helper/host'

NODE_DIGEST_IMAGE='docker.io/library/node@sha256:3333333333333333333333333333333333333333333333333333333333333333'

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib" "${REL}/infra/host/templates/env" \
             "${REL}/ops/vendor-mail"
    cp "${HOST_SRC}/bin/gremion-vendor-mail" "${REL}/infra/host/bin/"
    cp "${HOST_SRC}/lib/common.sh" "${REL}/infra/host/lib/"
    cp "${HOST_SRC}/templates/env/"*.tmpl "${REL}/infra/host/templates/env/"
    : > "${REL}/ops/vendor-mail/check-received.mjs"
    : > "${REL}/ops/vendor-mail/principals.mjs"
    LAUNCHER="${REL}/infra/host/bin/gremion-vendor-mail"
    write_mail_env "$NODE_DIGEST_IMAGE"
    shim docker 'exit 0'
}

teardown() {
    teardown_host_root
}

# write_mail_env <node image line value, or __absent__>
write_mail_env() {
    local f="${GREMION_ROOT}/etc/env/mail.env"
    cat > "$f" <<ENV
GREMION_ROOT=${GREMION_ROOT}
STACK=guardstack
COMPOSE_PROJECT_NAME=guardstack-mail
COMPOSE_FILE=docker-compose.yml
COMPOSE_PROFILES=mail
PLATFORM_DOMAIN=example.org
ACME_EMAIL=ops@example.org
MAIL_BIND_IP=192.0.2.25
MAIL_BIND_IP6=2001:db8::25
EDGE_BIND_IP=192.0.2.10
EDGE_BIND_IP6=2001:db8::a
MAIL_V4_SUBNET=10.90.9.0/24
MAIL_V6_SUBNET=fd5a:99::/64
APP_BLUE_V4_SUBNET=10.90.2.0/24
APP_GREEN_V4_SUBNET=10.90.3.0/24
STALWART_IMAGE=docker.io/stalwartlabs/stalwart@sha256:1111111111111111111111111111111111111111111111111111111111111111
PROBE_CURL_IMAGE=docker.io/curlimages/curl@sha256:2222222222222222222222222222222222222222222222222222222222222222
DKIM_SELECTOR_A=g2026a
DKIM_SELECTOR_B=g2026b
MAIL_ACCOUNT_QUOTA=5368709120
MAIL_RATE_LIMIT_RCPT=100/1h
MAIL_LOG_RETENTION_DAYS=7
STALWART_ADMIN_URL=http://127.0.0.1:8086
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=unit-admin-secret-value
STALWART_API_KEY=unit-api-key-secret-value
VENDOR_SMTP_PASSWORD=unit-vendor-secret-value
ALERT_SMTP_PASSWORD=unit-alert-secret-value
PLATFORM_SMTP_PASSWORD=unit-platform-secret-value
ROLES_IMAP_PASSWORD=unit-roles-secret-value
MAIL_DNS_RESOLVER=192.0.2.53
KEYCLOAK_PROBE_REALM=master
KEYCLOAK_PROBE_USER=operator
ENV
    if [[ "$1" != "__absent__" ]]; then
        printf 'VENDOR_MAIL_NODE_IMAGE=%s\n' "$1" >> "$f"
    fi
}

refute_secret_in_argv() {
    local v
    for v in unit-admin-secret-value unit-api-key-secret-value unit-vendor-secret-value \
             unit-alert-secret-value unit-platform-secret-value unit-roles-secret-value; do
        ! grep -qF -- "$v" "$SHIM_LOG" || { echo "secret ${v} on a recorded argv:"; cat "$SHIM_LOG"; return 1; }
        [[ "$output" != *"$v"* ]] || { echo "secret ${v} printed"; return 1; }
    done
}

@test "gremion-vendor-mail exists and is executable" {
    [ -x "${HOST_SRC}/bin/gremion-vendor-mail" ]
}

@test "a release without ops/vendor-mail is a named failure (exit 2), docker never runs" {
    rm -rf "${REL}/ops/vendor-mail"
    run "$LAUNCHER" check-received --file /dev/null
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"ops/vendor-mail"* ]]
    refute_recorded docker 'run'
}

@test "VENDOR_MAIL_NODE_IMAGE is read from mail.env only: absent there is exit 2 even when exported" {
    write_mail_env __absent__
    VENDOR_MAIL_NODE_IMAGE="$NODE_DIGEST_IMAGE" run "$LAUNCHER" check-received --file /dev/null
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"VENDOR_MAIL_NODE_IMAGE"* ]]
    refute_recorded docker 'run'
}

@test "a node image pinned by tag, not digest, is refused (exit 2)" {
    write_mail_env 'docker.io/library/node:26-alpine'
    run "$LAUNCHER" check-received --file /dev/null
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"digest"* ]]
    refute_recorded docker 'run'
}

@test "a check runs as docker run --rm of the digest image, named and labelled, network none, ops/vendor-mail read-only" {
    run "$LAUNCHER" check-received --file /dev/null
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    assert_recorded docker 'run --rm'
    assert_recorded docker '--name guardstack-vendor-mail-check-received-'
    assert_recorded docker '--label gremion.stack=guardstack'
    assert_recorded docker '--network none'
    assert_recorded docker "${REL}/ops/vendor-mail:/release/ops/vendor-mail:ro"
    assert_recorded docker "$NODE_DIGEST_IMAGE node /release/ops/vendor-mail/check-received.mjs"
    refute_secret_in_argv
}

@test "principals is the one check on the host network, and still carries no secret in argv" {
    run "$LAUNCHER" principals list --tenant alpha_council
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    assert_recorded docker '--network host'
    assert_recorded docker 'principals.mjs list --tenant alpha_council'
    refute_secret_in_argv
}

@test "the check's exit code is the launcher's exit code" {
    shim docker 'exit 1'
    run "$LAUNCHER" check-received --file /dev/null
    [ "$status" -eq 1 ]
}

@test "an unknown subcommand is a usage error (exit 2)" {
    run "$LAUNCHER" frobnicate
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage"* ]]
}

@test "realm-smtp reserves --realm/--tenant/--rotate/--revoke for TASK-043 and refuses them (exit 2)" {
    local a
    for a in "--realm alpha" "--realm alpha --tenant alpha_council" "--realm alpha --rotate" "--realm alpha --revoke"; do
        # shellcheck disable=SC2086
        run "$LAUNCHER" realm-smtp $a
        [ "$status" -eq 2 ] || { echo "${a}: status=$status $output"; return 1; }
        [[ "$output" == *"owned by TASK-043"* ]] || { echo "${a}: $output"; return 1; }
    done
    refute_recorded docker 'exec'
}

# ---------------------------------------------------------------------------
# realm-smtp: the operator realm sends as system@ (kcadm, label lookup, /auth)
# ---------------------------------------------------------------------------

# shim_keycloak [readback] — a docker that knows the state keycloak ONLY by its
# compose labels (its name is <stack>-state-keycloak-1, so a lookup by
# <stack>-state-keycloak finds nothing) and whose kcadm serves only under
# /auth. Realm smtpServer state lives in files, so a second run sees the first.
# readback=broken stores a different user than it was sent (read-back guard).
shim_keycloak() {
    local mode="${1:-ok}" expect_pw="${2:-unit-kc-admin-password}"
    mkdir -p "${GREMION_ROOT}/kc"
    echo "$mode" > "${GREMION_ROOT}/kc/mode"
    shim docker '
ST="'"${GREMION_ROOT}"'/kc"; KC=kc0a1b2c3d4e
case "$1" in
  ps)
    case " $* " in
      *"label=com.docker.compose.project=guardstack-state "*"label=com.docker.compose.service=keycloak "*) echo "$KC" ;;
    esac
    exit 0 ;;
  inspect) echo "Error: No such object: $2" >&2; exit 1 ;;
  exec) shift ;;
  *) exit 0 ;;
esac
while :; do case "$1" in -i) shift ;; -e) shift 2 ;; *) break ;; esac; done
cid="$1"; shift
[ "$cid" = "$KC" ] || { echo "Error response from daemon: No such container: $cid" >&2; exit 1; }
case " $* " in
  *"config credentials"*)
    case " $* " in *" http://127.0.0.1:8080/auth "*) ;; *) echo "HTTP 404 (no /auth)" >&2; exit 1 ;; esac
    [ "${KC_LOGIN_PASSWORD:-}" = "'"${expect_pw}"'" ] || { echo "invalid_grant" >&2; exit 1; }
    touch "$ST/logged-in"; exit 0 ;;
esac
[ -f "$ST/logged-in" ] || { echo "not logged in" >&2; exit 1; }
realm=""
for a in "$@"; do case "$a" in realms/*) realm="${a#realms/}" ;; esac; done
case " $* " in
  *" update realms/"*" -f - "*)
    cat > "$ST/payload-$realm.json"
    if [ "$(cat "$ST/mode")" = broken ]; then
      jq -c ".smtpServer | del(.password) | .user = \"someone-else@example.org\"" "$ST/payload-$realm.json" > "$ST/realm-$realm.json"
    else
      jq -c ".smtpServer | del(.password)" "$ST/payload-$realm.json" > "$ST/realm-$realm.json"
    fi
    exit 0 ;;
  *" get realms/"*" --fields smtpServer "*)
    if [ -f "$ST/realm-$realm.json" ]; then jq -c "{smtpServer: .}" "$ST/realm-$realm.json"; else echo "{}"; fi
    exit 0 ;;
  *" get realms --fields realm,smtpServer "*)
    printf "["; sep=""
    for f in "$ST"/realm-*.json; do [ -f "$f" ] || continue; r="${f##*/realm-}"; r="${r%.json}"
      printf "%s{\"realm\":\"%s\",\"smtpServer\":%s}" "$sep" "$r" "$(cat "$f")"; sep=","; done
    printf "]\n"; exit 0 ;;
esac
echo "unexpected kcadm call: $*" >&2; exit 1'
}

write_state_env() {
    printf 'KEYCLOAK_ADMIN=admin\nKEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-password\n' \
        > "${GREMION_ROOT}/etc/env/state.env"
}

@test "realm-smtp points master at system@ through mail.<domain>:587 STARTTLS, password on stdin only" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    [[ "$output" == *"REALM-SMTP: realm=master user=system@example.org changed=yes"* ]]
    run jq -e '.smtpServer | .host == "mail.example.org" and .port == "587" and .starttls == "true"
               and .auth == "true" and .user == "system@example.org" and .from == "system@example.org"
               and .password == "unit-vendor-secret-value"' "${GREMION_ROOT}/kc/payload-master.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/kc/payload-master.json"; return 1; }
    ! grep -qF 'unit-kc-admin-password' "$SHIM_LOG" || { echo "kc admin password on a docker argv"; return 1; }
    run "$LAUNCHER" realm-smtp
    refute_secret_in_argv
    [[ "$output" != *"unit-kc-admin-password"* ]]
}

@test "realm-smtp is idempotent: the second run reports changed=no and leaves the realm as it was" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ]
    local before; before="$(cat "${GREMION_ROOT}/kc/realm-master.json")"
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"changed=no"* ]]
    [ "$(cat "${GREMION_ROOT}/kc/realm-master.json")" = "$before" ]
}

@test "realm-smtp fails (exit 1) when the realm reads back something other than it wrote" {
    shim_keycloak broken
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"read back"* ]]
    [[ "$output" != *"unit-vendor-secret-value"* ]]
}

@test "realm-smtp finds keycloak by its compose labels, not by a container name" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ]
    assert_recorded docker 'label=com.docker.compose.project=guardstack-state'
    refute_recorded docker 'guardstack-state-keycloak'
}

@test "realm-smtp with no running state keycloak is a named precondition failure (exit 2)" {
    shim docker 'exit 0'
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"no single running keycloak"* ]]
}

# ---------------------------------------------------------------------------
# collect: the host inputs of check-principals, secrets stripped
# ---------------------------------------------------------------------------

# shim_principal_list <json body> — curl answering the principal list with
# HTTP 200 and <json body>, as the pinned build does for success AND failure.
# It also records the credential it was handed on stdin (-K -), so a test can
# prove the credential never rode on the argv.
shim_principal_list() {
    printf '%s' "$1" > "${GREMION_ROOT}/principal-list.json"
    shim curl '
out=""
while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -K) cat > "'"${GREMION_ROOT}"'/curl-config"; shift 2 ;; *) shift ;; esac; done
if [ -n "$out" ]; then cp "'"${GREMION_ROOT}"'/principal-list.json" "$out"; else cat "'"${GREMION_ROOT}"'/principal-list.json"; fi'
}

@test "collect writes names/emails/roles and realm smtp users, never a secret" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ]
    shim_principal_list '{"data":{"items":[{"id":2,"type":"individual","name":"system@example.org","emails":["system@example.org"],"roles":["user"],"secrets":["$app$gremion-vendor$unit-vendor-secret-value"]}],"total":1}}'
    mkdir -p "${GREMION_ROOT}/collect"
    run "$LAUNCHER" collect --out "${GREMION_ROOT}/collect"
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    run jq -e '. == [{"name":"system@example.org","type":"individual","emails":["system@example.org"],"roles":["user"]}]' "${GREMION_ROOT}/collect/principals.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/collect/principals.json"; return 1; }
    run jq -e '.[0] | .realm == "master" and .smtp.user == "system@example.org" and (.smtp | has("password") | not)' "${GREMION_ROOT}/collect/realms.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/collect/realms.json"; return 1; }
    ! grep -rqF 'unit-vendor-secret-value' "${GREMION_ROOT}/collect" || { echo "a secret reached the collect output"; return 1; }
    grep -qF 'unit-admin-secret-value' "${GREMION_ROOT}/curl-config"
    refute_secret_in_argv
}

@test "collect: an HTTP 200 {\"error\":...} principal list is a failure (exit 1), not an empty list" {
    shim_keycloak
    write_state_env
    shim_principal_list '{"error":"forbidden","details":"quirk"}'
    mkdir -p "${GREMION_ROOT}/collect"
    run "$LAUNCHER" collect --out "${GREMION_ROOT}/collect"
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"is a failure, not an empty list"* ]]
    [ ! -f "${GREMION_ROOT}/collect/principals.json" ]
}

@test "collect: a kcadm that cannot list the realms is a failure (exit 1)" {
    shim_keycloak
    write_state_env
    shim_principal_list '{"data":{"items":[],"total":0}}'
    # the keycloak shim knows no `get realms` until a realm file exists; make
    # the listing itself fail
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" docker "$*" >> "$SHIM_LOG"\ncase " $* " in *" get realms --fields realm,smtpServer "*) echo "kcadm: 500" >&2; exit 1 ;; esac\nexec %s "$@"\n' \
        "${SHIM_DIR}/docker.real" > "${SHIM_DIR}/docker.wrap"
    mv "${SHIM_DIR}/docker" "${SHIM_DIR}/docker.real"; mv "${SHIM_DIR}/docker.wrap" "${SHIM_DIR}/docker"; chmod +x "${SHIM_DIR}/docker"
    mkdir -p "${GREMION_ROOT}/collect"
    run "$LAUNCHER" collect --out "${GREMION_ROOT}/collect"
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"kcadm could not list the realms"* ]]
}

# ---------------------------------------------------------------------------
# review round 1 (TASK-015): network, logs, mounts, --host paths, env reads
# ---------------------------------------------------------------------------

@test "every node subcommand but principals runs with --network none and --log-driver none" {
    local sub
    for sub in check-identities check-received check-upstream-image check-deliverability-record; do
        : > "$SHIM_LOG"
        : > "${REL}/ops/vendor-mail/${sub}.mjs"
        : > "${GREMION_ROOT}/etc/env/ops.env"
        run "$LAUNCHER" "$sub" --file /dev/null
        [ "$status" -eq 0 ] || { echo "${sub}: status=$status $output"; return 1; }
        assert_recorded docker "--name guardstack-vendor-mail-${sub}-"
        assert_recorded docker '--network none'
        refute_recorded docker '--network host'
        assert_recorded docker '--log-driver none'
    done
    : > "$SHIM_LOG"
    run "$LAUNCHER" principals list
    assert_recorded docker '--network host'
    # the one-time app password must not land in the daemon's log driver
    assert_recorded docker '--log-driver none'
}

@test "check-received gets the domain and bind addresses as arguments, not the secret-bearing mail.env" {
    run "$LAUNCHER" check-received --file /dev/null --receiver google
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    refute_recorded docker '/run/gremion/env/mail.env'
    assert_recorded docker 'check-received.mjs --domain example.org --bind-ip 192.0.2.25 --bind-ip6 2001:db8::25 --file /run/gremion/in/received.eml --receiver google'
}

@test "a relative MAIL_ENV is mounted by its absolute path" {
    cp "${GREMION_ROOT}/etc/env/mail.env" "${GREMION_ROOT}/rel-mail.env"
    ( cd "$GREMION_ROOT" && MAIL_ENV=rel-mail.env "$LAUNCHER" principals list ) || true
    assert_recorded docker "${GREMION_ROOT}/rel-mail.env:/run/gremion/env/mail.env:ro"
}

@test "check-secret-separation --host mounts the stores read-only and hands over only hashes of the ui env" {
    : > "${REL}/ops/vendor-mail/check-secret-separation.mjs"
    mkdir -p "${GREMION_ROOT}/etc/secrets/mail" "${GREMION_ROOT}/etc/secrets/tenants"
    echo green > "${GREMION_ROOT}/runtime/active-colour"
    shim docker '
case "$1" in
  ps) case " $* " in *"project=guardstack-app-green "*"service=gremion-ui "*) echo uicid1 ;; esac; exit 0 ;;
  inspect) printf "SECRET_THING=unit-ui-secret-value\nPLAIN=x\n\n"; exit 0 ;;
  run) for a in "$@"; do case "$a" in *:/run/gremion/collect:ro) cp "${a%%:*}/ui-env.tsv" "'"${GREMION_ROOT}"'/ui-env.copy" ;; esac; done; exit 0 ;;
esac
exit 0'
    run "$LAUNCHER" check-secret-separation --host
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    assert_recorded docker '--network none'
    refute_recorded docker '--network host'
    assert_recorded docker "${GREMION_ROOT}/etc/env:/run/gremion/env-all:ro"
    assert_recorded docker "${GREMION_ROOT}/etc/secrets:/run/gremion/secrets:ro"
    grep -qP '^green\tSECRET_THING\t[0-9a-f]{64}$' "${GREMION_ROOT}/ui-env.copy" || { cat "${GREMION_ROOT}/ui-env.copy"; return 1; }
    ! grep -qF 'unit-ui-secret-value' "${GREMION_ROOT}/ui-env.copy" || { echo "a raw ui env value reached the check"; return 1; }
    [[ "$output" == *"gremion-ui containers hashed: 1"* ]]
}

@test "check-secret-separation --host with the active colour's gremion-ui not running is a precondition failure" {
    : > "${REL}/ops/vendor-mail/check-secret-separation.mjs"
    mkdir -p "${GREMION_ROOT}/etc/secrets/mail" "${GREMION_ROOT}/etc/secrets/tenants"
    echo green > "${GREMION_ROOT}/runtime/active-colour"
    shim docker 'exit 0'
    run "$LAUNCHER" check-secret-separation --host
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"no gremion-ui container of the active colour green"* ]]
    refute_recorded docker 'run --rm'
}

@test "check-secret-separation --host: a docker inspect that fails is a failure, not an empty environment" {
    : > "${REL}/ops/vendor-mail/check-secret-separation.mjs"
    mkdir -p "${GREMION_ROOT}/etc/secrets/mail" "${GREMION_ROOT}/etc/secrets/tenants"
    echo blue > "${GREMION_ROOT}/runtime/active-colour"
    shim docker '
case "$1" in
  ps) case " $* " in *"project=guardstack-app-blue "*"service=gremion-ui "*) echo uicid1 ;; esac; exit 0 ;;
  inspect) echo "Error: No such object: uicid1" >&2; exit 1 ;;
esac
exit 0'
    run "$LAUNCHER" check-secret-separation --host
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    refute_recorded docker 'run --rm'
}

@test "check-principals --host runs collect first and mounts its output read-only" {
    : > "${REL}/ops/vendor-mail/check-principals.mjs"
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    shim_principal_list '{"data":{"items":[{"name":"system@example.org","type":"individual","emails":["system@example.org"],"roles":["user"]}],"total":1}}'
    local wrapped="${SHIM_DIR}/docker"
    mv "$wrapped" "${SHIM_DIR}/docker.kc"
    printf '#!/usr/bin/env bash\nif [ "$1" = run ]; then printf "%%s %%s\\n" docker "$*" >> "$SHIM_LOG"; for a in "$@"; do case "$a" in *:/run/gremion/collect:ro) ls "${a%%%%:*}" > "%s/collect.ls" ;; esac; done; exit 0; fi\nexec %s "$@"\n' \
        "$GREMION_ROOT" "${SHIM_DIR}/docker.kc" > "$wrapped"
    chmod +x "$wrapped"
    run "$LAUNCHER" check-principals --host --no-allowances
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    assert_recorded docker ':/run/gremion/collect:ro'
    assert_recorded docker '--network none'
    refute_recorded docker '--network host'
    assert_recorded docker 'check-principals.mjs --host --no-allowances'
    grep -qx 'principals.json' "${GREMION_ROOT}/collect.ls"
    grep -qx 'realms.json' "${GREMION_ROOT}/collect.ls"
}

@test "collect leaves no copy of the principal list (plaintext app secrets) in a temp directory" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    shim_principal_list '{"data":{"items":[{"name":"system@example.org","secrets":["$app$gremion-vendor$unit-vendor-secret-value"]}],"total":1}}'
    mkdir -p "${GREMION_ROOT}/collect" "${GREMION_ROOT}/tmp"
    TMPDIR="${GREMION_ROOT}/tmp" run "$LAUNCHER" collect --out "${GREMION_ROOT}/collect"
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    ! grep -rqF 'unit-vendor-secret-value' "${GREMION_ROOT}/tmp" || { echo "a temp file kept the secrets"; return 1; }
}

@test "state.env keys are read like load_env reads them: one layer of quotes stripped, a duplicate refused" {
    shim_keycloak
    printf 'KEYCLOAK_ADMIN="admin"\nKEYCLOAK_ADMIN_PASSWORD="unit-kc-admin-password"\n' > "${GREMION_ROOT}/etc/env/state.env"
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    printf 'KEYCLOAK_ADMIN=admin\nKEYCLOAK_ADMIN_PASSWORD=a\nKEYCLOAK_ADMIN_PASSWORD=b\n' > "${GREMION_ROOT}/etc/env/state.env"
    run "$LAUNCHER" realm-smtp
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"duplicate key KEYCLOAK_ADMIN_PASSWORD"* ]]
}

@test "collect escapes a quote or backslash in the admin password for curl's config" {
    shim_keycloak
    write_state_env
    run "$LAUNCHER" realm-smtp
    sed -i 's/^STALWART_ADMIN_PASSWORD=.*/STALWART_ADMIN_PASSWORD=unit"adm\\in/' "${GREMION_ROOT}/etc/env/mail.env"
    shim_principal_list '{"data":{"items":[],"total":0}}'
    mkdir -p "${GREMION_ROOT}/collect"
    run "$LAUNCHER" collect --out "${GREMION_ROOT}/collect"
    grep -qxF 'user = "admin:unit\"adm\\in"' "${GREMION_ROOT}/curl-config" || { cat "${GREMION_ROOT}/curl-config"; return 1; }
}
