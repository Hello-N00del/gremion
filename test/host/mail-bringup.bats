#!/usr/bin/env bats
# Tests for the ${STACK}-mail compose project, its Stalwart config template,
# provision-roles.sh and gremion-mail-bringup (spec A §I, decisions N18/N20).
#
# Every test here is a UNIT test: docker, dig, openssl, curl and
# gremion-dns-check are shimmed by test_helper/host.bash and never touched for
# real. The Docker-backed proof is the INTEGRATION step of Task 8, and the
# on-host proof is §L step 7.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
BRINGUP="${PROJECT_ROOT}/infra/host/bin/gremion-mail-bringup"
PROVISION="${PROJECT_ROOT}/infra/host/mail/provision-roles.sh"
MAIL_COMPOSE="${PROJECT_ROOT}/infra/host/mail/docker-compose.yml"
MAIL_CONFIG_TMPL="${PROJECT_ROOT}/infra/host/mail/config.toml.tmpl"
MAIL_ENV_TMPL="${PROJECT_ROOT}/infra/host/templates/env/mail.env.tmpl"

# Documentation-safe example values only: no host literal may enter the kernel
# tree (test/host/no-host-literals.bats, Task 14).
write_mail_env() {
    mkdir -p "${GREMION_ROOT}/etc/env"
    cat > "${GREMION_ROOT}/etc/env/mail.env" <<EOF
GREMION_ROOT=${GREMION_ROOT}
STACK=staging
COMPOSE_PROJECT_NAME=staging-mail
COMPOSE_FILE=docker-compose.yml
COMPOSE_PROFILES=mail
PLATFORM_DOMAIN=example.org
ACME_EMAIL=hostmaster@example.org
MAIL_BIND_IP=203.0.113.25
MAIL_BIND_IP6=2001:db8::25
EDGE_BIND_IP=203.0.113.10
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
STALWART_ADMIN_PASSWORD=unit-test-admin-password
STALWART_API_KEY=unit-test-api-key
PLATFORM_SMTP_PASSWORD=unit-test-platform-password
ROLES_IMAP_PASSWORD=unit-test-roles-password
MAIL_DNS_RESOLVER=203.0.113.53
KEYCLOAK_PROBE_REALM=platform
KEYCLOAK_PROBE_USER=operator
EOF
}

setup() {
    setup_host_root
    write_mail_env
}

teardown() {
    teardown_host_root
}

# ---------------------------------------------------------------------------
# mail.env.tmpl — the env contract of the ${STACK}-mail project
# ---------------------------------------------------------------------------

@test "mail.env.tmpl sets the mail project's compose identity" {
    grep -Fqx 'COMPOSE_PROJECT_NAME=${STACK}-mail' "$MAIL_ENV_TMPL"
    grep -Fqx 'COMPOSE_FILE=docker-compose.yml' "$MAIL_ENV_TMPL"
    grep -Fqx 'COMPOSE_PROFILES=mail' "$MAIL_ENV_TMPL"
}

@test "mail.env.tmpl pins both images by digest" {
    grep -q '^STALWART_IMAGE=.*@sha256:' "$MAIL_ENV_TMPL"
    grep -q '^PROBE_CURL_IMAGE=.*@sha256:' "$MAIL_ENV_TMPL"
}

@test "mail.env.tmpl publishes both DKIM selectors from day one, spelled A and B" {
    grep -Fqx 'DKIM_SELECTOR_A=g2026a' "$MAIL_ENV_TMPL"
    grep -Fqx 'DKIM_SELECTOR_B=g2026b' "$MAIL_ENV_TMPL"
    # MAIL_HOSTNAME is derived by gremion-mail-bringup, never an env key:
    # two authorities for one name is how the config and the env drift apart.
    run grep -c '^MAIL_HOSTNAME=' "$MAIL_ENV_TMPL"
    [ "$output" = "0" ]
    run grep -cE '^DKIM_SELECTOR_(PRIMARY|SECONDARY)=' "$MAIL_ENV_TMPL"
    [ "$output" = "0" ]
}

@test "mail.env.tmpl carries the edge addresses the ordering guard needs" {
    # gremion-dns-check --edit 1 / --edit 3 both require --edge-ip.
    grep -q '^EDGE_BIND_IP=' "$MAIL_ENV_TMPL"
    grep -q '^EDGE_BIND_IP6=' "$MAIL_ENV_TMPL"
}

@test "every secret key uses Task 1's generator grammar with its own group" {
    # gremion-init-secrets substitutes CHANGE_ME_GEN_<kind>_<group> and nothing
    # else; verify_outputs greps CHANGE_ME_GEN_. A key spelled any other way is
    # never generated, never reported, and load_env then refuses mail.env.
    grep -Fqx 'STALWART_ADMIN_PASSWORD=CHANGE_ME_GEN_alnum32_stalwart_admin' "$MAIL_ENV_TMPL"
    grep -Fqx 'STALWART_API_KEY=CHANGE_ME_GEN_hex32_stalwart_api'            "$MAIL_ENV_TMPL"
    grep -Fqx 'PLATFORM_SMTP_PASSWORD=CHANGE_ME_GEN_alnum32_platform_smtp'   "$MAIL_ENV_TMPL"
    grep -Fqx 'ROLES_IMAP_PASSWORD=CHANGE_ME_GEN_alnum32_roles_imap'         "$MAIL_ENV_TMPL"
}

@test "mail.env.tmpl leaves every operator value as a CHANGE_ME_OPERATOR sentinel" {
    local key
    for key in PLATFORM_DOMAIN ACME_EMAIL MAIL_BIND_IP MAIL_BIND_IP6 EDGE_BIND_IP EDGE_BIND_IP6 KEYCLOAK_PROBE_USER; do
        run grep -E "^${key}=CHANGE_ME_OPERATOR_[a-z0-9_]+$" "$MAIL_ENV_TMPL"
        [ "$status" -eq 0 ] || { echo "${key} is not a CHANGE_ME_OPERATOR_ sentinel"; return 1; }
    done
}

@test "no value line in mail.env.tmpl carries a trailing comment" {
    # load_env exports the whole right-hand side. A trailing "  # marker" would
    # become part of the password.
    run grep -nE '^[A-Z][A-Z0-9_]*=[^#]*[[:space:]]#' "$MAIL_ENV_TMPL"
    [ "$status" -ne 0 ] || { echo "trailing comment on a value line: $output"; return 1; }
}

# ---------------------------------------------------------------------------
# infra/host/mail/docker-compose.yml — project ${STACK}-mail
# ---------------------------------------------------------------------------

@test "mail compose declares exactly one service, stalwart" {
    grep -q '^  stalwart:$' "$MAIL_COMPOSE"
    run bash -c "sed -n '/^services:/,/^networks:/p' '$MAIL_COMPOSE' | grep -cE '^  [a-z][a-z0-9_-]*:$'"
    [ "$output" = "1" ]
}

@test "mail compose pins the image by digest through the env file" {
    grep -q 'image: \${STALWART_IMAGE:?STALWART_IMAGE required}' "$MAIL_COMPOSE"
    ! grep -q '^ *build:' "$MAIL_COMPOSE"
}

@test "no published mail port binds 0.0.0.0" {
    # Every ports entry must start with an explicit bind address.
    # The file must EXIST first: `grep -v` over a missing file also exits
    # non-zero, so without this line the guard is green on an absent compose
    # file — vacuously true, and blind to the very thing it guards.
    [ -f "$MAIL_COMPOSE" ] || { echo "no compose file at ${MAIL_COMPOSE}"; return 1; }
    run bash -c "sed -n '/^ *ports:/,/^ *volumes:/p' '$MAIL_COMPOSE' | grep -E '^ *- \"' | grep -vE '^ *- \"(\\$\{MAIL_BIND_IP\}|\[\\$\{MAIL_BIND_IP6\}\]|127\.0\.0\.1):'"
    [ "$status" -ne 0 ] || { echo "unbound ports: $output"; return 1; }
}

@test "mail compose publishes every §I port on both families" {
    local port
    for port in 25 465 587 993 80 443; do
        grep -q "\${MAIL_BIND_IP}:${port}:${port}" "$MAIL_COMPOSE" \
            || { echo "no v4 binding for ${port}"; return 1; }
        grep -q "\[\${MAIL_BIND_IP6}\]:${port}:${port}" "$MAIL_COMPOSE" \
            || { echo "no v6 binding for ${port}"; return 1; }
    done
}

@test "the management port is published on loopback only" {
    grep -q '127.0.0.1:8086:8080' "$MAIL_COMPOSE"
}

@test "mail data volume is the external stack-scoped volume" {
    # The stack-scoped identity is on name:, not on the mapping key. Compose
    # validates keys against its schema BEFORE interpolating, so a key spelled
    # "${STACK}_mail_data" is rejected outright (v5.5.1:
    # "volumes additional properties '${STACK}_mail_data' not allowed").
    grep -q '^  mail_data:$' "$MAIL_COMPOSE"
    grep -q '^    name: \${STACK}_mail_data$' "$MAIL_COMPOSE"
    run bash -c "sed -n '/^volumes:/,\$p' '$MAIL_COMPOSE' | grep -c 'external: true'"
    [ "$output" = "1" ]
}

@test "the mail network is project-scoped, dual-stack and pinned" {
    grep -q '^  mail:$' "$MAIL_COMPOSE"
    grep -q 'enable_ipv6: true' "$MAIL_COMPOSE"
    grep -q 'subnet: \${MAIL_V4_SUBNET}' "$MAIL_COMPOSE"
    grep -q 'subnet: \${MAIL_V6_SUBNET}' "$MAIL_COMPOSE"
    # a project-scoped network must carry no name: (§E)
    run bash -c "sed -n '/^networks:/,/^volumes:/p' '$MAIL_COMPOSE' | grep -E '^ +name:'"
    [ "$status" -ne 0 ]
}

@test "the stalwart service has a healthcheck on the management port" {
    grep -q 'healthcheck:' "$MAIL_COMPOSE"
    grep -q '127.0.0.1:8080/healthz/live' "$MAIL_COMPOSE"
}

@test "container logs are bounded by MAIL_LOG_RETENTION_DAYS" {
    grep -q 'max-file: "\${MAIL_LOG_RETENTION_DAYS}"' "$MAIL_COMPOSE"
}

# ---------------------------------------------------------------------------
# infra/host/mail/config.toml.tmpl — Stalwart configuration
# ---------------------------------------------------------------------------

@test "config template declares every §I listener" {
    local l
    for l in smtp submission submissions imaptls http https management; do
        grep -q "^\[server.listener.${l}\]$" "$MAIL_CONFIG_TMPL" \
            || { echo "missing listener ${l}"; return 1; }
    done
}

@test "config template runs ACME on IP-B for the four mail hostnames" {
    grep -q 'challenge = "http-01"' "$MAIL_CONFIG_TMPL"
    grep -q '"mta-sts.\${PLATFORM_DOMAIN}"' "$MAIL_CONFIG_TMPL"
    grep -q '"autoconfig.\${PLATFORM_DOMAIN}"' "$MAIL_CONFIG_TMPL"
    grep -q '"autodiscover.\${PLATFORM_DOMAIN}"' "$MAIL_CONFIG_TMPL"
}

@test "config template signs with both DKIM selectors" {
    grep -q '^\[signature."\${DKIM_SELECTOR_A}"\]$' "$MAIL_CONFIG_TMPL"
    grep -q '^\[signature."\${DKIM_SELECTOR_B}"\]$' "$MAIL_CONFIG_TMPL"
    grep -q 'canonicalization = "relaxed/relaxed"' "$MAIL_CONFIG_TMPL"
}

@test "config template refuses relay without AUTH (§I assert 4)" {
    grep -q 'relay = \[ { if = "!is_empty(authenticated_as)", then = true }' "$MAIL_CONFIG_TMPL"
}

@test "config template never offers AUTH on port 25 and never in the clear" {
    grep -q 'allow-plain-text = false' "$MAIL_CONFIG_TMPL"
    grep -q "require = \[ { if = \"listener != 'smtp'\", then = true }" "$MAIL_CONFIG_TMPL"
}

@test "config template exempts abuse@ and postmaster@ from spam filtering" {
    grep -q "rcpt == 'abuse@\${PLATFORM_DOMAIN}'" "$MAIL_CONFIG_TMPL"
    grep -q "rcpt == 'postmaster@\${PLATFORM_DOMAIN}'" "$MAIL_CONFIG_TMPL"
}

@test "config template serves an MTA-STS policy in testing mode" {
    grep -q '^\[mta-sts\]$' "$MAIL_CONFIG_TMPL"
    grep -q '^mode = "testing"$' "$MAIL_CONFIG_TMPL"
}

@test "config template uses only Stalwart macros for in-container paths" {
    # Anything that must survive rendering has to be a %{...}% macro, not ${...}
    grep -q '%{env:STALWART_PATH}%/data' "$MAIL_CONFIG_TMPL"
}

# ---------------------------------------------------------------------------
# gremion-mail-bringup --render-config
# ---------------------------------------------------------------------------

@test "--render-config writes a config with no unsubstituted variables" {
    run "$BRINGUP" --render-config
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -s "${GREMION_ROOT}/etc/mail/config.toml" ]
    run grep -c '\${' "${GREMION_ROOT}/etc/mail/config.toml"
    [ "$output" = "0" ]
}

@test "--render-config substitutes the derived mail hostname" {
    run "$BRINGUP" --render-config
    [ "$status" -eq 0 ]
    grep -q '^hostname = "mail.example.org"$' "${GREMION_ROOT}/etc/mail/config.toml"
    grep -q '"mta-sts.example.org"' "${GREMION_ROOT}/etc/mail/config.toml"
}

@test "--render-config keeps Stalwart's own macros intact" {
    run "$BRINGUP" --render-config
    grep -q '%{env:STALWART_PATH}%/data' "${GREMION_ROOT}/etc/mail/config.toml"
    grep -q '%{file:/opt/stalwart/etc/dkim/g2026a.private}%' "${GREMION_ROOT}/etc/mail/config.toml"
}

@test "--render-config records the MTA-STS policy id it rendered" {
    run "$BRINGUP" --render-config
    [ "$status" -eq 0 ]
    run cat "${GREMION_ROOT}/runtime/mta-sts-id"
    [ -n "$output" ]
    [[ "$output" =~ ^[0-9]{14}$ ]]
}

@test "--render-config exits 2 when a required config variable is empty" {
    sed -i 's/^ACME_EMAIL=.*/ACME_EMAIL=/' "${GREMION_ROOT}/etc/env/mail.env"
    run "$BRINGUP" --render-config
    [ "$status" -eq 2 ]
    [[ "$output" == *"ACME_EMAIL"* ]]
}

# ---------------------------------------------------------------------------
# The N18 ordering guard: no assert 2-6 while the send-nothing lock is absent
# ---------------------------------------------------------------------------

# gremion-dns-check is shimmed. Its contract (Task 7) is one line per record,
#   OK|MISSING|WRONG <edit> <name> <type> '<expected>' '<observed>'
# with the expected and observed fields SINGLE-QUOTED, and exit 1 if any
# expected record for the requested edit is MISSING or WRONG. These shims emit
# exactly what Task 7 prints — a shim that reformats the contract it stands in
# for would make the guard green here and dead on the host.
shim_dns_check_ok() {
    shim gremion-dns-check '
case " $* " in
  *" --edit 1 "*)
      echo "OK 1 example.org MX '"'"'0 .'"'"' '"'"'0 .'"'"'"
      echo "OK 1 example.org CAA '"'"'0 issue \"letsencrypt.org\"'"'"' '"'"'0 issue \"letsencrypt.org\"'"'"'"
      exit 0 ;;
  *" --edit 3 "*)
      echo "OK 3 mail.example.org A '"'"'203.0.113.25'"'"' '"'"'203.0.113.25'"'"'"
      exit 0 ;;
esac
exit 0'
}

shim_dns_check_no_null_mx() {
    shim gremion-dns-check '
case " $* " in
  *" --edit 1 "*)
      echo "MISSING 1 example.org MX '"'"'0 .'"'"' '"'"'10 mail.example.org.'"'"'"
      exit 1 ;;
  *" --edit 3 "*)
      echo "OK 3 mail.example.org A '"'"'203.0.113.25'"'"' '"'"'203.0.113.25'"'"'"
      exit 0 ;;
esac
exit 0'
}

@test "assert 2 is refused while the edit-1 null MX is gone (N18)" {
    shim_dns_check_no_null_mx
    run "$BRINGUP" --assert 2
    [ "$status" -eq 2 ]
    [[ "$output" == *"null MX"* ]]
}

@test "assert 1 does not need the ordering guard" {
    # FCrDNS is the precondition of the port unblock, so it runs before the
    # lock can be checked at all.
    shim_dns_check_no_null_mx
    shim dig 'case "$*" in
      *" A mail.example.org"*)    echo 203.0.113.25 ;;
      *" AAAA mail.example.org"*) echo 2001:db8::25 ;;
      *"-x 203.0.113.25"*)        echo mail.example.org. ;;
      *"-x 2001:db8::25"*)        echo mail.example.org. ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 1
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"MAIL-BRINGUP: 1=ok"* ]]
}

@test "the ordering guard records which gremion-dns-check edits it ran" {
    shim_dns_check_ok
    shim dig 'exit 0'
    shim openssl 'exit 0'
    run "$BRINGUP" --assert 2
    assert_recorded gremion-dns-check "--edit 1"
    assert_recorded gremion-dns-check "--edit 3"
}

# ---------------------------------------------------------------------------
# Asserts 1-3: FCrDNS, TLS on every mail port, DKIM
# ---------------------------------------------------------------------------

# A self-signed cert used by the openssl shim so the SAN and notAfter arms
# exercise real parsing.
make_probe_cert() {   # <days> [CN]
    local days="${1:-400}" cn="${2:-mail.example.org}"
    openssl req -x509 -newkey rsa:2048 -nodes -days "$days" \
        -keyout "${GREMION_ROOT}/probe.key" -out "${GREMION_ROOT}/probe.pem" \
        -subj "/CN=${cn}" -addext "subjectAltName=DNS:${cn}" 2>/dev/null
}

shim_openssl_cert() {
    # s_client emits the PEM; every other openssl verb is the real binary.
    shim openssl "
if [ \"\$1\" = s_client ]; then cat '${GREMION_ROOT}/probe.pem'; exit 0; fi
exec $(command -v openssl) \"\$@\""
}

@test "DNS_CHECK from the environment overrides the resolved gremion-dns-check" {
    # Regression: DNS_CHECK is the documented override resolve_dns_check honours
    # first, and it was being blanked at declaration — so a caller that named
    # its own checker silently got the real one. Found by driving the program
    # against a live container, where the real checker then queried the public
    # zone and refused the run.
    cat > "${GREMION_ROOT}/my-dns-check" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${GREMION_ROOT}/my-dns-check.log"
echo "OK 1 example.org MX '0 .' '0 .'"
exit 0
EOF
    chmod +x "${GREMION_ROOT}/my-dns-check"
    shim gremion-dns-check 'echo "the resolved checker must not run"; exit 1'
    shim dig 'exit 0'
    shim openssl 'exit 0'
    export DNS_CHECK="${GREMION_ROOT}/my-dns-check"
    run "$BRINGUP" --assert 2
    # Observed on what each program was actually asked to do, not on stdout:
    # the guard prints the checker's report only when it refuses.
    refute_recorded gremion-dns-check "--edit 1"
    grep -q -- '--edit 1' "${GREMION_ROOT}/my-dns-check.log" \
        || { echo "the named checker was never called"; return 1; }
    grep -q -- '--edit 3' "${GREMION_ROOT}/my-dns-check.log" \
        || { echo "the named checker was not called for edit 3"; return 1; }
}

@test "assert 1 passes when both families resolve and both PTRs match" {
    shim_dns_check_ok
    shim dig 'case "$*" in
      *" A mail.example.org"*)    echo 203.0.113.25 ;;
      *" AAAA mail.example.org"*) echo 2001:db8::25 ;;
      *"-x 203.0.113.25"*)        echo mail.example.org. ;;
      *"-x 2001:db8::25"*)        echo mail.example.org. ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 1
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"MAIL-BRINGUP: 1=ok"* ]]
}

@test "assert 1 fails when the v6 PTR is missing" {
    shim_dns_check_ok
    shim dig 'case "$*" in
      *" A mail.example.org"*)    echo 203.0.113.25 ;;
      *" AAAA mail.example.org"*) echo 2001:db8::25 ;;
      *"-x 203.0.113.25"*)        echo mail.example.org. ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 1
    [ "$status" -eq 1 ]
    [[ "$output" == *"PTR 2001:db8::25"* ]]
    [[ "$output" == *"MAIL-BRINGUP: 1=FAIL"* ]]
    [[ "$output" == *"MX-PUBLICATION: HOLD"* ]]
}

@test "assert 2 accepts a cert with a matching SAN and > 20 days left" {
    make_probe_cert 400
    shim_dns_check_ok
    shim_openssl_cert
    run "$BRINGUP" --assert 2
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"MAIL-BRINGUP: 1=skipped 2=ok"* ]]
}

@test "assert 2 probes all four TLS ports" {
    make_probe_cert 400
    shim_dns_check_ok
    shim_openssl_cert
    run "$BRINGUP" --assert 2
    assert_recorded openssl "mail.example.org:25"
    assert_recorded openssl "mail.example.org:465"
    assert_recorded openssl "mail.example.org:587"
    assert_recorded openssl "mail.example.org:993"
}

@test "assert 2 fails a certificate inside the 20-day window" {
    make_probe_cert 10
    shim_dns_check_ok
    shim_openssl_cert
    run "$BRINGUP" --assert 2
    [ "$status" -eq 1 ]
    [[ "$output" == *"expires in"* ]]
}

@test "assert 2 fails a certificate whose SAN is a different host" {
    make_probe_cert 400 other.example.org
    shim_dns_check_ok
    shim_openssl_cert
    run "$BRINGUP" --assert 2
    [ "$status" -eq 1 ]
    [[ "$output" == *"SAN does not contain mail.example.org"* ]]
}

@test "assert 3 fails when the published DKIM key is not the host's key" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/etc/secrets/mail"
    openssl genrsa -out "${GREMION_ROOT}/etc/secrets/mail/g2026a.private" 2048 2>/dev/null
    shim dig 'case "$*" in
      *"TXT g2026a._domainkey.example.org"*) echo "\"v=DKIM1; k=rsa; p=AAAAB3NzaC1yc2E\"" ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 3
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not match"* ]]
}

@test "assert 3 accepts the published key and verifies the body hash" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/etc/secrets/mail"
    openssl genrsa -out "${GREMION_ROOT}/etc/secrets/mail/g2026a.private" 2048 2>/dev/null
    local pub
    pub="$(openssl rsa -in "${GREMION_ROOT}/etc/secrets/mail/g2026a.private" \
           -pubout -outform DER 2>/dev/null | openssl base64 -A)"
    shim dig "case \"\$*\" in
      *\"TXT g2026a._domainkey.example.org\"*) echo '\"v=DKIM1; k=rsa; p=${pub}\"' ;;
    esac
    exit 0"
    # curl returns the round-tripped probe message, signed by the running
    # server: the same body we sent, with a DKIM-Signature whose bh= is the
    # relaxed body hash.
    local body_hash
    body_hash="$(printf 'This message proves the host'"'"'s DKIM signature against the published key.\n' \
        | awk '{ sub(/[ \t\r]+$/, ""); gsub(/[ \t]+/, " "); l[NR]=$0 }
               END { n=NR; while (n>0 && l[n]=="") n--; for (i=1;i<=n;i++) printf "%s\r\n", l[i] }' \
        | openssl dgst -sha256 -binary | openssl base64 -A)"
    shim curl "
case \"\$*\" in
  *SEARCH*) echo '* SEARCH 7' ;;
  *UID=7*)  printf 'DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=g2026a; bh=${body_hash}; b=xx\r\nSubject: probe\r\n\r\n' ;;
esac
exit 0"
    run "$BRINGUP" --assert 3
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"3=ok"* ]]
}

# ---------------------------------------------------------------------------
# Asserts 4-6: open relay, MTA-STS, external delivery, Keycloak
# ---------------------------------------------------------------------------

@test "assert 4 passes when the external->external RCPT is answered 5xx" {
    shim_dns_check_ok
    shim openssl 'printf "220 mail.example.org ESMTP\r\n250-mail.example.org\r\n250 OK\r\n550 5.7.1 relaying denied\r\n221 Bye\r\n"; exit 0'
    run "$BRINGUP" --assert 4
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"4=ok"* ]]
}

@test "assert 4 fails when the server accepts the relay" {
    shim_dns_check_ok
    shim openssl 'printf "220 mail.example.org ESMTP\r\n250-mail.example.org\r\n250 OK\r\n250 Accepted\r\n221 Bye\r\n"; exit 0'
    run "$BRINGUP" --assert 4
    [ "$status" -eq 1 ]
    [[ "$output" == *"relays without AUTH"* ]]
}

@test "assert 5 passes when the policy is text/plain and the TXT id matches" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/runtime"
    echo "20260909120000" > "${GREMION_ROOT}/runtime/mta-sts-id"
    shim curl 'while [ "$#" -gt 0 ]; do case "$1" in -D) printf "HTTP/2 200\r\ncontent-type: text/plain\r\n" > "$2"; shift 2 ;; *) shift ;; esac; done
printf "version: STSv1\nmode: testing\nmx: mail.example.org\nmax_age: 604800\n"
exit 0'
    shim dig 'case "$*" in
      *"TXT _mta-sts.example.org"*) echo "\"v=STSv1; id=20260909120000\"" ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 5
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"5=ok"* ]]
}

@test "assert 5 fails when the published id is stale" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/runtime"
    echo "20260909120000" > "${GREMION_ROOT}/runtime/mta-sts-id"
    shim curl 'while [ "$#" -gt 0 ]; do case "$1" in -D) printf "HTTP/2 200\r\ncontent-type: text/plain\r\n" > "$2"; shift 2 ;; *) shift ;; esac; done
printf "version: STSv1\nmode: testing\nmx: mail.example.org\nmax_age: 604800\n"
exit 0'
    shim dig 'case "$*" in
      *"TXT _mta-sts.example.org"*) echo "\"v=STSv1; id=20250101000000\"" ;;
    esac
    exit 0'
    run "$BRINGUP" --assert 5
    [ "$status" -eq 1 ]
    [[ "$output" == *"20250101000000"* ]]
}

@test "assert 6a refuses to run without --external-to" {
    shim_dns_check_ok
    run "$BRINGUP" --assert 6a
    [ "$status" -eq 2 ]
    [[ "$output" == *"--external-to"* ]]
}

@test "assert 6a requires an app-tier network to send from" {
    shim_dns_check_ok
    shim docker 'exit 1'
    run "$BRINGUP" --assert 6a --external-to probe@example.net
    [ "$status" -eq 2 ]
    [[ "$output" == *"staging-app-blue_app"* ]]
}

@test "assert 6a sends from an app-subnet container and then blocks on the header" {
    shim_dns_check_ok
    shim docker 'exit 0'
    run "$BRINGUP" --assert 6a --external-to probe@example.net
    [ "$status" -eq 3 ]
    assert_recorded docker "--network staging-app-blue_app"
    [[ "$output" == *"6a=BLOCKED"* ]]
    [[ "$output" == *"MX-PUBLICATION: HOLD"* ]]
}

@test "assert 6a passes when the pasted header shows all three verdicts and IP-B" {
    shim_dns_check_ok
    shim docker 'exit 0'
    cat > "${GREMION_ROOT}/results.txt" <<'EOF'
Authentication-Results: mx.example.net; dkim=pass header.d=example.org; spf=pass smtp.mailfrom=example.org; dmarc=pass header.from=example.org
Received: from mail.example.org (mail.example.org. [203.0.113.25]) by mx.example.net
EOF
    run "$BRINGUP" --assert 6a --external-to probe@example.net --results-file "${GREMION_ROOT}/results.txt"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"6a=ok"* ]]
}

@test "assert 6a fails when the delivering source is not IP-B" {
    shim_dns_check_ok
    shim docker 'exit 0'
    cat > "${GREMION_ROOT}/results.txt" <<'EOF'
Authentication-Results: mx.example.net; dkim=pass; spf=pass; dmarc=pass
Received: from mail.example.org (mail.example.org. [203.0.113.10]) by mx.example.net
EOF
    run "$BRINGUP" --assert 6a --external-to probe@example.net --results-file "${GREMION_ROOT}/results.txt"
    [ "$status" -eq 1 ]
    [[ "$output" == *"203.0.113.25"* ]]
}

@test "assert 6b is BLOCKED while the realm export has no smtpServer (spec B)" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/current/docker/keycloak"
    echo '{"realm":"platform"}' > "${GREMION_ROOT}/current/docker/keycloak/realm-export.base.json"
    run "$BRINGUP" --assert 6b
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED: keycloak realm export has no smtpServer block (spec B, gremion#6)"* ]]
    [[ "$output" == *"6b=BLOCKED"* ]]
}

@test "MX-PUBLICATION stays HOLD while any assert is not ok" {
    # The one guard that, if it lied, would publish the MX before the box is
    # provably safe. Drilled RED in Step 19.
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/current/docker/keycloak"
    echo '{"realm":"platform"}' > "${GREMION_ROOT}/current/docker/keycloak/realm-export.base.json"
    run "$BRINGUP" --assert 6b
    [[ "$output" == *"MX-PUBLICATION: HOLD"* ]]
    [[ "$output" != *"MX-PUBLICATION: GO"* ]]
}

@test "the summary line has the §I shape when every assert has run" {
    shim_dns_check_ok
    mkdir -p "${GREMION_ROOT}/current/docker/keycloak"
    echo '{"realm":"platform"}' > "${GREMION_ROOT}/current/docker/keycloak/realm-export.base.json"
    shim dig 'exit 0'; shim openssl 'exit 0'; shim curl 'exit 1'; shim docker 'exit 0'
    run "$BRINGUP" --assert all --external-to probe@example.net
    [[ "$output" =~ MAIL-BRINGUP:\ 1=[a-zA-Z]+\ 2=[a-zA-Z]+\ 3=[a-zA-Z]+\ 4=[a-zA-Z]+\ 5=[a-zA-Z]+\ 6a=[a-zA-Z]+\ 6b=[a-zA-Z]+ ]]
}

# ---------------------------------------------------------------------------
# infra/host/mail/provision-roles.sh
# ---------------------------------------------------------------------------

# A curl shim that plays the Stalwart management API. State lives in files
# under $GREMION_ROOT/api so the second run of provision-roles.sh sees what the
# first one created — that is what proves idempotency.
#
# It models the contract the REAL build has, observed in Task 8's integration
# step: every call answers HTTP 200 and the verdict is in the BODY — {"data":…}
# on success, {"error":"notFound","item":"…"} otherwise — and a mailbox whose
# DOMAIN is not yet a principal is refused that same way. A shim that returned
# 404 for a missing principal, the way a well-behaved REST API would, made the
# script green here and broken on the first real host.
shim_stalwart_api() {
    local supports_networks="${1:-no}"
    mkdir -p "${GREMION_ROOT}/api"
    echo "$supports_networks" > "${GREMION_ROOT}/api/supports_networks"
    shim curl '
API="'"${GREMION_ROOT}"'/api"
out=/dev/null; method=GET; path=""; body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    --data-binary) body="$2"; shift 2 ;;
    http*) path="${1#*8086}"; shift ;;
    *) shift ;;
  esac
done
name="${path#/api/principal/}"
notfound() { printf "{\"error\":\"notFound\",\"item\":\"%s\"}" "$1" > "$out"; exit 0; }
case "$method:$path" in
  GET:/api/principal) printf "{\"data\":{\"items\":[],\"total\":0}}" > "$out"; exit 0 ;;
esac
case "$method" in
  GET)
    if [ -f "$API/$name.json" ]; then cp "$API/$name.json" "$out"; else notfound "$name"; fi ;;
  POST)
    n=$(printf "%s" "$body" | sed -n "s/.*\"name\":\"\([^\"]*\)\".*/\1/p")
    t=$(printf "%s" "$body" | sed -n "s/.*\"type\":\"\([^\"]*\)\".*/\1/p")
    e=$(printf "%s" "$body" | sed -n "s/.*\"emails\":\[\"\([^\"]*\)\".*/\1/p")
    if [ "$t" = domain ]; then
      printf "{\"data\":{\"name\":\"%s\",\"type\":\"domain\"}}" "$n" > "$API/$n.json"
      printf "{\"data\":1}" > "$out"; exit 0
    fi
    dom="${e#*@}"
    if [ ! -f "$API/$dom.json" ]; then notfound "$dom"; fi
    if [ "$(cat "$API/supports_networks")" = yes ]; then
      printf "{\"data\":{\"name\":\"%s\",\"emails\":[\"%s\"],\"secrets\":[],\"allowedNetworks\":[]}}" "$n" "$e" > "$API/$n.json"
    else
      printf "{\"data\":{\"name\":\"%s\",\"emails\":[\"%s\"],\"secrets\":[]}}" "$n" "$e" > "$API/$n.json"
    fi
    printf "{\"data\":2}" > "$out" ;;
  PATCH)
    if [ ! -f "$API/$name.json" ]; then notfound "$name"; fi
    f=$(printf "%s" "$body" | sed -n "s/.*\"field\":\"\([^\"]*\)\".*/\1/p")
    v=$(printf "%s" "$body" | sed -n "s/.*\"value\":\"\([^\"]*\)\".*/\1/p")
    tmp=$(mktemp)
    jq --arg f "$f" --arg v "$v" ".data[\$f] += [\$v]" "$API/$name.json" > "$tmp" && mv "$tmp" "$API/$name.json"
    printf "{\"data\":null}" > "$out" ;;
esac
exit 0'
}

@test "provision-roles.sh creates the platform domain before any mailbox" {
    # The pinned build refuses a mailbox whose domain it does not know, and says
    # so with HTTP 200 plus {"error":"notFound","item":"<domain>"} — so the
    # status code is not the post-condition and the ordering is not optional.
    # Observed against a running Stalwart in the Task 8 integration step.
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -f "${GREMION_ROOT}/api/example.org.json" ] \
        || { echo "the platform domain principal was never created"; return 1; }
    local first_post
    first_post="$(grep -F -- '-X POST' "$SHIM_LOG" | sed -n '1p')"
    [[ "$first_post" == *'"type":"domain"'* ]] \
        || { echo "the first principal created was not the domain: ${first_post}"; return 1; }
}

@test "provision-roles.sh creates the roles and platform principals" {
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -f "${GREMION_ROOT}/api/roles.json" ]
    [ -f "${GREMION_ROOT}/api/platform.json" ]
}

@test "provision-roles.sh creates all thirteen §I role addresses" {
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ]
    local r
    for r in security abuse postmaster hostmaster hello signups no-reply \
             notifications newsletter bounces dmarc-reports tls-reports datenschutz; do
        run jq -e --arg a "${r}@example.org" '.data.emails | index($a)' "${GREMION_ROOT}/api/roles.json"
        [ "$status" -eq 0 ] || { echo "missing alias ${r}@example.org"; return 1; }
    done
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [[ "$output" == *"MAIL-ROLES: aliases=13"* ]]
}

@test "provision-roles.sh is idempotent: a second run adds nothing" {
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ]
    local before after
    before="$(jq -c '.data.emails' "${GREMION_ROOT}/api/roles.json")"
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ]
    after="$(jq -c '.data.emails' "${GREMION_ROOT}/api/roles.json")"
    [ "$before" = "$after" ]
    [[ "$output" == *"already present"* ]]
}

@test "provision-roles.sh sets the platform app password" {
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    run jq -e '.data.secrets | map(select(startswith("$app$"))) | length == 1' "${GREMION_ROOT}/api/platform.json"
    [ "$status" -eq 0 ]
}

@test "provision-roles.sh source-restricts the app password to the app subnets" {
    shim_stalwart_api yes
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 0 ]
    run jq -e '.data.allowedNetworks | index("10.90.2.0/24")' "${GREMION_ROOT}/api/platform.json"
    [ "$status" -eq 0 ]
    run jq -e '.data.allowedNetworks | index("10.90.3.0/24")' "${GREMION_ROOT}/api/platform.json"
    [ "$status" -eq 0 ]
}

@test "provision-roles.sh exits 3 when the build cannot source-restrict" {
    shim_stalwart_api no
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env"
    [ "$status" -eq 3 ]
    [[ "$output" == *"BLOCKED:"* ]]
    [[ "$output" == *"source restriction"* ]]
}

@test "--allow-unrestricted turns the block into a named residual" {
    shim_stalwart_api no
    run "$PROVISION" --env "${GREMION_ROOT}/etc/env/mail.env" --allow-unrestricted
    [ "$status" -eq 0 ]
    [[ "$output" == *"source-restriction=residual"* ]]
}
