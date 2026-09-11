#!/usr/bin/env bats
# Tests for infra/host/bin/gremion-dns-check
# Run: bats test/host/dns-check.bats
#
# No test here touches a real resolver: dig is shimmed and answers from a
# zone fixture file. The live-DNS proof is the integration step of Task 7.

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
DNS_CHECK="${PROJECT_ROOT}/infra/host/bin/gremion-dns-check"

# Documentation-range values only (RFC 5737 / RFC 3849 / RFC 2606).
D=example.org
EDGE4=203.0.113.10
EDGE6=2001:db8::a
MAIL4=203.0.113.25
MAIL6=2001:db8::25

setup() {
    setup_host_root
    TEST_ZONE="${GREMION_ROOT}/zone.txt"
    export TEST_ZONE
    : >"$TEST_ZONE"
    install_dig_shim
}

# --- fixture helpers -----------------------------------------------------

# A stand-in for dig(1) that answers from $TEST_ZONE. Fixture lines are
# "<name>|<type>|<value>"; several lines per key are several answers; an
# unknown key prints nothing and exits 0, exactly as `dig +short` does for
# NXDOMAIN.
install_dig_shim() {
    cat >"${GREMION_ROOT}/dig-shim.sh" <<'SHIM'
args=("$@")
last=$(( ${#args[@]} - 1 ))
if [ "$last" -ge 1 ] && [ "${args[$(( last - 1 ))]}" = "-x" ]; then
    q_name="${args[$last]}"
    q_type="PTR"
else
    q_name="${args[$(( last - 1 ))]}"
    q_type="${args[$last]}"
fi
awk -F'|' -v n="$q_name" -v t="$q_type" '$1 == n && $2 == t { print $3 }' "$TEST_ZONE"
SHIM
    shim dig '. "$GREMION_ROOT/dig-shim.sh"'
}

zone() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$TEST_ZONE"; }

zone_delete() {
    grep -v "^$1|$2|" "$TEST_ZONE" >"${TEST_ZONE}.next" || true
    mv "${TEST_ZONE}.next" "$TEST_ZONE"
}

dns_check() {
    run "$DNS_CHECK" --domain "$D" --edge-ip "$EDGE4" --edge-ip6 "$EDGE6" \
        --mail-ip "$MAIL4" --mail-ip6 "$MAIL6" "$@"
}

assert_row() {
    if ! printf '%s\n' "$output" | grep -qF -- "$1"; then
        echo "FAIL: no row matching: $1" >&2
        printf '%s\n' "$output" >&2
        return 1
    fi
}

refute_row() {
    if printf '%s\n' "$output" | grep -qF -- "$1"; then
        echo "FAIL: unexpected row: $1" >&2
        printf '%s\n' "$output" >&2
        return 1
    fi
}

# --- structure -----------------------------------------------------------

@test "gremion-dns-check exists" {
    [ -f "$DNS_CHECK" ]
}

@test "gremion-dns-check is executable" {
    [ -x "$DNS_CHECK" ]
}

@test "gremion-dns-check runs under strict mode" {
    grep -q 'set -euo pipefail' "$DNS_CHECK"
}

@test "gremion-dns-check declares dig as a precondition" {
    grep -q 'need_cmd dig' "$DNS_CHECK"
}

@test "gremion-dns-check carries a bare shellcheck source directive" {
    # Task 14 Step 8's guard requires exactly this form: 'source=' alone,
    # on its own line, never combined with 'disable=SC1091'.
    grep -qx '# shellcheck source=../lib/common.sh' "$DNS_CHECK"
}

# --- usage and preconditions (exit 2) ------------------------------------

@test "exits 2 without --domain" {
    run "$DNS_CHECK" --edge-ip "$EDGE4" --mail-ip "$MAIL4" --edit 1
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q -- '--domain is required'
}

@test "exits 2 without --edge-ip" {
    run "$DNS_CHECK" --domain "$D" --mail-ip "$MAIL4" --edit 1
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q -- '--edge-ip is required'
}

@test "exits 2 without --mail-ip" {
    run "$DNS_CHECK" --domain "$D" --edge-ip "$EDGE4" --edit 1
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q -- '--mail-ip is required'
}

@test "exits 2 on an unknown --edit value" {
    dns_check --edit 5
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q 'unknown --edit value: 5'
}

@test "exits 2 on an unknown option" {
    dns_check --nope
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q 'unknown option: --nope'
}

@test "exits 2 when --tenant-hosts names a missing file" {
    dns_check --edit 2 --tenant-hosts "${GREMION_ROOT}/no-such-file.txt"
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" | grep -q 'tenant-hosts file not found'
}

# --- pure helpers --------------------------------------------------------

@test "expand_ip6 expands a compressed, upper-case address" {
    # shellcheck disable=SC1090
    source "$DNS_CHECK"
    [ "$(expand_ip6 '2001:DB8::A')" = "2001:0db8:0000:0000:0000:0000:0000:000a" ]
}

@test "expand_ip6 is idempotent on an already-expanded address" {
    # shellcheck disable=SC1090
    source "$DNS_CHECK"
    local full="2001:0db8:0000:0000:0000:0000:0000:0025"
    [ "$(expand_ip6 "$full")" = "$full" ]
}

@test "expand_ip6 handles a trailing and a leading ::" {
    # shellcheck disable=SC1090
    source "$DNS_CHECK"
    [ "$(expand_ip6 '2001:db8::')" = "2001:0db8:0000:0000:0000:0000:0000:0000" ]
    [ "$(expand_ip6 '::1')" = "0000:0000:0000:0000:0000:0000:0000:0001" ]
}

@test "expand_ip6 passes a non-address through unchanged" {
    # shellcheck disable=SC1090
    source "$DNS_CHECK"
    [ "$(expand_ip6 'mail.example.org.')" = "mail.example.org." ]
}

@test "normalise_txt joins split chunks, drops quotes and closes '; '" {
    # shellcheck disable=SC1090
    source "$DNS_CHECK"
    [ "$(normalise_txt '"v=DKIM1; k=rsa; p=AAAA" "BBBB"')" = "v=DKIM1;k=rsa;p=AAAABBBB" ]
    [ "$(normalise_txt '"v=spf1 -all"')" = "v=spf1 -all" ]
}

# --- zone seeds ----------------------------------------------------------

seed_caa() {
    zone "$D" CAA '0 issue "letsencrypt.org"'
    zone "$D" CAA '0 issuewild ";"'
    zone "$D" CAA "0 iodef \"mailto:security@${D}\""
}

seed_edit1() {
    seed_caa
    zone "$D" MX '0 .'
    zone "$D" TXT '"v=spf1 -all"'
    zone "_dmarc.${D}" TXT '"v=DMARC1; p=reject; rua=mailto:postmaster@example.net"'
}

# --- edit 1 --------------------------------------------------------------

@test "--edit 1 reports OK for a complete send-nothing lock" {
    seed_edit1
    dns_check --edit 1
    [ "$status" -eq 0 ]
    assert_row "OK 1 ${D} CAA '0 issue \"letsencrypt.org\"'"
    assert_row "OK 1 ${D} CAA '0 issuewild \";\"'"
    assert_row "OK 1 ${D} CAA '0 iodef \"mailto:security@${D}\"'"
    assert_row "OK 1 ${D} MX '0 .' '0 .'"
    assert_row "OK 1 ${D} TXT 'v=spf1 -all' 'v=spf1 -all'"
    assert_row "OK 1 _dmarc.${D} TXT ';p=reject'"
    assert_row "DNS-CHECK: edit=1 checked=7 ok=7 missing=0 wrong=0"
}

@test "the null-MX row is spelled exactly as Task 8's ordering guard greps it" {
    # gremion-mail-bringup's require_send_nothing_lock greps
    #   ^OK 1 ${PLATFORM_DOMAIN}\.? MX '0 \.'
    # against this program's stdout. Pin the quoted spelling here so a
    # format change breaks THIS test rather than the guard on the host.
    seed_edit1
    dns_check --edit 1
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -qE "^OK 1 ${D}\.? MX '0 \.'"
}

@test "--edit 1 reports MISSING when the null MX was never published" {
    seed_edit1
    zone_delete "$D" MX
    dns_check --edit 1
    [ "$status" -eq 1 ]
    assert_row "MISSING 1 ${D} MX '0 .' '(none)'"
    assert_row "DNS-CHECK: edit=1 checked=7 ok=6 missing=1 wrong=0"
}

@test "--edit 1 reports WRONG when the DMARC policy is not p=reject" {
    seed_edit1
    zone_delete "_dmarc.${D}" TXT
    zone "_dmarc.${D}" TXT '"v=DMARC1; p=none; rua=mailto:postmaster@example.net"'
    dns_check --edit 1
    [ "$status" -eq 1 ]
    assert_row "WRONG 1 _dmarc.${D} TXT ';p=reject'"
    assert_row "OK 1 _dmarc.${D} TXT 'v=DMARC1'"
}

@test "--edit 1 does not accept sp=reject as the DMARC policy tag" {
    seed_edit1
    zone_delete "_dmarc.${D}" TXT
    zone "_dmarc.${D}" TXT '"v=DMARC1; p=none; sp=reject"'
    dns_check --edit 1
    [ "$status" -eq 1 ]
    assert_row "WRONG 1 _dmarc.${D} TXT ';p=reject'"
}

@test "--edit 1 reports WRONG when the MX points somewhere real" {
    seed_edit1
    zone_delete "$D" MX
    zone "$D" MX "10 mail.${D}."
    dns_check --edit 1
    [ "$status" -eq 1 ]
    assert_row "WRONG 1 ${D} MX '0 .' '10 mail.${D}.'"
}

@test "queries the resolver named by --resolver" {
    seed_edit1
    dns_check --edit 1 --resolver 9.9.9.9
    [ "$status" -eq 0 ]
    assert_recorded dig "@9.9.9.9"
}

seed_edit2() {
    zone "$D" A "$EDGE4"
    # deliberately upper-case and uncompressed: expand_ip6 must still match
    zone "$D" AAAA "2001:DB8:0:0:0:0:0:A"
    local h
    for h in www control rs1; do
        zone "${h}.${D}" A "$EDGE4"
        zone "${h}.${D}" AAAA "$EDGE6"
    done
    zone "$EDGE4" PTR "rs1.${D}."
    zone "$EDGE6" PTR "rs1.${D}."
}

# --- edit 2 --------------------------------------------------------------

@test "--edit 2 reports OK for the edge set with no wildcard" {
    seed_edit2
    dns_check --edit 2
    [ "$status" -eq 0 ]
    assert_row "OK 2 ${D} A '${EDGE4}' '${EDGE4}'"
    assert_row "OK 2 ${D} AAAA '2001:0db8:0000:0000:0000:0000:0000:000a'"
    assert_row "OK 2 www.${D} A '${EDGE4}'"
    assert_row "OK 2 control.${D} A '${EDGE4}'"
    assert_row "OK 2 rs1.${D} A '${EDGE4}'"
    assert_row "OK 2 *.${D} A 'ABSENT' '(none)'"
    assert_row "OK 2 ${EDGE4} PTR 'rs1.${D}.' 'rs1.${D}.'"
    assert_row "OK 2 ${EDGE6} PTR 'rs1.${D}.' 'rs1.${D}.'"
    assert_row "DNS-CHECK: edit=2 checked=11 ok=11 missing=0 wrong=0"
}

@test "--edit 2 reports WRONG while the zone wildcard is still live" {
    seed_edit2
    # the wildcard answers EVERY label, which is what a real wildcard does
    printf 'ANY|A|%s\n' "198.51.100.7" >>"$TEST_ZONE"
    cat >"${GREMION_ROOT}/dig-shim.sh" <<'SHIM'
args=("$@")
last=$(( ${#args[@]} - 1 ))
if [ "$last" -ge 1 ] && [ "${args[$(( last - 1 ))]}" = "-x" ]; then
    q_name="${args[$last]}"; q_type="PTR"
else
    q_name="${args[$(( last - 1 ))]}"; q_type="${args[$last]}"
fi
out="$(awk -F'|' -v n="$q_name" -v t="$q_type" '$1 == n && $2 == t { print $3 }' "$TEST_ZONE")"
if [ -z "$out" ] && [ "$q_type" = "A" ]; then
    out="$(awk -F'|' -v t="$q_type" '$1 == "ANY" && $2 == t { print $3 }' "$TEST_ZONE")"
fi
printf '%s' "$out" | grep -v '^$' || true
SHIM
    dns_check --edit 2
    [ "$status" -eq 1 ]
    assert_row "WRONG 2 *.${D} A 'ABSENT' '198.51.100.7'"
}

@test "--edit 2 checks every host in --tenant-hosts" {
    seed_edit2
    printf '# pilot\n%s\n\n  %s  \n' "pilot.${D}" "stura.example.net" \
        >"${GREMION_ROOT}/tenant-hosts.txt"
    zone "pilot.${D}" A "$EDGE4"
    zone "pilot.${D}" AAAA "$EDGE6"
    dns_check --edit 2 --tenant-hosts "${GREMION_ROOT}/tenant-hosts.txt"
    [ "$status" -eq 1 ]
    assert_row "OK 2 pilot.${D} A '${EDGE4}'"
    assert_row "MISSING 2 stura.example.net A '${EDGE4}' '(none)'"
    assert_row "DNS-CHECK: edit=2 checked=15 ok=13 missing=2 wrong=0"
}

@test "--edit 2 reports WRONG when the apex points at the old host" {
    seed_edit2
    zone_delete "$D" A
    zone "$D" A "198.51.100.242"
    dns_check --edit 2
    [ "$status" -eq 1 ]
    assert_row "WRONG 2 ${D} A '${EDGE4}' '198.51.100.242'"
}

@test "--edit 2 skips the v6 rows when --edge-ip6 is not given" {
    seed_edit2
    run "$DNS_CHECK" --domain "$D" --edge-ip "$EDGE4" --mail-ip "$MAIL4" --edit 2
    [ "$status" -eq 0 ]
    refute_row "AAAA"
    assert_row "DNS-CHECK: edit=2 checked=6 ok=6 missing=0 wrong=0"
}

seed_edit3() {
    local h
    for h in mail mta-sts autoconfig autodiscover; do
        zone "${h}.${D}" A "$MAIL4"
        zone "${h}.${D}" AAAA "$MAIL6"
    done
    zone "$MAIL4" PTR "mail.${D}."
    zone "$MAIL6" PTR "mail.${D}."
}

# --- edit 3 --------------------------------------------------------------

@test "--edit 3 reports OK for the four mail hosts and both PTR families" {
    seed_edit3
    dns_check --edit 3
    [ "$status" -eq 0 ]
    assert_row "OK 3 mail.${D} A '${MAIL4}' '${MAIL4}'"
    assert_row "OK 3 mta-sts.${D} A '${MAIL4}'"
    assert_row "OK 3 autoconfig.${D} A '${MAIL4}'"
    assert_row "OK 3 autodiscover.${D} A '${MAIL4}'"
    assert_row "OK 3 ${MAIL4} PTR 'mail.${D}.' 'mail.${D}.'"
    assert_row "OK 3 ${MAIL6} PTR 'mail.${D}.' 'mail.${D}.'"
    assert_row "DNS-CHECK: edit=3 checked=10 ok=10 missing=0 wrong=0"
}

@test "--edit 3 reports MISSING when the v6 PTR was never set in the panel" {
    seed_edit3
    zone_delete "$MAIL6" PTR
    dns_check --edit 3
    [ "$status" -eq 1 ]
    assert_row "MISSING 3 ${MAIL6} PTR 'mail.${D}.' '(none)'"
}

@test "--edit 3 reports WRONG when the mail PTR still names the provider default" {
    seed_edit3
    zone_delete "$MAIL4" PTR
    zone "$MAIL4" PTR "v2202609411800513610.example.net."
    dns_check --edit 3
    [ "$status" -eq 1 ]
    assert_row "WRONG 3 ${MAIL4} PTR 'mail.${D}.' 'v2202609411800513610.example.net.'"
}

@test "--edit 3 reports WRONG when a mail host still points at the edge address" {
    seed_edit3
    zone_delete "mail.${D}" A
    zone "mail.${D}" A "$EDGE4"
    dns_check --edit 3
    [ "$status" -eq 1 ]
    assert_row "WRONG 3 mail.${D} A '${MAIL4}' '${EDGE4}'"
}

seed_edit4a() {
    zone "$D" TXT "\"v=spf1 a:mail.${D} -all\""
    zone "g2026a._domainkey.${D}" TXT '"v=DKIM1; k=rsa; p=MIIBIjANBgkq" "hkiG9w0BAQEFAAOCAQ8A"'
    zone "g2026b._domainkey.${D}" TXT '"v=DKIM1; k=rsa; p=MIIBIjANBgkq" "hkiG9w0BAQEFAAOCAQ8B"'
    zone "_dmarc.${D}" TXT "\"v=DMARC1; p=none; rua=mailto:dmarc-reports@${D}; fo=1; adkim=r; aspf=r\""
    zone "_mta-sts.${D}" TXT '"v=STSv1; id=20260909120000"'
    zone "_smtp._tls.${D}" TXT "\"v=TLSRPTv1; rua=mailto:tls-reports@${D}\""
    zone "_imaps._tcp.${D}" SRV "0 1 993 mail.${D}."
    zone "_submissions._tcp.${D}" SRV "0 1 465 mail.${D}."
    zone "_submission._tcp.${D}" SRV "0 1 587 mail.${D}."
    zone "_jmap._tcp.${D}" SRV "0 1 443 mail.${D}."
    zone "_autodiscover._tcp.${D}" SRV "0 1 443 autodiscover.${D}."
    zone "_pop3._tcp.${D}" SRV "0 0 0 ."
}

seed_edit4b() {
    zone "$D" MX "10 mail.${D}."
}

# --- edit 4a -------------------------------------------------------------

@test "--edit 4a reports OK for the full mail policy set" {
    seed_edit4a
    dns_check --edit 4a
    [ "$status" -eq 0 ]
    assert_row "OK 4a ${D} TXT 'v=spf1 a:mail.${D} -all'"
    assert_row "OK 4a g2026a._domainkey.${D} TXT 'v=DKIM1'"
    assert_row "OK 4a g2026b._domainkey.${D} TXT 'v=DKIM1'"
    assert_row "OK 4a _dmarc.${D} TXT ';p=none'"
    assert_row "OK 4a _mta-sts.${D} TXT 'v=STSv1;id='"
    assert_row "OK 4a _smtp._tls.${D} TXT 'v=TLSRPTv1'"
    assert_row "OK 4a _imaps._tcp.${D} SRV '0 1 993 mail.${D}.'"
    assert_row "OK 4a _pop3._tcp.${D} SRV '0 0 0 .'"
    assert_row "DNS-CHECK: edit=4a checked=13 ok=13 missing=0 wrong=0"
}

@test "--edit 4a reports WRONG while the edit-1 SPF lock is still published" {
    seed_edit4a
    zone_delete "$D" TXT
    zone "$D" TXT '"v=spf1 -all"'
    dns_check --edit 4a
    [ "$status" -eq 1 ]
    assert_row "WRONG 4a ${D} TXT 'v=spf1 a:mail.${D} -all' 'v=spf1 -all'"
}

@test "--edit 4a reports MISSING for an unpublished DKIM selector" {
    seed_edit4a
    zone_delete "g2026b._domainkey.${D}" TXT
    dns_check --edit 4a
    [ "$status" -eq 1 ]
    assert_row "MISSING 4a g2026b._domainkey.${D} TXT 'v=DKIM1' '(none)'"
}

@test "--edit 4a reports WRONG when the MTA-STS TXT carries no id" {
    seed_edit4a
    zone_delete "_mta-sts.${D}" TXT
    zone "_mta-sts.${D}" TXT '"v=STSv1"'
    dns_check --edit 4a
    [ "$status" -eq 1 ]
    assert_row "WRONG 4a _mta-sts.${D} TXT 'v=STSv1;id=' 'v=STSv1'"
}

@test "--edit 4a reports WRONG when POP3 is offered instead of refused" {
    seed_edit4a
    zone_delete "_pop3._tcp.${D}" SRV
    zone "_pop3._tcp.${D}" SRV "0 1 995 mail.${D}."
    dns_check --edit 4a
    [ "$status" -eq 1 ]
    assert_row "WRONG 4a _pop3._tcp.${D} SRV '0 0 0 .' '0 1 995 mail.${D}.'"
}

# --- edit 4b -------------------------------------------------------------

@test "--edit 4b reports OK for the real MX with the null MX gone" {
    seed_edit4b
    dns_check --edit 4b
    [ "$status" -eq 0 ]
    assert_row "OK 4b ${D} MX '10 mail.${D}.' '10 mail.${D}.'"
    assert_row "OK 4b ${D} MX 'NOT 0 .' '10 mail.${D}.'"
    assert_row "DNS-CHECK: edit=4b checked=2 ok=2 missing=0 wrong=0"
}

@test "--edit 4b reports WRONG while the edit-1 null MX survives beside it" {
    seed_edit4b
    zone "$D" MX '0 .'
    dns_check --edit 4b
    [ "$status" -eq 1 ]
    assert_row "OK 4b ${D} MX '10 mail.${D}.'"
    assert_row "WRONG 4b ${D} MX 'NOT 0 .' '10 mail.${D}.,0 .'"
}

@test "--edit 4b reports MISSING before the MX is published" {
    dns_check --edit 4b
    [ "$status" -eq 1 ]
    assert_row "MISSING 4b ${D} MX '10 mail.${D}.' '(none)'"
}

# --- all -----------------------------------------------------------------

seed_steady_state() {
    seed_caa
    seed_edit2
    seed_edit3
    seed_edit4a
    seed_edit4b
}

@test "--edit all is the steady state after edit 4b" {
    seed_steady_state
    dns_check --edit all
    [ "$status" -eq 0 ]
    assert_row "OK 1 ${D} CAA '0 issue \"letsencrypt.org\"'"
    assert_row "OK 2 ${D} A '${EDGE4}'"
    assert_row "OK 3 mail.${D} A '${MAIL4}'"
    assert_row "OK 4a _smtp._tls.${D} TXT 'v=TLSRPTv1'"
    assert_row "OK 4b ${D} MX '10 mail.${D}.'"
    assert_row "DNS-CHECK: edit=all checked=39 ok=39 missing=0 wrong=0"
}

@test "--edit all does not demand the superseded edit-1 lock" {
    seed_steady_state
    dns_check --edit all
    [ "$status" -eq 0 ]
    refute_row " MX '0 .'"
    refute_row "';p=reject'"
    refute_row "TXT 'v=spf1 -all'"
}

@test "--edit all is the default when --edit is omitted" {
    seed_steady_state
    run "$DNS_CHECK" --domain "$D" --edge-ip "$EDGE4" --edge-ip6 "$EDGE6" \
        --mail-ip "$MAIL4" --mail-ip6 "$MAIL6"
    [ "$status" -eq 0 ]
    assert_row "DNS-CHECK: edit=all checked=39 ok=39 missing=0 wrong=0"
}

@test "--edit all fails on a single regressed record" {
    seed_steady_state
    zone_delete "control.${D}" A
    dns_check --edit all
    [ "$status" -eq 1 ]
    assert_row "MISSING 2 control.${D} A '${EDGE4}' '(none)'"
    assert_row "DNS-CHECK: edit=all checked=39 ok=38 missing=1 wrong=0"
}
