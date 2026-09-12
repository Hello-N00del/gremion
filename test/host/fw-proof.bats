#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-fw-proof
# Run: bats test/host/fw-proof.bats
#
# Unit level only. docker, nft and getent are shimmed; nothing here opens a
# socket, loads a ruleset or starts a container. The behavioural proof against
# a real host is infra/host/bin/gremion-fw-proof itself, run on the host.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FW_PROOF="${PROJECT_ROOT}/infra/host/bin/gremion-fw-proof"

# --------------------------------------------------------------------------
# canned-answer helpers (files beside $SHIM_LOG, read by the shims below)
# --------------------------------------------------------------------------
nft_answer()    { printf '%s\n' "$2" > "${SHIM_LOG%/*}/nft-$(echo "$1" | tr ' ' '_')"; }
nft_absent()    { rm -f "${SHIM_LOG%/*}/nft-$(echo "$1" | tr ' ' '_')"; }
probe_answer()  { printf '%s\n' "$2" > "${SHIM_LOG%/*}/probe-$1"; }
getent_answer() { printf '%s\n' "$2" > "${SHIM_LOG%/*}/getent-$1"; }
net_exists()    { : > "${SHIM_LOG%/*}/net-$1"; }

install_shims() {
    # Task 3: the whole argument line is joined into $args FIRST. In bash
    # ${*##pat} / ${*#pat} apply the pattern removal to EACH positional
    # parameter and then join, so ${*##* } is the entire command line, not its
    # last word, and ${*#*FW_PROBE=} strips nothing useful. Both silently
    # produced a shim that recorded nothing and answered no probe.
    shim docker '
d="${SHIM_LOG%/*}"
args="$*"
case "$args" in
  "network inspect "*) [ -f "$d/net-$3" ] ;;
  "network create"*)   n="${!#}"; : > "$d/net-$n"; echo "$n" ;;
  "network rm "*)      rm -f "$d/net-$3"; echo "$3" ;;
  *FW_PROBE=*)
      lbl="${args#*FW_PROBE=}"; lbl="${lbl%% *}"
      [ -f "$d/probe-$lbl" ] || exit 1
      cat "$d/probe-$lbl" ;;
  *) exit 1 ;;
esac
'
    shim nft '
d="${SHIM_LOG%/*}"
f="$d/nft-$(echo "$*" | tr " " "_")"
[ -f "$f" ] || exit 1
cat "$f"
'
    shim getent '
d="${SHIM_LOG%/*}"
[ -f "$d/getent-$1" ] || exit 2
cat "$d/getent-$1"
'
}

# A host on which every expectation of spec A section B holds.
green_host() {
    install_shims
    nft_answer "list table inet gremion" "table inet gremion {
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    ip saddr 10.90.9.0/24 tcp dport 25 accept
    ip6 saddr fd5a:99::/64 tcp dport 25 accept
    tcp dport 25 drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat - 1; policy accept;
    ip saddr 10.90.9.0/24 snat to 203.0.113.25
    ip6 saddr fd5a:99::/64 snat to 2001:db8::25
  }
}"
    nft_answer "list table ip nat"  "table ip nat { chain DOCKER { } }"
    nft_answer "list table ip6 nat" "table ip6 nat { chain DOCKER { } }"
    nft_answer "list tables" "table inet gremion
table ip nat
table ip6 nat"
    getent_answer ahostsv4 "198.51.100.25 STREAM mx.example.net"
    getent_answer ahostsv6 "2001:db8:ff::25 STREAM mx.example.net"
    probe_answer reflector-v4-app  "203.0.113.10"
    probe_answer reflector-v4-mail "203.0.113.25"
    probe_answer reflector-v6-app  "2001:db8::a"
    probe_answer reflector-v6-mail "2001:db8::25"
    probe_answer egress25-v4-app  "RC=1
OUT="
    probe_answer egress25-v4-mail "RC=0
OUT=220 mx.example.net ESMTP"
    probe_answer egress25-v6-app  "RC=1
OUT="
    probe_answer egress25-v6-mail "RC=0
OUT=220 mx.example.net ESMTP"
}

setup() {
    setup_host_root
    ENV_FILE="${GREMION_ROOT}/etc/env/state.env"
    cat > "$ENV_FILE" <<'ENVEOF'
STACK=staging
PLATFORM_DOMAIN=example.org
EDGE_BIND_IP=203.0.113.10
EDGE_BIND_IP6=2001:db8::a
MAIL_BIND_IP=203.0.113.25
MAIL_BIND_IP6=2001:db8::25
MAIL_V4_SUBNET=10.90.9.0/24
MAIL_V6_SUBNET=fd5a:99::/64
APP_BLUE_V4_SUBNET=10.90.2.0/24
APP_BLUE_V6_SUBNET=fd5a:92::/64
ENVEOF
}

# Task 3: the four sibling host suites (common, init-secrets, dns-check,
# bootstrap-render) all tear the throwaway root down. Without this every test
# here would leave one mktemp directory behind.
teardown() {
    teardown_host_root
}

# --------------------------------------------------------------------------
# structure and usage
# --------------------------------------------------------------------------

@test "gremion-fw-proof exists and is executable" {
    [ -x "$FW_PROOF" ]
}

@test "gremion-fw-proof runs under strict mode" {
    grep -q 'set -euo pipefail' "$FW_PROOF"
}

@test "--help lists every flag and exits 0" {
    run "$FW_PROOF" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"--scp-smtp-unblocked"* ]]
    [[ "$output" == *"--mail-network"* ]]
    [[ "$output" == *"--families"* ]]
}

@test "an unknown argument exits 2" {
    run "$FW_PROOF" --nope
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown argument: --nope"* ]]
}

@test "a flag without its value exits 2" {
    run "$FW_PROOF" --timeout
    [ "$status" -eq 2 ]
    [[ "$output" == *"--timeout needs a value"* ]]
}

@test "a missing env file exits 2 and names the path" {
    install_shims
    run "$FW_PROOF" --env-file "${GREMION_ROOT}/etc/env/absent.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"env file not found"* ]]
    [[ "$output" == *"absent.env"* ]]
}

@test "an absent table inet gremion exits 2 and names the bootstrap stage" {
    green_host
    nft_absent "list table inet gremion"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 2 ]
    [[ "$output" == *"table inet gremion is absent"* ]]
    [[ "$output" == *"bootstrap.sh firewall"* ]]
}

# --------------------------------------------------------------------------
# the GREEN host
# --------------------------------------------------------------------------

@test "green host: exits 0 and prints the contracted FW-PROOF line" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    [[ "$output" == *"FW-PROOF: egress25-app=refused egress25-mail=allowed snat-mail=203.0.113.25 docker-nat-table=present"* ]]
}

@test "green host: prints the v6 proof line with the mail v6 address" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    [[ "$output" == *"FW-PROOF6: egress25-app=refused egress25-mail=allowed snat-mail=2001:db8::25 docker-nat-table=present"* ]]
}

@test "green host: records the Docker firewall backend for spike S3" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    [[ "$output" == *"docker-fw-backend=iptables-nft"* ]]
    [[ "$output" == *"snat-app=203.0.113.10"* ]]
}

@test "green host: detects the native nftables Docker backend too" {
    green_host
    nft_absent "list table ip nat"
    nft_absent "list table ip6 nat"
    nft_answer "list tables" "table inet gremion
table ip docker-bridges
table ip6 docker-bridges"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    [[ "$output" == *"docker-fw-backend=nftables"* ]]
    [[ "$output" == *"docker-nat-table=present"* ]]
}

@test "--families v4 skips the v6 probes entirely" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked --families v4
    [ "$status" -eq 0 ]
    [[ "$output" == *"FW-PROOF:"* ]]
    [[ "$output" != *"FW-PROOF6:"* ]]
    run assert_recorded docker "FW_PROBE=reflector-v6-mail"
    [ "$status" -ne 0 ]
}

# --------------------------------------------------------------------------
# the RED cases - one broken expectation each
# --------------------------------------------------------------------------

@test "RED: the app network reaching TCP/25 fails with FAIL egress25-app" {
    green_host
    probe_answer egress25-v4-app "RC=0
OUT=220 mx.example.net ESMTP"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"egress25-app(v4)"* ]]
    [[ "$output" == *"the egress-25 drop is not in force"* ]]
    [[ "$output" == *"FW-PROOF: egress25-app=allowed"* ]]
}

@test "RED: the mail subnet unable to reach TCP/25 fails with FAIL egress25-mail" {
    green_host
    probe_answer egress25-v4-mail "RC=1
OUT="
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"egress25-mail(v4)"* ]]
    [[ "$output" == *"provider SMTP block"* ]]
    [[ "$output" == *"egress25-mail=blocked"* ]]
}

@test "RED: mail traffic leaving from the edge address fails with FAIL snat-mail" {
    green_host
    probe_answer reflector-v4-mail "203.0.113.10"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"snat-mail(v4): expected 203.0.113.25, observed 203.0.113.10"* ]]
}

@test "RED: a v6 SNAT mismatch is caught despite a different textual form" {
    green_host
    probe_answer reflector-v6-mail "2001:0db8:0000:0000:0000:0000:0000:0026"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"snat-mail(v6): expected 2001:db8::25"* ]]
}

@test "GREEN: a v6 SNAT match in expanded form is accepted" {
    green_host
    probe_answer reflector-v6-mail "2001:0DB8:0000:0000:0000:0000:0000:0025"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
}

@test "RED: non-mail traffic leaving from the mail address fails with FAIL snat-app" {
    green_host
    probe_answer reflector-v4-app "203.0.113.25"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"snat-app(v4)"* ]]
    [[ "$output" == *"the SNAT rule is too broad"* ]]
}

@test "RED: Docker's nat plumbing gone fails with FAIL docker-nat-table" {
    green_host
    nft_absent "list table ip nat"
    nft_absent "list table ip6 nat"
    nft_answer "list tables" "table inet gremion"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"docker-nat-table"* ]]
    [[ "$output" == *"Docker's plumbing was flushed"* ]]
    [[ "$output" == *"docker-nat-table=absent"* ]]
}

@test "RED: the contract rules missing from the table are named before any probe" {
    green_host
    nft_answer "list table inet gremion" "table inet gremion {
  chain input { type filter hook input priority filter; policy drop; }
}"
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 1 ]
    [[ "$output" == *"rule-text: no tcp dport 25 rule"* ]]
    [[ "$output" == *"rule-text: MAIL_BIND_IP (203.0.113.25) appears in no rule"* ]]
}

@test "no outbound connectivity from a probe network exits 2, not 1" {
    green_host
    probe_answer reflector-v4-app ""
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 2 ]
    [[ "$output" == *"no v4 outbound connectivity"* ]]
    [[ "$output" == *"would be meaningless"* ]]
}

# --------------------------------------------------------------------------
# the blocked state
# --------------------------------------------------------------------------

@test "without --scp-smtp-unblocked the egress-25 half is deferred and the run exits 3" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE"
    [ "$status" -eq 3 ]
    [[ "$output" == *"FW-PROOF: egress25-app=deferred egress25-mail=deferred snat-mail=203.0.113.25 docker-nat-table=present"* ]]
    [[ "$output" == *"BLOCKED: provider SMTP block not declared lifted"* ]]
    run assert_recorded docker "FW_PROBE=egress25-v4-app"
    [ "$status" -ne 0 ]
}

@test "a real failure outranks the blocked state" {
    green_host
    probe_answer reflector-v4-mail "203.0.113.10"
    run "$FW_PROOF" --env-file "$ENV_FILE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"snat-mail(v4)"* ]]
}

# --------------------------------------------------------------------------
# scratch resources
# --------------------------------------------------------------------------

@test "creates the scratch networks with pinned dual-stack subnets" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    assert_recorded docker "network create --driver bridge --ipv6 --subnet 10.90.250.0/24 --subnet fd5a:fa::/64"
    assert_recorded docker "network create --driver bridge --ipv6 --subnet 10.90.9.0/24 --subnet fd5a:99::/64"
}

@test "removes exactly the scratch networks it created" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    assert_recorded docker "network rm gremion-fwproof-app"
    assert_recorded docker "network rm gremion-fwproof-mail"
}

@test "never removes a network it was handed" {
    green_host
    net_exists mail-existing
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked --mail-network mail-existing
    [ "$status" -eq 0 ]
    run assert_recorded docker "network rm mail-existing"
    [ "$status" -ne 0 ]
}

@test "uses the live mail project network when it exists" {
    green_host
    net_exists staging-mail_mail
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked
    [ "$status" -eq 0 ]
    [[ "$output" == *"using the live mail project network staging-mail_mail"* ]]
    run assert_recorded docker "network create --driver bridge --ipv6 --subnet 10.90.9.0/24"
    [ "$status" -ne 0 ]
}

@test "a handed network that does not exist exits 2" {
    green_host
    run "$FW_PROOF" --env-file "$ENV_FILE" --scp-smtp-unblocked --mail-network nosuchnet
    [ "$status" -eq 2 ]
    [[ "$output" == *"--mail-network nosuchnet does not exist"* ]]
}

# --------------------------------------------------------------------------
# fw_expand_v6 (pure function)
# --------------------------------------------------------------------------

@test "fw_expand_v6 expands a compressed address" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 '2001:db8::25'"
    [ "$status" -eq 0 ]
    [ "$output" = "2001:0db8:0000:0000:0000:0000:0000:0025" ]
}

@test "fw_expand_v6 lowercases an already-full address" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 '2001:0DB8:0000:0000:0000:0000:0000:0025'"
    [ "$status" -eq 0 ]
    [ "$output" = "2001:0db8:0000:0000:0000:0000:0000:0025" ]
}

@test "fw_expand_v6 handles a trailing double colon" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 '2001:db8::'"
    [ "$status" -eq 0 ]
    [ "$output" = "2001:0db8:0000:0000:0000:0000:0000:0000" ]
}

@test "fw_expand_v6 handles a leading double colon" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 '::1'"
    [ "$status" -eq 0 ]
    [ "$output" = "0000:0000:0000:0000:0000:0000:0000:0001" ]
}

@test "fw_expand_v6 rejects a v4 address" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 '203.0.113.25'"
    [ "$status" -ne 0 ]
    [ -z "$output" ]
}

@test "fw_expand_v6 rejects a non-hex group" {
    run bash -c "source '$FW_PROOF'; fw_expand_v6 'zzzz::1'"
    [ "$status" -ne 0 ]
}

# --------------------------------------------------------------------------
# house rules
# --------------------------------------------------------------------------

# Task 3: each of these is `run grep` + an explicit status check, never a bare
# `! grep`. Two reasons, both watched:
#   - `! grep -q PAT file` is vacuously TRUE when the file is missing, so the
#     whole block would pass against a program that does not exist; hence the
#     `[ -f ]` first.
#   - in bats a `!`-prefixed command that is NOT the last command of the test
#     body does not fail the test (shellcheck SC2314). The compose guard below
#     has two assertions, and with the bare form the FIRST one was proven to
#     pass against a program that really did name a compose verb.

@test "gremion-fw-proof never flushes the whole ruleset" {
    [ -f "$FW_PROOF" ]
    run grep -n 'flush ruleset' "$FW_PROOF"
    [ "$status" -ne 0 ]
}

@test "gremion-fw-proof never prunes" {
    [ -f "$FW_PROOF" ]
    run grep -nE 'docker (system|volume|image|network|container) prune' "$FW_PROOF"
    [ "$status" -ne 0 ]
}

@test "gremion-fw-proof invokes no compose verb and binds nothing" {
    [ -f "$FW_PROOF" ]
    run grep -n 'docker compose' "$FW_PROOF"
    [ "$status" -ne 0 ]
    run grep -n '0\.0\.0\.0' "$FW_PROOF"
    [ "$status" -ne 0 ]
}

@test "gremion-fw-proof deletes no nft rule" {
    [ -f "$FW_PROOF" ]
    run grep -nE 'nft (delete|add|flush|-f)' "$FW_PROOF"
    [ "$status" -ne 0 ]
}
