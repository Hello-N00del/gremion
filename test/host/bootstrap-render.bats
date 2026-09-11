#!/usr/bin/env bats
# Unit tests for infra/host/bootstrap.sh — the pure renderers and the
# docker/nft-facing helpers.
#
# NOTHING here touches a real docker, nft, ssh or systemctl: every external
# command is a recording shim from test_helper/host.bash, and every stage that
# needs root is exercised through the small helpers it delegates to. The
# stages themselves are proven on the host in steps 18-21.
#
# Run: bats test/host/bootstrap-render.bats

load 'test_helper/host'

BOOTSTRAP="${BATS_TEST_DIRNAME}/../../infra/host/bootstrap.sh"
TEMPLATES="${BATS_TEST_DIRNAME}/../../infra/host/templates"

# A complete, sentinel-free state env using documentation addresses only
# (RFC 5737 / RFC 3849). No host literal ever appears in this tree.
write_state_env() {
    STATE_ENV="${GREMION_ROOT}/etc/env/state.env"
    cat > "$STATE_ENV" <<'EOF'
STACK=gremion
COMPOSE_PROJECT_NAME=gremion-state
PLATFORM_DOMAIN=example.org
ACME_EMAIL=ops@example.org
EDGE_BIND_IP=203.0.113.10
EDGE_BIND_IP6=2001:db8:60:2ed2::a
EDGE_HTTP_PORT=80
EDGE_HTTPS_PORT=443
MAIL_BIND_IP=203.0.113.25
MAIL_BIND_IP6=2001:db8:60:2ed2::25
EDGE_V4_SUBNET=10.90.0.0/24
EDGE_V6_SUBNET=fd5a:90::/64
STATE_V4_SUBNET=10.90.1.0/24
STATE_V6_SUBNET=fd5a:91::/64
MAIL_V4_SUBNET=10.90.9.0/24
MAIL_V6_SUBNET=fd5a:99::/64
POSTGRES_PASSWORD=CHANGE_ME_postgres_root
EOF
    export STATE_ENV
}

setup() {
    setup_host_root
    write_state_env
    export EXT_IFACE=eth0
    # Matches STACK in the fixture state.env above. require_stack_prefix reads it
    # for every external network and volume name; the prefix-refusal test
    # overrides it with STACK=staging.
    export STACK=gremion
    export DEPLOY_USER=gremion
    [[ -f "$BOOTSTRAP" ]] || return 0
    # shellcheck source=/dev/null
    source "$BOOTSTRAP"
    # bootstrap.sh sets -euo pipefail for its OWN execution. Relax ONLY -u:
    # bats' own internals and $output/$status handling are not nounset-clean.
    #
    # -e MUST STAY ON. bats detects a failed assertion through the ERR trap it
    # installs (the test body runs with 'ehBET'), and the ERR trap only fires
    # while errexit is set. `set +e` here would make every @test in this file
    # pass unconditionally — including a failing LAST command — which is a
    # suite that cannot go red. pipefail stays on too.
    set +u
}

teardown() {
    teardown_host_root
}

# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------

@test "bootstrap.sh exists" {
    [[ -f "$BOOTSTRAP" ]]
}

@test "bootstrap.sh is executable" {
    [[ -x "$BOOTSTRAP" ]]
}

@test "bootstrap.sh has strict mode set" {
    grep -q '^set -euo pipefail$' "$BOOTSTRAP"
}

@test "bootstrap.sh sources the shared host library" {
    grep -q 'SCRIPT_DIR/lib/common.sh' "$BOOTSTRAP"
}

@test "the common.sh source carries a resolvable shellcheck source= directive" {
    # Task 14's directive guard greps '^# shellcheck source=[^[:space:]]+$'.
    # The combined 'source=… disable=…' form does not match it, so the two
    # directives live on separate lines. This is the convention for every
    # script under infra/host/.
    grep -qx '# shellcheck source=lib/common.sh' "$BOOTSTRAP"
    grep -qx '# shellcheck disable=SC1091' "$BOOTSTRAP"
}

@test "bootstrap.sh never flushes the kernel ruleset" {
    # N20/§B: Docker's tables live in the same ruleset. A flush deletes every
    # published port's DNAT and reports nothing.
    ! grep -q 'flush ruleset' "$BOOTSTRAP"
}

@test "--help lists every stage of the contract" {
    run bash "$BOOTSTRAP" --help
    [ "$status" -eq 0 ]
    local s
    for s in check addresses base user docker networks firewall agent timers harden-ssh all; do
        [[ "$output" == *"$s"* ]] || { echo "stage '$s' missing from usage"; false; }
    done
}

@test "an unknown stage is a usage error (exit 2)" {
    run bash "$BOOTSTRAP" nope
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown stage: nope"* ]]
}

# ---------------------------------------------------------------------------
# render_nft — the one table this host owns
# ---------------------------------------------------------------------------

@test "render_nft substitutes every variable" {
    run render_nft "$STATE_ENV"
    [ "$status" -eq 0 ]
    [[ "$output" != *'${'* ]] || { echo "unsubstituted token in render:"; echo "$output" | grep -n '\${'; false; }
}

@test "render_nft owns exactly one table and touches no other" {
    run render_nft "$STATE_ENV"
    [ "$status" -eq 0 ]
    [[ "$output" == *"table inet gremion {"* ]]
    [[ "$output" != *"table inet filter"* ]]
    [[ "$output" != *"flush ruleset"* ]]
    # atomic replace idiom, so the host is never momentarily unfiltered
    [[ "$output" == *"delete table inet gremion"* ]]
}

@test "render_nft binds the edge ports to the edge address only" {
    run render_nft "$STATE_ENV"
    [[ "$output" == *"ip  daddr 203.0.113.10  tcp dport { 80, 443 } accept"* ]]
    [[ "$output" == *"ip6 daddr 2001:db8:60:2ed2::a tcp dport { 80, 443 } accept"* ]]
    # The mail-only ports are NEVER open on the edge address. This is scoped to
    # a single LINE on purpose: a bash glob spans newlines, so
    # [[ "$output" != *"daddr 203.0.113.10"*"465"* ]] over the whole render
    # always matches the mail rule five lines further down and asserts nothing.
    # Not `! grep …`: a !-negated command is exempt from the ERR trap bats uses
    # to detect a failed assertion, so it only registers in the LAST position.
    if grep -E 'daddr 203\.0\.113\.10 .*(465|587|993|25[, ])' <<<"$output"; then
        echo "a mail-only port is accepted on the edge address (line above)"
        false
    fi
}

@test "render_nft binds the mail ports to the mail address only" {
    run render_nft "$STATE_ENV"
    [[ "$output" == *"ip  daddr 203.0.113.25  tcp dport { 25, 80, 443, 465, 587, 993 } accept"* ]]
    [[ "$output" == *"ip6 daddr 2001:db8:60:2ed2::25 tcp dport { 25, 80, 443, 465, 587, 993 } accept"* ]]
}

@test "render_nft drops egress 25 for every source except the mail subnet" {
    run render_nft "$STATE_ENV"
    [[ "$output" == *'oifname "eth0" meta nfproto ipv4 tcp dport 25 ip  saddr != 10.90.9.0/24 counter drop'* ]]
    [[ "$output" == *'oifname "eth0" meta nfproto ipv6 tcp dport 25 ip6 saddr != fd5a:99::/64 counter drop'* ]]
}

@test "render_nft SNATs the mail subnet to the mail address on both families" {
    run render_nft "$STATE_ENV"
    [[ "$output" == *'oifname "eth0" ip  saddr 10.90.9.0/24 counter snat ip  to 203.0.113.25'* ]]
    [[ "$output" == *'oifname "eth0" ip6 saddr fd5a:99::/64 counter snat ip6 to 2001:db8:60:2ed2::25'* ]]
}

@test "render_nft puts forward ahead of Docker's chains and nat ahead of MASQUERADE" {
    run render_nft "$STATE_ENV"
    [[ "$output" == *"type filter hook forward priority filter - 10;"* ]]
    [[ "$output" == *"type nat hook postrouting priority srcnat - 1;"* ]]
}

@test "render_nft requires EXT_IFACE" {
    unset EXT_IFACE
    run render_nft "$STATE_ENV"
    [ "$status" -eq 2 ]
    [[ "$output" == *"EXT_IFACE is not set"* ]]
}

@test "render_nft refuses a CHANGE_ME_ sentinel in an address it substitutes" {
    sed -i 's|^MAIL_BIND_IP=.*|MAIL_BIND_IP=CHANGE_ME_ipb|' "$STATE_ENV"
    run render_nft "$STATE_ENV"
    [ "$status" -eq 2 ]
    [[ "$output" == *"MAIL_BIND_IP still holds the CHANGE_ME_ipb sentinel"* ]]
}

@test "render_template refuses to leave an unsubstituted token behind" {
    printf 'a=${EDGE_BIND_IP}\nb=${NOT_IN_THE_ALLOW_LIST}\n' > "${GREMION_ROOT}/t.tmpl"
    EDGE_BIND_IP=203.0.113.10 run render_template "${GREMION_ROOT}/t.tmpl" EDGE_BIND_IP
    [ "$status" -eq 2 ]
    [[ "$output" == *'unsubstituted ${…} left'* ]]
    [[ "$output" == *'${NOT_IN_THE_ALLOW_LIST}'* ]]
}

# ---------------------------------------------------------------------------
# /etc/nftables.conf and the nftables.service drop-in
# ---------------------------------------------------------------------------

@test "nftables_conf includes the drop-in directory and never flushes" {
    run nftables_conf
    [ "$status" -eq 0 ]
    [[ "$output" == *'include "/etc/nftables.d/*.nft"'* ]]
    [[ "$output" != *"flush ruleset"* ]]
}

@test "nftables_dropin replaces Debian's flush-on-stop with a table delete" {
    # Debian's nftables.service runs a whole-ruleset flush in ExecStop, which
    # would delete Docker's tables along with ours.
    run nftables_dropin
    [ "$status" -eq 0 ]
    [[ "$output" == *$'ExecStop=\n'* ]]
    [[ "$output" == *"ExecStop=/usr/sbin/nft delete table inet gremion"* ]]
    [[ "$output" != *"flush"* ]]
}

# ---------------------------------------------------------------------------
# interfaces_stanza — persistent addresses
# ---------------------------------------------------------------------------

@test "interfaces_stanza adds the mail address and both v6 addresses" {
    load_state_env
    run interfaces_stanza
    [ "$status" -eq 0 ]
    [[ "$output" == *"auto eth0:1"* ]]
    [[ "$output" == *"address 203.0.113.25"* ]]
    [[ "$output" == *"netmask 255.255.255.255"* ]]
    [[ "$output" == *"up   ip -6 addr add 2001:db8:60:2ed2::a/64 dev eth0 || true"* ]]
    [[ "$output" == *"up   ip -6 addr add 2001:db8:60:2ed2::25/64 dev eth0 || true"* ]]
    [[ "$output" == *"down ip -6 addr del 2001:db8:60:2ed2::a/64 dev eth0 || true"* ]]
}

@test "interfaces_stanza never restates the provider-assigned primary address" {
    load_state_env
    run interfaces_stanza
    [[ "$output" != *"address 203.0.113.10"* ]]
}

@test "interfaces_stanza refuses a sentinel address" {
    sed -i 's|^MAIL_BIND_IP=.*|MAIL_BIND_IP=CHANGE_ME_ipb|' "$STATE_ENV"
    load_state_env
    run interfaces_stanza
    [ "$status" -eq 2 ]
    [[ "$output" == *"MAIL_BIND_IP still holds the CHANGE_ME_ipb sentinel"* ]]
}

# ---------------------------------------------------------------------------
# render_unit <unit-name> <dest> — the four systemd units
# ---------------------------------------------------------------------------

@test "render_unit writes gremion-hostd.service to the destination it is given" {
    run render_unit gremion-hostd.service "${GREMION_ROOT}/hostd.unit"
    [ "$status" -eq 0 ]
    [[ -f "${GREMION_ROOT}/hostd.unit" ]]
    [[ "$(stat -c '%a' "${GREMION_ROOT}/hostd.unit")" == "644" ]]
    run cat "${GREMION_ROOT}/hostd.unit"
    [[ "$output" == *"ExecStart=${GREMION_ROOT}/bin/gremion-hostd --socket"* ]]
    [[ "$output" == *"User=gremion"* ]]
    [[ "$output" == *"RuntimeDirectory=gremion"* ]]
    [[ "$output" == *"SupplementaryGroups=docker"* ]]
    [[ "$output" == *"WantedBy=multi-user.target"* ]]
}

@test "render_unit refuses a single argument" {
    # The one-argument, print-to-stdout form does not exist: a caller that
    # passed only a name would have its destination silently ignored.
    run render_unit gremion-hostd.service
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: render_unit <unit-name> <dest>"* ]]
}

@test "gremion-hostd.service does not make the deploy user's home read-only" {
    # gremion-deploy writes ~/.docker/config.json on login and the N12 guard
    # reads it back after logout. ProtectHome=read-only would break both.
    run render_unit gremion-hostd.service /dev/stdout
    [ "$status" -eq 0 ]
    [[ "$output" != *"ProtectHome=read-only"* ]]
    [[ "$output" != *"ProtectSystem=strict"* ]]
}

@test "render_unit renders the backup service and timer" {
    run render_unit gremion-backup.service "${GREMION_ROOT}/b.service"
    [ "$status" -eq 0 ]
    run cat "${GREMION_ROOT}/b.service"
    [[ "$output" == *"ExecStart=${GREMION_ROOT}/bin/gremion-backup --class daily"* ]]
    [[ "$output" == *"Type=oneshot"* ]]
    run render_unit gremion-backup.timer "${GREMION_ROOT}/b.timer"
    [ "$status" -eq 0 ]
    run cat "${GREMION_ROOT}/b.timer"
    [[ "$output" == *"OnCalendar=*-*-* 02:00:00"* ]]
    [[ "$output" == *"Persistent=true"* ]]
    [[ "$output" == *"WantedBy=timers.target"* ]]
}

@test "render_unit renders the reboot-gate verify unit after docker" {
    run render_unit gremion-verify.service "${GREMION_ROOT}/v.service"
    [ "$status" -eq 0 ]
    run cat "${GREMION_ROOT}/v.service"
    [[ "$output" == *"After=docker.service"* ]]
    [[ "$output" == *"ExecStart=${GREMION_ROOT}/bin/gremion-verify"* ]]
    [[ "$output" == *"WantedBy=multi-user.target"* ]]
}

@test "render_unit rejects an unknown unit name" {
    run render_unit gremion-nope.service "${GREMION_ROOT}/nope"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no template for unit 'gremion-nope.service'"* ]]
    [[ ! -f "${GREMION_ROOT}/nope" ]]
}

@test "every systemd template keeps the GREMION_ROOT token and hard-codes no path" {
    # CONVENTION (Task 2 Interfaces item 2). Tasks 4, 9 and 11 rewrite three of
    # these four files; if any of them substitutes a literal /opt/gremion for
    # the token, this test and every ExecStart assertion above go RED.
    local t
    for t in gremion-hostd.service gremion-backup.service gremion-verify.service; do
        grep -qF '${GREMION_ROOT}/bin/' "${TEMPLATES}/systemd/${t}" \
            || { echo "${t}: ExecStart does not use \${GREMION_ROOT}/bin/"; false; }
    done
    run grep -rl '/opt/gremion' "${TEMPLATES}/systemd/"
    [ "$status" -ne 0 ] || { echo "systemd template(s) hard-code /opt/gremion: $output"; false; }
}

# ---------------------------------------------------------------------------
# Shared external networks and volumes (shimmed docker, no real daemon)
# ---------------------------------------------------------------------------

shim_docker_resources() {
    shim docker '
name="${*: -1}"
case "$1 $2" in
  "network inspect")
      [ -f "$GREMION_ROOT/.net-$name" ] || exit 1
      echo "true 10.90.0.0/24 fd5a:90::/64 " ;;
  "network create")
      : > "$GREMION_ROOT/.net-$name" ;;
  "volume inspect")
      [ -f "$GREMION_ROOT/.vol-$name" ] || exit 1
      echo "$name" ;;
  "volume create")
      : > "$GREMION_ROOT/.vol-$name" ;;
esac
exit 0'
}

@test "ensure_network creates a dual-stack network with both pinned subnets" {
    shim_docker_resources
    run ensure_network gremion_edge 10.90.0.0/24 fd5a:90::/64
    [ "$status" -eq 0 ]
    assert_recorded docker "network create --ipv6 --subnet 10.90.0.0/24 --subnet fd5a:90::/64 gremion_edge"
}

@test "ensure_network is idempotent" {
    shim_docker_resources
    : > "${GREMION_ROOT}/.net-gremion_edge"
    run ensure_network gremion_edge 10.90.0.0/24 fd5a:90::/64
    [ "$status" -eq 0 ]
    run grep -c "network create" "$SHIM_LOG"
    [ "$output" -eq 0 ]
}

@test "ensure_network asserts IPv6 from docker, not from the create exit code" {
    shim docker '
case "$1 $2" in
  "network inspect") echo "false 10.90.0.0/24 " ;;
  *) : ;;
esac
exit 0'
    run ensure_network gremion_edge 10.90.0.0/24 fd5a:90::/64
    [ "$status" -eq 1 ]
    [[ "$output" == *"network gremion_edge: IPv6 is not enabled"* ]]
}

@test "ensure_network asserts the v6 subnet is the pinned one" {
    shim docker '
case "$1 $2" in
  "network inspect") echo "true 10.90.0.0/24 fd00:dead::/64 " ;;
  *) : ;;
esac
exit 0'
    run ensure_network gremion_edge 10.90.0.0/24 fd5a:90::/64
    [ "$status" -eq 1 ]
    [[ "$output" == *"subnet fd5a:90::/64 absent"* ]]
}

@test "ensure_volume creates and reads back the external volume" {
    shim_docker_resources
    run ensure_volume gremion_traefik_acme
    [ "$status" -eq 0 ]
    assert_recorded docker "volume create gremion_traefik_acme"
}

@test "an external resource without the STACK prefix is refused" {
    export STACK=staging
    run require_stack_prefix gremion_edge
    [ "$status" -eq 2 ]
    [[ "$output" == *"does not carry the 'staging_' prefix"* ]]
}

# ---------------------------------------------------------------------------
# Docker's NAT table must survive our firewall stage (shimmed nft)
# ---------------------------------------------------------------------------

@test "assert_docker_nat_present names the backend it observed" {
    shim nft 'printf "table inet gremion\ntable ip nat\ntable ip filter\n"; exit 0'
    run assert_docker_nat_present
    [ "$status" -eq 0 ]
    [[ "$output" == *"NFT-BACKEND: docker-nat-table=ip nat"* ]]
}

@test "assert_docker_nat_present accepts Docker 29's own tables" {
    shim nft 'printf "table inet gremion\ntable ip docker-bridges\n"; exit 0'
    run assert_docker_nat_present
    [ "$status" -eq 0 ]
    [[ "$output" == *"NFT-BACKEND: docker-nat-table=ip docker-bridges"* ]]
}

@test "assert_docker_nat_present fails when Docker's tables are gone" {
    shim nft 'printf "table inet gremion\n"; exit 0'
    run assert_docker_nat_present
    [ "$status" -eq 1 ]
    [[ "$output" == *"Docker's NAT table is gone"* ]]
}

# ---------------------------------------------------------------------------
# The restricted deploy key
# ---------------------------------------------------------------------------

@test "authorized_keys_line forces the agent and strips every forwarding" {
    ssh-keygen -q -t ed25519 -N '' -C deploy -f "${GREMION_ROOT}/id" </dev/null
    run authorized_keys_line "${GREMION_ROOT}/id.pub"
    [ "$status" -eq 0 ]
    [[ "$output" == "command=\"${GREMION_ROOT}/bin/gremion-hostd --ssh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 "* ]]
}

@test "authorized_keys_line refuses a file with more than one key" {
    ssh-keygen -q -t ed25519 -N '' -f "${GREMION_ROOT}/a" </dev/null
    ssh-keygen -q -t ed25519 -N '' -f "${GREMION_ROOT}/b" </dev/null
    cat "${GREMION_ROOT}/a.pub" "${GREMION_ROOT}/b.pub" > "${GREMION_ROOT}/two.pub"
    run authorized_keys_line "${GREMION_ROOT}/two.pub"
    [ "$status" -eq 2 ]
    [[ "$output" == *"expected exactly one public key"* ]]
}

@test "authorized_keys_line refuses something that is not a public key" {
    # Without ssh-keygen this test would pass for the WRONG reason: the
    # validator would be missing rather than the key being junk. Fail loudly
    # instead of reporting a green that proves nothing.
    command -v ssh-keygen >/dev/null         || { echo "ssh-keygen absent: this test cannot tell a junk key from a missing validator"; false; }
    echo "not-a-key" > "${GREMION_ROOT}/junk.pub"
    run authorized_keys_line "${GREMION_ROOT}/junk.pub"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not a valid public key file"* ]]
}

# ---------------------------------------------------------------------------
# Stage-level static guards (the stages themselves are proven on the host)
# ---------------------------------------------------------------------------

@test "the deploy user's etc/ is created 0700" {
    grep -qF 'install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${root}/etc"' "$BOOTSTRAP"
}

@test "stage_base installs gettext-base and proves envsubst is on PATH" {
    # gremion-switch (Task 6) and ops/render-ops.sh (Task 11) both open with
    # need_cmd envsubst, and no other stage installs it.
    #
    # Comments are stripped first: the package is also NAMED in the comment
    # above the apt-get line, so a plain grep stays green after the package is
    # deleted from the install list — a guard that cannot fail.
    #
    # No pipe into `grep -q`: pipefail is on in this suite and -q exits the
    # moment it matches, so the upstream grep dies of SIGPIPE and the pipeline
    # returns 141 on the PASSING path. Capture first, match second.
    local code; code="$(grep -v '^[[:space:]]*#' "$BOOTSTRAP")"
    grep -qF 'gettext-base' <<<"$code"
    grep -qF 'for c in git jq nft dig openssl fail2ban-client envsubst; do' "$BOOTSTRAP"
}

@test "no stage restarts or stops nftables.service" {
    # Debian's ExecStop flushes the ruleset; the drop-in fixes that, but the
    # firewall stage still has no reason to bounce the unit.
    ! grep -E 'systemctl (restart|stop) nftables' "$BOOTSTRAP"
}

@test "no stage prunes anything" {
    ! grep -E 'docker (system|volume|image|network) prune' "$BOOTSTRAP"
}

@test "stage_addresses creates interfaces.d before writing into it" {
    # atomic_write exits 2 when the parent directory is absent, and
    # /etc/network/interfaces.d only exists once ifupdown is installed.
    # Captured first, then matched: a pipe into `grep -q` returns 141 under
    # pipefail once the downstream grep exits early (see the gettext-base test).
    local ctx; ctx="$(grep -B3 -F 'atomic_render /etc/network/interfaces.d/gremion 644 interfaces_stanza' "$BOOTSTRAP")"
    grep -qF 'install -d -m 755 /etc/network/interfaces.d' <<<"$ctx"
}

@test "agent and timers refuse to run before their binaries exist" {
    grep -qF 'precondition: ${root}/bin/gremion-hostd is not installed' "$BOOTSTRAP"
    grep -qF 'precondition: ${root}/bin/${b} is not installed' "$BOOTSTRAP"
}

@test "the deploy key is never installed without the forced command" {
    grep -qF 'also appears in ${ak} without the forced command' "$BOOTSTRAP"
}

@test "harden-ssh proves AllowUsers from sshd -T and names the accounts it locks out" {
    grep -qF 'grep -q "allowusers.*${DEPLOY_USER}"' "$BOOTSTRAP"
    grep -qF 'will lose SSH access for:' "$BOOTSTRAP"
}

# ---------------------------------------------------------------------------
# atomic_render — a failed render must never reach the destination
# ---------------------------------------------------------------------------

@test "atomic_render installs the output when the renderer succeeds" {
    run atomic_render "${GREMION_ROOT}/out.nft" 644 printf 'good\n'
    [ "$status" -eq 0 ]
    [[ "$(cat "${GREMION_ROOT}/out.nft")" == "good" ]]
}

@test "atomic_render installs NOTHING when the renderer fails" {
    run atomic_render "${GREMION_ROOT}/out.nft" 644 bash -c 'printf "half a file\n"; exit 2'
    [ "$status" -eq 2 ]
    [[ ! -e "${GREMION_ROOT}/out.nft" ]]
}

@test "a failed render never destroys the file already in place" {
    # Observed on the host: `render_nft … | atomic_write …` ran atomic_write
    # regardless, so a render refused for an unfilled sentinel truncated
    # /etc/nftables.d/gremion.nft to 0 bytes. At the next boot that is a host
    # with no gremion table at all, and nothing says so.
    printf 'GOOD RULESET\n' > "${GREMION_ROOT}/out.nft"
    run atomic_render "${GREMION_ROOT}/out.nft" 644 bash -c 'exit 2'
    [ "$status" -eq 2 ]
    [[ "$(cat "${GREMION_ROOT}/out.nft")" == "GOOD RULESET" ]]
}

@test "atomic_render refuses a call without a command" {
    run atomic_render "${GREMION_ROOT}/out.nft" 644
    [ "$status" -eq 2 ]
    [[ "$output" == *"usage: atomic_render <dest> <mode> <command...>"* ]]
}

@test "no renderer is piped straight into atomic_write" {
    # The pipeline form is what destroyed the file above. Every renderer that
    # can die must go through atomic_render instead.
    local hits
    hits="$(grep -nE '(render_nft|interfaces_stanza|nftables_conf|nftables_dropin)[^|]*\| *atomic_write' "$BOOTSTRAP" || true)"
    [[ -z "$hits" ]] || { echo "renderer piped into atomic_write:"; echo "$hits"; false; }
}
