#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-mail (PLAN-mail-transport M2), the deploy-time
# mail transport front: MAIL_TRANSPORT=relay|stalwart, no default. Unit only:
# docker is a recording shim that plays the state Keycloak's kcadm (realm
# smtpServer state lives in files, so a second run sees the first) and the
# principals CLI of the stalwart arm. The release is laid out the way
# <root>/current is on a host.
# Run: bats test/host/mail-transport.bats

load 'test_helper/host'

NODE_DIGEST_IMAGE='docker.io/library/node@sha256:3333333333333333333333333333333333333333333333333333333333333333'
RELAY_PW='unit-relay-secret-value'

setup() {
    setup_host_root
    REL="${GREMION_ROOT}/current"
    mkdir -p "${REL}/infra/host/bin" "${REL}/infra/host/lib" "${REL}/ops/vendor-mail" "${GREMION_ROOT}/etc/secrets/mail"
    cp "${HOST_SRC}/bin/gremion-mail" "${HOST_SRC}/bin/gremion-vendor-mail" "${REL}/infra/host/bin/"
    cp "${HOST_SRC}/lib/common.sh" "${REL}/infra/host/lib/"
    : > "${REL}/ops/vendor-mail/principals.mjs"
    MAIL="${REL}/infra/host/bin/gremion-mail"
    unset MAIL_TRANSPORT
    printf 'KEYCLOAK_ADMIN=admin\nKEYCLOAK_ADMIN_PASSWORD=unit-kc-admin-password\n' > "${GREMION_ROOT}/etc/env/state.env"
    printf '%s\n' "$RELAY_PW" > "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    chmod 600 "${GREMION_ROOT}/etc/secrets/mail/relay-password"
}

teardown() {
    teardown_host_root
}

# write_mail_env <transport line value or __absent__> [extra lines...]
write_mail_env() {
    local t="$1"; shift
    {
        printf 'STACK=guardstack\nPLATFORM_DOMAIN=example.org\n'
        printf 'VENDOR_SMTP_PASSWORD=unit-vendor-secret-value\n'
        printf 'VENDOR_MAIL_NODE_IMAGE=%s\n' "$NODE_DIGEST_IMAGE"
        if [[ "$t" != "__absent__" ]]; then printf 'MAIL_TRANSPORT=%s\n' "$t"; fi
        local l; for l in "$@"; do printf '%s\n' "$l"; done
    } > "${GREMION_ROOT}/etc/env/mail.env"
}

relay_env() {   # relay with an authenticating user (the default shape)
    write_mail_env relay \
        'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_PORT=587' 'RELAY_SMTP_USER=relay-user@example.org' \
        'RELAY_SMTP_PASSWORD_REF=secret:mail/relay-password'
}

# shim_keycloak -- a docker that knows the state keycloak by its compose labels
# and whose kcadm keeps each realm's smtpServer in a file (the password is
# answered as Keycloak's mask, never the value). `docker run ... principals.mjs`
# is the stalwart arm's principal CLI; it only RECORDS (the recorder is proven
# to work by the stalwart-mode test, which must see > 0 calls).
shim_keycloak() {
    mkdir -p "${GREMION_ROOT}/kc"
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
  run)
    case "$*" in
      *principals.mjs*list*) echo "KC-PRINCIPALS: 0"; echo "principals-call list" >> "$ST/principals-calls"; exit 0 ;;
      *principals.mjs*issue*) echo "principals-call issue" >> "$ST/principals-calls"; echo "KC-PRINCIPAL: issued kc-x@example.org"; echo "APP-PASSWORD: unit-app-password-1"; exit 0 ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
while :; do case "$1" in -i) shift ;; -e) shift 2 ;; *) break ;; esac; done
cid="$1"; shift
[ "$cid" = "$KC" ] || { echo "No such container: $cid" >&2; exit 1; }
case " $* " in
  *"config credentials"*)
    [ "${KC_LOGIN_PASSWORD:-}" = "unit-kc-admin-password" ] || { echo "invalid_grant" >&2; exit 1; }
    touch "$ST/logged-in"; exit 0 ;;
esac
[ -f "$ST/logged-in" ] || { echo "not logged in" >&2; exit 1; }
realm=""
for a in "$@"; do case "$a" in realms/*) realm="${a#realms/}" ;; esac; done
case " $* " in
  *" update realms/"*" -f - "*)
    cat > "$ST/payload-$realm.json"
    echo "update-realm $realm" >> "$ST/events"
    [ -f "$ST/update-fails" ] && { echo "HTTP 500 simulated" >&2; exit 1; }
    mask="if ((.password // \"\") != \"\") then .password = \"**********\" else del(.password) end"
    [ -f "$ST/noapply" ] || jq -c ".smtpServer | $mask" "$ST/payload-$realm.json" > "$ST/realm-$realm.json"
    exit 0 ;;
  *" get realms/"*" --fields smtpServer(*) "*)
    if [ -f "$ST/realm-$realm.json" ]; then jq "{smtpServer: .}" "$ST/realm-$realm.json"; else printf "{\"smtpServer\":{}}\n"; fi
    exit 0 ;;
esac
echo "unexpected kcadm call: $*" >&2; exit 1'
}

principal_calls() { cat "${GREMION_ROOT}/kc/principals-calls" 2>/dev/null | wc -l; }

refute_relay_secret() {
    ! grep -qF -- "$RELAY_PW" "$SHIM_LOG" || { echo "the relay password is on a recorded argv:"; cat "$SHIM_LOG"; return 1; }
    [[ "$output" != *"$RELAY_PW"* ]] || { echo "the relay password was printed: $output"; return 1; }
    ! grep -qF -- 'unit-kc-admin-password' "$SHIM_LOG" || { echo "the kc admin password is on a docker argv"; return 1; }
}

# ── no default, fail closed ─────────────────────────────────────────────────

@test "gremion-mail exists, is executable and sets strict mode" {
    [ -x "${HOST_SRC}/bin/gremion-mail" ]
    assert_present '^set -euo pipefail$' "${HOST_SRC}/bin/gremion-mail"
}

@test "guard: MAIL_TRANSPORT unset in the env AND absent from mail.env is exit 2, naming the key, no kcadm and no principal call" {
    write_mail_env __absent__
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"MAIL_TRANSPORT"* ]]
    [ ! -s "$SHIM_LOG" ] || { cat "$SHIM_LOG"; return 1; }
    run "$MAIL" transport
    [ "$status" -eq 2 ]
}

@test "guard: no mail.env at all is exit 2 too (never a silent stalwart)" {
    run "$MAIL" transport
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
}

@test "guard: an unknown MAIL_TRANSPORT is exit 2 and names the value" {
    write_mail_env carrier-pigeon
    run "$MAIL" transport
    [ "$status" -eq 2 ]
    [[ "$output" == *"carrier-pigeon"* ]]
}

@test "transport: the exported variable wins over mail.env, mail.env is read otherwise" {
    relay_env
    run "$MAIL" transport
    [ "$status" -eq 0 ]; [ "$output" = relay ]
    MAIL_TRANSPORT=stalwart run "$MAIL" transport
    [ "$status" -eq 0 ]; [ "$output" = stalwart ]
}

# ── stalwart: byte-identical hand-over ──────────────────────────────────────

@test "stalwart: realm-smtp hands over to gremion-vendor-mail and the principal CLI IS called (the recorder works)" {
    write_mail_env stalwart
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    [[ "$output" == *"REALM-SMTP: realm=alpha-council user=kc-alpha_council@example.org changed=yes action=issued"* ]] || { echo "$output"; return 1; }
    [ "$(principal_calls)" -gt 0 ] || { echo "the principals recorder saw nothing in stalwart mode"; return 1; }
    run jq -e '.smtpServer | .host == "mail.example.org" and .user == "kc-alpha_council@example.org"' "${GREMION_ROOT}/kc/payload-alpha-council.json"
    [ "$status" -eq 0 ]
}

@test "stalwart: sender-json is the bare stalwart descriptor" {
    write_mail_env stalwart
    run "$MAIL" sender-json
    [ "$status" -eq 0 ]
    [ "$output" = '{"mode":"stalwart"}' ]
}

# ── relay ───────────────────────────────────────────────────────────────────

@test "relay: a customer realm is stamped with no-reply@ through the relay, ZERO principal calls, the password only in the payload" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "$SHIM_LOG"; return 1; }
    [[ "$output" == *"REALM-SMTP: realm=alpha-council user=no-reply@example.org changed=yes action=stamped transport=relay"* ]] || { echo "$output"; return 1; }
    [ "$(principal_calls)" -eq 0 ] || { echo "relay mode called the principal CLI"; cat "${GREMION_ROOT}/kc/principals-calls"; return 1; }
    refute_recorded docker 'principals.mjs'
    run jq -e '.smtpServer | .host == "relay.example.net" and .port == "587" and .starttls == "true" and .ssl == "false"
               and .auth == "true" and .user == "relay-user@example.org" and .from == "no-reply@example.org"
               and .password == "unit-relay-secret-value"' "${GREMION_ROOT}/kc/payload-alpha-council.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/kc/payload-alpha-council.json"; return 1; }
    refute_relay_secret
}

@test "relay: the second run reports changed=no and sends no update; --rotate re-stamps" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ]
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ]
    [[ "$output" == *"changed=no action=none transport=relay"* ]] || { echo "$output"; return 1; }
    [ "$(grep -c update-realm "${GREMION_ROOT}/kc/events")" -eq 1 ]
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council --rotate
    [ "$status" -eq 0 ]
    [[ "$output" == *"changed=yes action=rotated transport=relay"* ]] || { echo "$output"; return 1; }
    [ "$(grep -c update-realm "${GREMION_ROOT}/kc/events")" -eq 2 ]
    refute_relay_secret
}

@test "relay: master and platform send as system@ through the same relay" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"REALM-SMTP: realm=master user=system@example.org changed=yes"* ]] || { echo "$output"; return 1; }
    run "$MAIL" realm-smtp --realm platform
    [ "$status" -eq 0 ]
    run jq -e '.smtpServer | .from == "system@example.org" and .host == "relay.example.net"' "${GREMION_ROOT}/kc/payload-platform.json"
    [ "$status" -eq 0 ]
    [ "$(principal_calls)" -eq 0 ]
}

@test "relay: --revoke un-stamps and the realm reads back with no user, no from, no authenticating sender (guard 4)" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ]
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council --revoke
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"action=revoked transport=relay"* ]]
    run jq -e '(.user // "") == "" and (.from // "") == "" and (.auth // "") != "true"' "${GREMION_ROOT}/kc/realm-alpha-council.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/kc/realm-alpha-council.json"; return 1; }
    [ "$(principal_calls)" -eq 0 ]
}

@test "relay: the un-stamp read-back catches a Keycloak that did not apply it (exit 1)" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ]
    # a kcadm that accepts the update but keeps the old stamp
    touch "${GREMION_ROOT}/kc/noapply"
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council --revoke
    [ "$status" -eq 1 ] || { echo "status=$status $output"; return 1; }
}

@test "relay: an unauthenticated (IP-allow-listed) relay stamps auth false with no user and no password, and needs no password file" {
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_USER=' 'RELAY_SMTP_PASSWORD_REF='
    rm -f "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ] || { echo "status=$status $output"; cat "${GREMION_ROOT}/kc/payload-alpha-council.json"; return 1; }
    run jq -e '.smtpServer | .auth == "false" and (has("user") | not) and (has("password") | not) and .host == "relay.example.net" and .from == "no-reply@example.org"' "${GREMION_ROOT}/kc/payload-alpha-council.json"
    [ "$status" -eq 0 ] || { cat "${GREMION_ROOT}/kc/payload-alpha-council.json"; return 1; }
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [[ "$output" == *"changed=no"* ]] || { echo "$output"; return 1; }
}

@test "relay: the password is a FILE ref -- an inline value, a missing file and an other-readable file are all refused before any kcadm write" {
    shim_keycloak
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_USER=u@example.org' 'RELAY_SMTP_PASSWORD_REF=hunter2'
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" != *"hunter2"* ]] || { echo "the inline value was echoed"; return 1; }
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_USER=u@example.org' 'RELAY_SMTP_PASSWORD_REF=secret:mail/absent'
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ]
    relay_env
    chmod 644 "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *"readable by other"* ]]
    [ ! -f "${GREMION_ROOT}/kc/events" ] || { cat "${GREMION_ROOT}/kc/events"; return 1; }
}

@test "relay: a relay with no host, or a bad port, is exit 2" {
    shim_keycloak
    write_mail_env relay 'RELAY_SMTP_USER='
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ]; [[ "$output" == *"RELAY_SMTP_HOST"* ]]
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_PORT=99999' 'RELAY_SMTP_USER='
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 2 ]; [[ "$output" == *"RELAY_SMTP_PORT"* ]]
}

@test "relay: port 465 stamps implicit TLS (ssl true, starttls false)" {
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_PORT=465' 'RELAY_SMTP_USER=relay-user@example.org' 'RELAY_SMTP_PASSWORD_REF=secret:mail/relay-password'
    shim_keycloak
    run "$MAIL" realm-smtp --realm alpha-council --tenant alpha_council
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    run jq -e '.smtpServer | .port == "465" and .ssl == "true" and .starttls == "false"' "${GREMION_ROOT}/kc/payload-alpha-council.json"
    [ "$status" -eq 0 ]
}

@test "relay: the realm-smtp arm validation of the stalwart launcher still holds (vendor realm with --tenant, slug/token mismatch)" {
    relay_env
    shim_keycloak
    run "$MAIL" realm-smtp --realm master --tenant master
    [ "$status" -eq 2 ]
    run "$MAIL" realm-smtp --realm alpha-council --tenant wrong_token
    [ "$status" -eq 2 ]
    run "$MAIL" realm-smtp --realm alpha-council
    [ "$status" -eq 2 ]
    run "$MAIL" realm-smtp --rotate
    [ "$status" -eq 2 ]
    [ ! -f "${GREMION_ROOT}/kc/events" ]
}

@test "relay: sender-json carries host, port, the no-reply address and the user, and NO secret" {
    relay_env
    run "$MAIL" sender-json
    [ "$status" -eq 0 ]
    run jq -e '.mode == "relay" and .host == "relay.example.net" and .port == 587 and .fromAddress == "no-reply@example.org" and .user == "relay-user@example.org" and (has("password") | not)' <<<"$output"
    [ "$status" -eq 0 ]
    run "$MAIL" sender-json
    [[ "$output" != *"$RELAY_PW"* ]]
}

@test "relay: RELAY_FROM_DOMAIN overrides the platform domain for every sender" {
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_USER=' 'RELAY_FROM_DOMAIN=mail.example.org'
    run "$MAIL" sender-json
    [[ "$output" == *'"fromAddress":"no-reply@mail.example.org"'* ]] || { echo "$output"; return 1; }
}

@test "no real domain or address in the kernel mail files: only example.* placeholders" {
    run grep -nE '@(gmail|google|googlemail)\.|smtp-relay\.gmail' "${HOST_SRC}/bin/gremion-mail"
    [ "$status" -eq 1 ] || { echo "$output"; return 1; }
}

# ── M0: the deploy-time config shape lives in the env templates ─────────────

MAIL_TMPL="${BATS_TEST_DIRNAME}/../../infra/host/templates/env/mail.env.tmpl"
OPS_TMPL_T="${BATS_TEST_DIRNAME}/../../infra/host/templates/env/ops.env.tmpl"

@test "M0 mail.env.tmpl: MAIL_TRANSPORT is an operator choice with NO default; the relay keys carry the Workspace relay defaults" {
    grep -qx 'MAIL_TRANSPORT=CHANGE_ME_OPERATOR_mail_transport' "$MAIL_TMPL" \
        || { echo "MAIL_TRANSPORT must be an operator sentinel (no default)"; return 1; }
    grep -qx 'RELAY_SMTP_HOST=smtp-relay.gmail.com' "$MAIL_TMPL"
    grep -qx 'RELAY_SMTP_PORT=587' "$MAIL_TMPL"
    grep -qE '^RELAY_SMTP_USER=$' "$MAIL_TMPL"
    grep -qx 'RELAY_SMTP_PASSWORD_REF=secret:mail/relay-password' "$MAIL_TMPL"
    grep -qE '^RELAY_FROM_DOMAIN=$' "$MAIL_TMPL"
    run bash -c "grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' '$MAIL_TMPL' | sort | uniq -d"
    [ -z "$output" ] || { echo "duplicate keys: $output"; return 1; }
}

@test "M0 the relay password is a file ref only: no inline password key in either env template" {
    local f
    for f in "$MAIL_TMPL" "$OPS_TMPL_T"; do
        run grep -nE '^RELAY_SMTP_PASSWORD=' "$f"
        [ "$status" -eq 1 ] || { echo "inline relay password key in $f: $output"; return 1; }
        run grep -nE '^RELAY_SMTP_PASSWORD_REF=(secret:|file:)' "$f"
        [ "$status" -eq 0 ] || { echo "no secret ref key in $f"; return 1; }
    done
}

@test "M0 ops.env.tmpl: MAIL_TRANSPORT is an operator choice with no default and the relay keys are declared once" {
    grep -qx 'MAIL_TRANSPORT=CHANGE_ME_OPERATOR_mail_transport' "$OPS_TMPL_T"
    local k
    for k in RELAY_SMTP_HOST RELAY_SMTP_PORT RELAY_SMTP_USER RELAY_SMTP_PASSWORD_REF; do
        [ "$(grep -cE "^${k}=" "$OPS_TMPL_T")" -eq 1 ] || { echo "$k must be declared exactly once in ops.env.tmpl"; return 1; }
    done
}

@test "M0 a mail.env rendered from the template defaults resolves to the relay: host, port 587, system@/no-reply@ on the platform domain" {
    sed -e 's|^MAIL_TRANSPORT=.*|MAIL_TRANSPORT=relay|' -e 's|^PLATFORM_DOMAIN=.*|PLATFORM_DOMAIN=example.org|' \
        -e 's|^STACK=.*|STACK=guardstack|' "$MAIL_TMPL" > "${GREMION_ROOT}/etc/env/mail.env"
    run "$MAIL" sender-json
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ "$(jq -r .mode <<<"$output")" = relay ]
    [ "$(jq -r .host <<<"$output")" = smtp-relay.gmail.com ]
    [ "$(jq -r .port <<<"$output")" = 587 ]
    [ "$(jq -r .fromAddress <<<"$output")" = no-reply@example.org ]
}

# ── M6: relay-curl-config, the one place the relay password becomes a curl config ──
# The bring-up's authenticated test message pipes this to `curl -K -`: the
# password rides a pipe, never an argv, never a file.

@test "M6 relay-curl-config: a STARTTLS relay on 587 gets smtp://, ssl-reqd, the system@ envelope sender and the password as a user line" {
    relay_env
    run "$MAIL" relay-curl-config --to probe@example.net --message /work/msg
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *'url = "smtp://relay.example.net:587"'* ]]
    [[ "$output" == *'ssl-reqd'* ]]
    [[ "$output" == *'mail-from = "system@example.org"'* ]]
    [[ "$output" == *'mail-rcpt = "probe@example.net"'* ]]
    [[ "$output" == *'upload-file = "/work/msg"'* ]]
    [[ "$output" == *"user = \"relay-user@example.org:${RELAY_PW}\""* ]]
}

@test "M6 relay-curl-config: port 465 is implicit TLS (smtps://, no ssl-reqd); an unauthenticated relay has no user line" {
    write_mail_env relay 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_PORT=465' 'RELAY_SMTP_USER='
    run "$MAIL" relay-curl-config --to probe@example.net --message /work/msg
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *'url = "smtps://relay.example.net:465"'* ]]
    [[ "$output" != *'ssl-reqd'* ]]
    [[ "$output" != *'user ='* ]]
}

@test "M6 relay-curl-config: a password with a quote and a backslash is escaped so it cannot end the curl value early" {
    relay_env
    printf '%s\n' 'pa"ss\w' > "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    chmod 600 "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    run "$MAIL" relay-curl-config --to probe@example.net --message /work/msg
    [ "$status" -eq 0 ] || { echo "status=$status $output"; return 1; }
    [[ "$output" == *'user = "relay-user@example.org:pa\"ss\\w"'* ]] || { echo "$output"; return 1; }
}

@test "M6 relay-curl-config: refuses in stalwart mode, on a bad recipient, a quote in the path, a missing --to, and a world-readable password file" {
    # a stalwart env that is otherwise a COMPLETE relay config: only the
    # transport guard can refuse it (without these keys load_relay_config would
    # exit 2 on the missing host and the guard could be deleted unnoticed)
    write_mail_env stalwart 'RELAY_SMTP_HOST=relay.example.net' 'RELAY_SMTP_PORT=587'         'RELAY_SMTP_USER=relay-user@example.org' 'RELAY_SMTP_PASSWORD_REF=secret:mail/relay-password'
    run "$MAIL" relay-curl-config --to probe@example.net --message /work/msg
    [ "$status" -eq 2 ] || { echo "stalwart: status=$status $output"; return 1; }
    [[ "$output" == *"relay-mode verb"* && "$output" != *"user ="* ]] || { echo "stalwart: $output"; return 1; }
    relay_env
    run "$MAIL" relay-curl-config --to 'a b@example.net' --message /work/msg
    [ "$status" -eq 2 ] || { echo "bad rcpt: status=$status $output"; return 1; }
    run "$MAIL" relay-curl-config --to probe@example.net --message '/work/m"sg'
    [ "$status" -eq 2 ] || { echo "bad path: status=$status $output"; return 1; }
    run "$MAIL" relay-curl-config --message /work/msg
    [ "$status" -eq 2 ] || { echo "no --to: status=$status $output"; return 1; }
    chmod 644 "${GREMION_ROOT}/etc/secrets/mail/relay-password"
    run "$MAIL" relay-curl-config --to probe@example.net --message /work/msg
    [ "$status" -eq 2 ] || { echo "open pw file: status=$status $output"; return 1; }
    [[ "$output" == *"readable by other"* ]]
}
