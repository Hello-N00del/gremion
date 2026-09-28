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
