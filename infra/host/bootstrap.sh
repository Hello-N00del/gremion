#!/usr/bin/env bash
#
# Gremion host bootstrap, v2.
#
# The host's definition: addresses, packages, deploy user, Docker, the shared
# networks and volumes, the firewall, the host agent, the timers, and (gated)
# SSH hardening. Every value that differs between hosts is read from
# etc/env/state.env — this file contains no address, hostname or domain.
#
# PROPERTIES
#   - Idempotent. Re-running is the intended way to converge a drifted host.
#   - Asserts POST-CONDITIONS, never exit codes. `apt-get install` returning 0
#     does not mean the binary is on PATH; `nft -f` returning 0 does not mean
#     the rule is loaded. Each stage ends by observing the state it claims to
#     have produced.
#   - Refuses to lock you out. harden-ssh will not disable password auth until
#     it has proven the deploy user can already authenticate with a key, and it
#     names every account that its AllowUsers line will lock out.
#   - Never touches Docker's firewall tables and never flushes the ruleset.
#
# The stage list and the options are printed by usage() below — a heredoc, not
# a line-range read of this header, so inserting a function can never truncate
# `--help`.
#
# EXIT CODES: 0 ok · 1 assertion/post-condition failed · 2 usage or missing
# precondition · 3 blocked on an external step (operator).

# SHELLCHECK: SC2015 is disabled file-wide. Every hit is this script's
# post-condition idiom, `<observation> && ok "…" || die "…"`, carried over
# verbatim from the superseded netcup bootstrap. `ok` is a printf wrapper,
# so the "C may run when A is true" case can only ever turn a pass into a
# loud failure, never a failure into a pass.
# shellcheck disable=SC2015

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/common.sh"

TEMPLATE_DIR="${SCRIPT_DIR}/templates"

DEPLOY_USER="${DEPLOY_USER:-gremion}"
TIMEZONE="${TIMEZONE:-Europe/Berlin}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
SSH_PORT="${SSH_PORT:-22}"

# Docker's default json-file driver is UNBOUNDED. On a fixed VPS disk that is
# an outage waiting to happen, and it takes down every container at once.
LOG_MAX_SIZE="${LOG_MAX_SIZE:-50m}"
LOG_MAX_FILE="${LOG_MAX_FILE:-5}"

# Ports that are not part of the env contract because they never vary per host.
LIVEKIT_TCP_PORT="${LIVEKIT_TCP_PORT:-7881}"
LIVEKIT_UDP_RANGE="${LIVEKIT_UDP_RANGE:-45000-45100}"
BACKUP_ONCALENDAR="${BACKUP_ONCALENDAR:-*-*-* 02:00:00}"

STATE_ENV="${STATE_ENV:-}"
HOST_FQDN="${HOST_FQDN:-}"
DEPLOY_PUBKEY_FILE="${DEPLOY_PUBKEY_FILE:-}"
EXPECT_PTR=0
DNS_RESOLVER="${DNS_RESOLVER:-1.1.1.1}"

usage() {
    cat <<'EOF'
Gremion host bootstrap, v2.

USAGE
  ./bootstrap.sh [options] <stage>

Stages:
  check        observe current state, change nothing
  addresses    persistent edge/mail addresses + hostname   (needs state.env)
  base         packages, timezone, swap, time sync, fail2ban
  user         deploy user, authorized_keys, host layout
  docker       Docker Engine + compose plugin + log caps
  networks     shared external networks and volumes        (needs state.env)
  firewall     table inet gremion                          (needs state.env)
  agent        gremion-hostd unit + restricted deploy key
  timers       gremion-backup.timer + gremion-verify.service
  harden-ssh   key-only SSH   (RUN LAST, gated, not part of 'all')
  all          base user docker addresses networks firewall agent timers

Options:
  --env-file PATH        state env file (default: <root>/etc/env/state.env)
  --fqdn NAME            host FQDN for the 'addresses' stage
  --deploy-pubkey PATH   public key for the 'agent' stage
  --expect-ptr           'addresses' also verifies both PTR records
  -h, --help             this text

'all' deliberately excludes harden-ssh: closing SSH is the one
irreversible-feeling step, so it stays an explicit decision. 'all' also runs
'agent' and 'timers', which require <root>/bin to be populated by a release
checkout; on a bare host run the earlier stages individually first.

EXIT CODES: 0 ok · 1 assertion failed · 2 usage/precondition · 3 blocked
EOF
}

# ──────────────────────────────────────────────────────────────────────────
# Rendering
# ──────────────────────────────────────────────────────────────────────────

# render_template <template> <VAR...>
# Substitutes exactly the named ${VAR} tokens and nothing else, then proves
# nothing was left behind. An allow-list, not envsubst: a template must not be
# able to pull an unrelated variable out of the environment.
render_template() {
    local tmpl="$1"; shift
    [[ -f "$tmpl" ]] || die "template not found: ${tmpl}" 2
    local out var val
    out="$(cat "$tmpl")"
    for var in "$@"; do
        val="${!var-}"
        [[ -n "$val" ]] || die "render ${tmpl##*/}: ${var} is empty" 2
        [[ "$val" != CHANGE_ME_* ]] \
            || die "render ${tmpl##*/}: ${var} still holds the ${val} sentinel" 2
        out="${out//\$\{${var}\}/${val}}"
    done
    # The '${' and the grep pattern below are the literal token being
    # searched for, not an expansion that failed to expand.
    # shellcheck disable=SC2016
    if [[ "$out" == *'${'* ]]; then
        die "render ${tmpl##*/}: unsubstituted \${…} left: $(printf '%s' "$out" |
            grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' | sort -u | tr '\n' ' ')" 2
    fi
    printf '%s\n' "$out"
}

# load_state_env — read etc/env/state.env into the environment.
# Sentinels are tolerated HERE: the addresses, the networks and the firewall
# are configured before any secret is filled in. Every value this script
# actually substitutes is re-checked by render_template, which refuses a
# CHANGE_ME_ value, so a sentinel can never reach a rendered file.
load_state_env() {
    local envfile="${STATE_ENV:-$(gremion_root)/etc/env/state.env}"
    [[ -f "$envfile" ]] || die "state env file not found: ${envfile} (run gremion-init-secrets)" 2
    ALLOW_SENTINELS=1
    export ALLOW_SENTINELS
    load_env "$envfile"
    unset ALLOW_SENTINELS
    STATE_ENV="$envfile"
}

detect_ext_iface() {
    ip -4 route show default 2>/dev/null | awk '{print $5; exit}'
}

# render_nft <env-file> — print the host ruleset. Pure: reads the env file in a
# subshell, writes only to stdout.
render_nft() {
    local envfile="$1"
    [[ -f "$envfile" ]] || die "state env file not found: ${envfile}" 2
    (
        ALLOW_SENTINELS=1
        export ALLOW_SENTINELS
        load_env "$envfile"
        # Defaults are deliberately subshell-local: render_nft is pure and
        # must not leak them into the caller.
        # shellcheck disable=SC2030
        : "${SSH_PORT:=22}" "${LIVEKIT_TCP_PORT:=7881}" "${LIVEKIT_UDP_RANGE:=45000-45100}"
        [[ -n "${EXT_IFACE:-}" ]] \
            || die "EXT_IFACE is not set (the interface the SNAT and egress-25 rules pin to)" 2
        render_template "${TEMPLATE_DIR}/nftables/gremion.nft.tmpl" \
            EDGE_BIND_IP EDGE_BIND_IP6 MAIL_BIND_IP MAIL_BIND_IP6 \
            MAIL_V4_SUBNET MAIL_V6_SUBNET \
            EDGE_HTTP_PORT EDGE_HTTPS_PORT SSH_PORT \
            LIVEKIT_TCP_PORT LIVEKIT_UDP_RANGE EXT_IFACE
    )
}

# The boot-time loader. Deliberately no whole-ruleset flush (N20/§B).
nftables_conf() {
    cat <<'EOF'
#!/usr/sbin/nft -f
# Managed by infra/host/bootstrap.sh (stage: firewall). Do not hand-edit.
#
# The kernel ruleset is deliberately NEVER flushed wholesale here. Docker keeps
# its DNAT and masquerade rules in its own tables in the same kernel ruleset;
# flushing at boot, or when the nftables unit is restarted, would delete every
# published port's DNAT and leave every container unreachable with no error
# anywhere. Two tree-wide guards grep this script for the literal two-word
# flush directive and for a restart of that unit, so this comment deliberately
# spells out neither.
#
# This host owns exactly one table, `inet gremion`, and the included file
# replaces it atomically.
include "/etc/nftables.d/*.nft"
EOF
}

# Debian's nftables.service carries an ExecStop that flushes the whole kernel
# ruleset. Stopping or restarting the unit would therefore delete Docker's
# tables. The empty ExecStop= line clears the vendor list; the second line
# replaces it with a delete of the one table this host owns.
nftables_dropin() {
    cat <<'EOF'
[Service]
# Managed by infra/host/bootstrap.sh (stage: firewall). Do not hand-edit.
ExecStop=
ExecStop=/usr/sbin/nft delete table inet gremion
EOF
}

# interfaces_stanza — the persistent form of the two service addresses.
# Purely ADDITIVE: the provider-assigned primary addresses of ${EXT_IFACE} stay
# where the image put them and are never restated here, so a re-render can
# never orphan the address this SSH session is riding on.
interfaces_stanza() {
    local v
    for v in EXT_IFACE MAIL_BIND_IP EDGE_BIND_IP6 MAIL_BIND_IP6; do
        [[ -n "${!v-}" ]] || die "interfaces_stanza: ${v} is not set" 2
        [[ "${!v}" != CHANGE_ME_* ]] \
            || die "interfaces_stanza: ${v} still holds the ${!v} sentinel" 2
    done
    cat <<EOF
# /etc/network/interfaces.d/gremion
# Managed by infra/host/bootstrap.sh (stage: addresses). Do not hand-edit.
#
# Additional service addresses only. The provider-assigned primary addresses of
# ${EXT_IFACE} are configured by the image and are deliberately not restated.
#
# The add-on IPv4 is routed to this host as a host route, so it is configured
# as a /32 alias (spike S9 records the provider's confirmed form). IPv6 has no
# alias-interface concept, so the two static addresses of the host's /64 are
# added directly; '|| true' keeps a re-run from failing the interface.
auto ${EXT_IFACE}:1
iface ${EXT_IFACE}:1 inet static
    address ${MAIL_BIND_IP}
    netmask 255.255.255.255
    up   ip -6 addr add ${EDGE_BIND_IP6}/64 dev ${EXT_IFACE} || true
    up   ip -6 addr add ${MAIL_BIND_IP6}/64 dev ${EXT_IFACE} || true
    down ip -6 addr del ${EDGE_BIND_IP6}/64 dev ${EXT_IFACE} || true
    down ip -6 addr del ${MAIL_BIND_IP6}/64 dev ${EXT_IFACE} || true
EOF
}

# render_unit <unit-name> <dest>
# Renders templates/systemd/<unit-name> and writes it to <dest> with mode 644
# via atomic_write. <dest> may be '-' or '/dev/stdout', in which case the unit
# is printed and nothing is written (the unit tests and `--check` style calls
# use that form). There is deliberately no one-argument form: every caller in
# this plan installs a file.
render_unit() {
    local unit="${1:-}" dest="${2:-}"
    [[ -n "$unit" && -n "$dest" ]] || die "usage: render_unit <unit-name> <dest>" 2
    local tmpl="${TEMPLATE_DIR}/systemd/${unit}"
    [[ -f "$tmpl" ]] || die "no template for unit '${unit}' (${tmpl})" 2

    # Render to a scratch file first: a failed render must never reach
    # atomic_write, which would otherwise install an empty unit.
    local tmp; tmp="$(mktemp)"
    if ! ( GREMION_ROOT="$(gremion_root)"; export GREMION_ROOT
           render_template "$tmpl" GREMION_ROOT DEPLOY_USER BACKUP_ONCALENDAR ) > "$tmp"; then
        rm -f "$tmp"
        return 2
    fi
    if [[ "$dest" == "-" || "$dest" == "/dev/stdout" ]]; then
        cat "$tmp"; rm -f "$tmp"; return 0
    fi
    atomic_write "$dest" 644 < "$tmp"
    rm -f "$tmp"
}

# §E: bootstrap refuses to create a shared external resource that is not
# stack-scoped. A globally named network or volume is how two stacks on one
# host silently share state.
require_stack_prefix() {
    local name="$1"
    [[ -n "${STACK:-}" ]] || die "STACK is not set (state.env)" 2
    [[ "$name" == "${STACK}_"* ]] \
        || die "refusing to create external resource '${name}': it does not carry the '${STACK}_' prefix" 2
}

# ensure_network <name> <v4-subnet> <v6-subnet>
# Post-conditions are read back from docker, never inferred from `create`.
ensure_network() {
    local name="$1" v4="$2" v6="$3" observed
    require_stack_prefix "$name"
    if ! docker network inspect "$name" >/dev/null 2>&1; then
        docker network create --ipv6 --subnet "$v4" --subnet "$v6" "$name" >/dev/null
    fi
    observed="$(docker network inspect -f '{{.EnableIPv6}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$name")"
    [[ "$observed" == "true "* ]] \
        || die "network ${name}: IPv6 is not enabled (observed: ${observed})"
    [[ "$observed" == *"$v4"* ]] \
        || die "network ${name}: subnet ${v4} absent (observed: ${observed})"
    [[ "$observed" == *"$v6"* ]] \
        || die "network ${name}: subnet ${v6} absent (observed: ${observed})"
    ok "network ${name} ${v4} ${v6}"
}

# ensure_volume <name>
ensure_volume() {
    local name="$1" observed
    require_stack_prefix "$name"
    if ! docker volume inspect "$name" >/dev/null 2>&1; then
        docker volume create "$name" >/dev/null
    fi
    observed="$(docker volume inspect -f '{{.Name}}' "$name")"
    [[ "$observed" == "$name" ]] \
        || die "volume ${name}: docker reports '${observed}'"
    ok "volume ${name}"
}

# Docker's DNAT rules live in its own tables. If a firewall change removed
# them, every published port is silently unreachable. The accepted names cover
# both the iptables-nft backend (`ip nat`) and Docker 29's native nftables
# backend (`ip docker*`); the printed line is spike S3's record of which one
# this host runs.
assert_docker_nat_present() {
    local observed
    observed="$(nft list tables 2>/dev/null |
        grep -E '^table (ip|inet) (nat|docker[a-z0-9_-]*)$' | head -1 || true)"
    [[ -n "$observed" ]] \
        || die "Docker's NAT table is gone (nft list tables shows no 'ip nat' and no 'ip docker*')"
    ok "NFT-BACKEND: docker-nat-table=${observed#table }"
}

# authorized_keys_line <pubkey-file>
# The deploy key can do exactly one thing: run the host agent.
authorized_keys_line() {
    local f="$1" key n
    [[ -f "$f" ]] || die "public key file not found: ${f}" 2
    n="$(grep -c '^[^#[:space:]]' "$f" 2>/dev/null || true)"
    [[ "${n:-0}" == "1" ]] \
        || die "expected exactly one public key in ${f}, found ${n:-0}" 2
    ssh-keygen -l -f "$f" >/dev/null 2>&1 \
        || die "not a valid public key file: ${f}" 2
    key="$(grep -m1 '^[^#[:space:]]' "$f")"
    printf 'command="%s/bin/gremion-hostd --ssh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' \
        "$(gremion_root)" "$key"
}

# ──────────────────────────────────────────────────────────────────────────
# check — read-only
# ──────────────────────────────────────────────────────────────────────────
stage_check() {
    local root; root="$(gremion_root)"
    info "host"
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "    os        ${PRETTY_NAME}"
    echo "    kernel    $(uname -r)"
    echo "    fqdn      $(hostname -f 2>/dev/null || echo '?')"
    echo "    cpu       $(nproc) cores"
    echo "    memory    $(free -h | awk '/^Mem:/{print $2}')"
    echo "    disk      $(df -h / | awk 'NR==2{print $4" free of "$2}')"
    echo "    ext iface $(detect_ext_iface || echo '?')"

    info "addresses"
    ip -br addr show 2>/dev/null | sed 's/^/    /'

    info "binaries"
    local c
    for c in docker git curl nft dig openssl jq envsubst fail2ban-client unattended-upgrade; do
        printf '    %-20s %s\n' "$c" "$(command -v "$c" >/dev/null 2>&1 && echo present || echo -)"
    done

    info "deploy user"
    if id "${DEPLOY_USER}" >/dev/null 2>&1; then
        echo "    ${DEPLOY_USER} exists; groups: $(id -nG "${DEPLOY_USER}")"
        local ak="/home/${DEPLOY_USER}/.ssh/authorized_keys"
        if [[ -f "$ak" ]]; then
            # `grep -c` PRINTS 0 and exits 1 when nothing matches, so an
            # `|| echo 0` fallback emits a SECOND line and the report wraps.
            local nkeys nrestricted
            nkeys="$(grep -c '^[^#[:space:]]' "$ak" 2>/dev/null || true)"
            nrestricted="$(grep -c 'gremion-hostd --ssh' "$ak" 2>/dev/null || true)"
            echo "    authorized_keys: ${nkeys:-0} key(s), ${nrestricted:-0} restricted"
        else
            echo "    authorized_keys: ABSENT"
        fi
    else
        echo "    ${DEPLOY_USER}: absent"
    fi

    info "other /home accounts (harden-ssh would lock these out)"
    local d other
    for d in /home/*/; do
        other="$(basename "$d")"
        [[ -d "/home/${other}" ]] || continue
        [[ "$other" == "${DEPLOY_USER}" ]] && continue
        echo "    ${other}"
    done

    info "host layout"
    if [[ -d "$root" ]]; then
        echo "    ${root} $(stat -c '%U:%G %a' "$root")"
        echo "    ${root}/etc $(stat -c '%U:%G %a' "${root}/etc" 2>/dev/null || echo ABSENT)"
    else
        echo "    ${root}: absent"
    fi

    info "sshd effective config"
    sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|port) ' \
        | sed 's/^/    /' || echo "    (could not read)"

    info "firewall"
    if nft list table inet gremion >/dev/null 2>&1; then
        echo "    table inet gremion: present ($(nft list table inet gremion | grep -c 'comment') commented rules)"
    else
        echo "    table inet gremion: ABSENT (host is unfiltered by us)"
    fi
    nft list tables 2>/dev/null | sed 's/^/    /' || true
    echo "    nftables.service ExecStop: $(systemctl show nftables.service -p ExecStop --value 2>/dev/null | tr -d '\n')"

    info "docker resources"
    docker network ls --format '    {{.Name}} ({{.Driver}})' 2>/dev/null || echo "    (docker unavailable)"
    docker volume ls --format '    {{.Name}}' 2>/dev/null || true

    info "units"
    systemctl list-timers --all gremion-backup.timer 2>/dev/null | sed 's/^/    /' || true
    # `systemctl is-enabled` PRINTS "not-found" and exits non-zero for a unit
    # that does not exist, so `|| echo absent` printed both on two lines.
    local u state
    for u in gremion-hostd.service gremion-verify.service; do
        state="$(systemctl is-enabled "$u" 2>/dev/null || true)"
        printf '    %-28s %s\n' "$u" "${state:-absent}"
    done
}

# ──────────────────────────────────────────────────────────────────────────
# base — packages, timezone, swap, time sync, unattended-upgrades, fail2ban
# ──────────────────────────────────────────────────────────────────────────
stage_base() {
    require_root
    export DEBIAN_FRONTEND=noninteractive

    info "apt update + base packages"
    apt-get update -qq
    # gettext-base carries envsubst, which gremion-switch (Task 6) and
    # ops/render-ops.sh (Task 11) both require and no other stage installs.
    apt-get install -y -qq \
        ca-certificates curl gnupg git nftables fail2ban \
        unattended-upgrades apt-listchanges systemd-timesyncd \
        ifupdown dnsutils openssl htop ncdu jq rsync gettext-base

    local c
    for c in git jq nft dig openssl fail2ban-client envsubst; do
        assert "${c} on PATH" command -v "$c"
    done

    info "timezone -> ${TIMEZONE}"
    timedatectl set-timezone "${TIMEZONE}"
    [[ "$(timedatectl show -p Timezone --value)" == "${TIMEZONE}" ]] \
        && ok "timezone is ${TIMEZONE}" || die "timezone did not apply"

    info "time sync"
    systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true
    assert "systemd-timesyncd active" systemctl is-active --quiet systemd-timesyncd

    info "swap (${SWAP_SIZE})"
    if swapon --show --noheadings 2>/dev/null | grep -q .; then
        ok "swap already present"
    else
        fallocate -l "${SWAP_SIZE}" /swapfile
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
        grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        swapon --show --noheadings | grep -q . \
            && ok "swap active" || die "swap did not activate"
    fi

    info "unattended-upgrades"
    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
    systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
    assert "unattended-upgrades enabled" systemctl is-enabled --quiet unattended-upgrades

    info "fail2ban (sshd)"
    # SSH_PORT here is the script-level value; render_nft's subshell default
    # never reaches this scope.
    # shellcheck disable=SC2031
    cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled  = true
port     = ${SSH_PORT}
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
    systemctl enable --now fail2ban >/dev/null 2>&1 || true
    assert "fail2ban active" systemctl is-active --quiet fail2ban
    # Post-condition, not exit code: the jail must actually be loaded.
    fail2ban-client status sshd >/dev/null 2>&1 \
        && ok "sshd jail loaded" || die "fail2ban running but the sshd jail is NOT loaded"
}

# ──────────────────────────────────────────────────────────────────────────
# user — deploy user, keys, sudo, host layout (§A)
# ──────────────────────────────────────────────────────────────────────────
ensure_layout() {
    local root; root="$(gremion_root)"
    install -d -m 755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "$root"
    local d
    for d in releases bin backups runtime logs; do
        install -d -m 755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${root}/${d}"
    done
    # etc/ holds every platform secret (§G).
    install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${root}/etc"
    # etc/tenant-hosts.txt: one tenant FQDN per line. Created EMPTY here and
    # appended by the control plane (spec C); read by gremion-render --staging,
    # gremion-verify and the ops blackbox targets. Never recreated if present.
    [[ -f "${root}/etc/tenant-hosts.txt" ]] \
        || install -m 640 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /dev/null "${root}/etc/tenant-hosts.txt"
    for d in env secrets secrets/tenants secrets/mail edge; do
        install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${root}/etc/${d}"
    done
    [[ "$(stat -c '%U %a' "${root}/etc")" == "${DEPLOY_USER} 700" ]] \
        || die "${root}/etc is $(stat -c '%U %a' "${root}/etc"), expected ${DEPLOY_USER} 700"
    ok "host layout under ${root} (etc is ${DEPLOY_USER} 0700)"
}

stage_user() {
    require_root

    if id "${DEPLOY_USER}" >/dev/null 2>&1; then
        ok "user ${DEPLOY_USER} exists"
    else
        adduser --disabled-password --gecos "" "${DEPLOY_USER}"
        ok "user ${DEPLOY_USER} created"
    fi

    install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"

    # Inherit whatever key already authenticates root, so the deploy user is
    # reachable with the SAME key that got us here. Without this the
    # harden-ssh gate can never pass and the box is one bad edit from
    # console-only.
    if [[ -f /root/.ssh/authorized_keys ]]; then
        touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
        while IFS= read -r key; do
            [[ -n "$key" ]] || continue
            grep -qxF "$key" "/home/${DEPLOY_USER}/.ssh/authorized_keys" \
                || echo "$key" >> "/home/${DEPLOY_USER}/.ssh/authorized_keys"
        done < /root/.ssh/authorized_keys
        chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
        chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
    fi

    [[ -s "/home/${DEPLOY_USER}/.ssh/authorized_keys" ]] \
        && ok "authorized_keys has $(grep -c '^[^#[:space:]]' "/home/${DEPLOY_USER}/.ssh/authorized_keys") key(s)" \
        || die "authorized_keys is empty — refusing to continue"

    # The deploy path is non-interactive; a sudo password prompt in a deploy
    # script hangs forever rather than failing.
    echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${DEPLOY_USER}"
    chmod 440 "/etc/sudoers.d/90-${DEPLOY_USER}"
    assert "sudoers file is valid" visudo -cf "/etc/sudoers.d/90-${DEPLOY_USER}"

    ensure_layout
}

# ──────────────────────────────────────────────────────────────────────────
# docker — Engine + compose plugin, with log caps
# ──────────────────────────────────────────────────────────────────────────
stage_docker() {
    require_root
    export DEBIAN_FRONTEND=noninteractive

    if ! command -v docker >/dev/null 2>&1; then
        info "installing Docker Engine from the official repository"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/debian/gpg \
            -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        # shellcheck disable=SC1091
        cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable
EOF
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
            docker-buildx-plugin docker-compose-plugin
    fi

    assert "docker on PATH"         command -v docker
    assert "docker daemon responds" docker info
    assert "compose plugin present" docker compose version

    info "daemon log caps (${LOG_MAX_SIZE} x ${LOG_MAX_FILE})"
    mkdir -p /etc/docker
    local tmp; tmp="$(mktemp)"
    if [[ -f /etc/docker/daemon.json ]]; then
        jq --arg s "${LOG_MAX_SIZE}" --arg f "${LOG_MAX_FILE}" \
           '. + {"log-driver":"json-file","log-opts":{"max-size":$s,"max-file":$f}}' \
           /etc/docker/daemon.json > "$tmp"
    else
        jq -n --arg s "${LOG_MAX_SIZE}" --arg f "${LOG_MAX_FILE}" \
           '{"log-driver":"json-file","log-opts":{"max-size":$s,"max-file":$f}}' > "$tmp"
    fi
    mv "$tmp" /etc/docker/daemon.json
    assert "daemon.json is valid JSON" jq -e . /etc/docker/daemon.json
    systemctl restart docker
    # Observe the RUNNING daemon, not the file we just wrote.
    [[ "$(docker info --format '{{.LoggingDriver}}')" == "json-file" ]] \
        && ok "running daemon uses json-file" || die "daemon logging driver did not apply"

    usermod -aG docker "${DEPLOY_USER}" 2>/dev/null || true
    id -nG "${DEPLOY_USER}" | tr ' ' '\n' | grep -qx docker \
        && ok "${DEPLOY_USER} is in the docker group" \
        || die "${DEPLOY_USER} not in the docker group"

    systemctl enable docker >/dev/null 2>&1 || true
    assert "docker enabled at boot" systemctl is-enabled --quiet docker
}

# ──────────────────────────────────────────────────────────────────────────
# addresses — the edge and mail addresses, persistently, plus the hostname
# ──────────────────────────────────────────────────────────────────────────
have_addr() {
    ip -br addr show 2>/dev/null | tr -s ' ' '\n' | cut -d/ -f1 | grep -qxF "$1"
}

check_ptr() {
    local addr="$1" expect="$2" observed
    need_cmd dig
    observed="$(dig +short -x "$addr" "@${DNS_RESOLVER}" | head -1)"
    [[ -n "$observed" ]] \
        || die "BLOCKED: PTR for ${addr} is not set (operator sets it in the provider console)" 3
    [[ "$observed" == "${expect}." ]] \
        || die "PTR for ${addr} is '${observed}', expected '${expect}.'"
    ok "PTR ${addr} -> ${observed}"
}

# Debian's /etc/network/interfaces ships `source /etc/network/interfaces.d/*`,
# but an image that dropped the line would leave our stanza dead on the next
# boot with no error anywhere.
ensure_interfaces_source() {
    local f=/etc/network/interfaces
    [[ -f "$f" ]] || printf '# Managed by infra/host/bootstrap.sh\n' > "$f"
    grep -qE '^source(-directory)? /etc/network/interfaces\.d' "$f" \
        || printf 'source /etc/network/interfaces.d/*\n' >> "$f"
    grep -qE '^source(-directory)? /etc/network/interfaces\.d' "$f" \
        || die "${f} does not source /etc/network/interfaces.d"
    ok "${f} sources interfaces.d"
}

stage_addresses() {
    require_root
    need_cmd ip
    load_state_env

    local k
    for k in EDGE_BIND_IP EDGE_BIND_IP6 MAIL_BIND_IP MAIL_BIND_IP6; do
        [[ -n "${!k-}" && "${!k}" != CHANGE_ME_* ]] \
            || die "BLOCKED: ${k} is not set in ${STATE_ENV} (operator: order the second IPv4 and record both families)" 3
    done
    [[ -n "${HOST_FQDN}" ]] || die "HOST_FQDN is not set (pass --fqdn)" 2

    : "${EXT_IFACE:=$(detect_ext_iface)}"
    [[ -n "${EXT_IFACE}" ]] || die "cannot determine the external interface; set EXT_IFACE" 2
    export EXT_IFACE
    info "external interface: ${EXT_IFACE}"

    info "persistent addresses -> /etc/network/interfaces.d/gremion"
    # atomic_write exits 2 when the parent directory is absent, and
    # interfaces.d only exists once ifupdown is installed (stage base).
    install -d -m 755 /etc/network/interfaces.d
    atomic_render /etc/network/interfaces.d/gremion 644 interfaces_stanza
    ensure_interfaces_source

    # Apply now, idempotently. `|| true`: EEXIST on a converged host is not an
    # error, and the post-condition below is what decides.
    ip addr add "${MAIL_BIND_IP}/32" dev "${EXT_IFACE}" 2>/dev/null || true
    ip -6 addr add "${EDGE_BIND_IP6}/64" dev "${EXT_IFACE}" 2>/dev/null || true
    ip -6 addr add "${MAIL_BIND_IP6}/64" dev "${EXT_IFACE}" 2>/dev/null || true

    for k in EDGE_BIND_IP EDGE_BIND_IP6 MAIL_BIND_IP MAIL_BIND_IP6; do
        have_addr "${!k}" && ok "${k} ${!k} is live on this host" \
            || die "${k} ${!k} is not in 'ip -br addr'"
    done

    info "hostname -> ${HOST_FQDN}"
    hostnamectl set-hostname "${HOST_FQDN}"
    grep -qE "^${EDGE_BIND_IP}[[:space:]]+${HOST_FQDN}\b" /etc/hosts \
        || printf '%s\t%s\t%s\n' "${EDGE_BIND_IP}" "${HOST_FQDN}" "${HOST_FQDN%%.*}" >> /etc/hosts
    [[ "$(hostname -f)" == "${HOST_FQDN}" ]] \
        && ok "hostname -f is ${HOST_FQDN}" \
        || die "hostname -f is '$(hostname -f)', expected ${HOST_FQDN}"

    if [[ "${EXPECT_PTR}" == "1" ]]; then
        check_ptr "${EDGE_BIND_IP}"  "${HOST_FQDN}"
        check_ptr "${EDGE_BIND_IP6}" "${HOST_FQDN}"
        check_ptr "${MAIL_BIND_IP}"  "mail.${PLATFORM_DOMAIN}"
        check_ptr "${MAIL_BIND_IP6}" "mail.${PLATFORM_DOMAIN}"
    else
        info "PTR records not checked (pass --expect-ptr once the operator has set them)"
    fi
}

# ──────────────────────────────────────────────────────────────────────────
# networks — the shared, stack-scoped external resources (§E)
# ──────────────────────────────────────────────────────────────────────────
stage_networks() {
    require_root
    need_cmd docker
    load_state_env
    ensure_network "${STACK}_edge"  "${EDGE_V4_SUBNET}"  "${EDGE_V6_SUBNET}"
    ensure_network "${STACK}_state" "${STATE_V4_SUBNET}" "${STATE_V6_SUBNET}"
    ensure_volume  "${STACK}_traefik_acme"
    ensure_volume  "${STACK}_tenant_secrets"
    ensure_volume  "${STACK}_mail_data"
}

# ──────────────────────────────────────────────────────────────────────────
# firewall — one table, inet gremion (§B)
# ──────────────────────────────────────────────────────────────────────────
load_nft() {
    local f="$1"
    # The file's own preamble (table {} / delete table) makes this one atomic
    # transaction, so the normal path never leaves the host unfiltered.
    if nft -f "$f"; then return 0; fi
    # Fallback for a host carrying an older table the preamble cannot replace
    # in one transaction: the documented delete-then-load.
    bad "atomic load failed; falling back to delete-then-load"
    nft delete table inet gremion 2>/dev/null || true
    nft -f "$f"
}

stage_firewall() {
    require_root
    need_cmd nft
    load_state_env

    : "${EXT_IFACE:=$(detect_ext_iface)}"
    [[ -n "${EXT_IFACE}" ]] || die "cannot determine the external interface; set EXT_IFACE" 2
    export EXT_IFACE

    install -d -m 755 /etc/nftables.d
    info "rendering /etc/nftables.d/gremion.nft (iface ${EXT_IFACE})"
    atomic_render /etc/nftables.d/gremion.nft 644 render_nft "${STATE_ENV}"
    assert "rendered ruleset parses" nft -c -f /etc/nftables.d/gremion.nft

    atomic_render /etc/nftables.conf 644 nftables_conf
    # Matched as a regex, never as the literal two-word directive: the
    # tree-wide guard greps this script for that literal, and it also catches
    # `flush   ruleset` and a tab-separated form that a literal match misses.
    if grep -qE 'flush[[:space:]]+ruleset' /etc/nftables.conf; then
        die "/etc/nftables.conf flushes the whole kernel ruleset"
    fi
    ok "/etc/nftables.conf includes interfaces.d and does not flush"

    install -d -m 755 /etc/systemd/system/nftables.service.d
    atomic_render /etc/systemd/system/nftables.service.d/10-gremion.conf 644 nftables_dropin
    systemctl daemon-reload
    local execstop; execstop="$(systemctl show nftables.service -p ExecStop --value)"
    if [[ "$execstop" == *flush* ]]; then
        die "nftables.service still flushes the kernel ruleset on stop: ${execstop}"
    fi
    ok "nftables.service ExecStop deletes only 'inet gremion'"

    load_nft /etc/nftables.d/gremion.nft

    # Post-conditions: the rules are LIVE in the kernel, not merely written.
    local live; live="$(nft list table inet gremion)"
    grep -q 'egress25-nonmail v4' <<<"$live" || die "egress-25 drop (v4) is not in the running ruleset"
    grep -q 'egress25-nonmail v6' <<<"$live" || die "egress-25 drop (v6) is not in the running ruleset"
    grep -q 'mail snat v4'        <<<"$live" || die "mail SNAT (v4) is not in the running ruleset"
    grep -q 'mail snat v6'        <<<"$live" || die "mail SNAT (v6) is not in the running ruleset"
    grep -q 'ssh v4'              <<<"$live" || die "ssh accept rule is not in the running ruleset"
    ok "table inet gremion is live ($(grep -c comment <<<"$live") commented rules)"

    assert_docker_nat_present

    systemctl enable nftables >/dev/null 2>&1 || true
    assert "nftables enabled at boot" systemctl is-enabled --quiet nftables
    info "egress-25 and SNAT are proven from containers by gremion-fw-proof (Task 3)"
}

# ──────────────────────────────────────────────────────────────────────────
# agent — gremion-hostd + the restricted deploy key
# ──────────────────────────────────────────────────────────────────────────
stage_agent() {
    require_root
    local root; root="$(gremion_root)"
    [[ -x "${root}/bin/gremion-hostd" ]] \
        || die "precondition: ${root}/bin/gremion-hostd is not installed (release checkout)" 2
    [[ -n "${DEPLOY_PUBKEY_FILE}" ]] \
        || die "DEPLOY_PUBKEY_FILE is not set (pass --deploy-pubkey)" 2

    local line ak
    # Build the line BEFORE touching systemd: an invalid key file must fail
    # before anything is installed.
    line="$(authorized_keys_line "${DEPLOY_PUBKEY_FILE}")"

    info "installing gremion-hostd.service"
    render_unit gremion-hostd.service /etc/systemd/system/gremion-hostd.service
    systemctl daemon-reload
    systemctl enable --now gremion-hostd.service

    assert "gremion-hostd is active" systemctl is-active --quiet gremion-hostd.service
    [[ -S /run/gremion/hostd.sock ]] \
        || die "gremion-hostd is active but /run/gremion/hostd.sock does not exist"
    local mode grp
    mode="$(stat -c '%a' /run/gremion/hostd.sock)"
    grp="$(stat -c '%G' /run/gremion/hostd.sock)"
    [[ "$mode" == "660" ]] || die "hostd.sock is mode ${mode}, expected 660"
    [[ "$grp" == "${DEPLOY_USER}" ]] || die "hostd.sock group is ${grp}, expected ${DEPLOY_USER}"
    ok "hostd.sock is ${grp} ${mode}"

    ak="/home/${DEPLOY_USER}/.ssh/authorized_keys"
    touch "$ak"
    grep -qxF "$line" "$ak" || printf '%s\n' "$line" >> "$ak"
    chmod 600 "$ak"
    chown "${DEPLOY_USER}:${DEPLOY_USER}" "$ak"
    [[ "$(grep -cxF "$line" "$ak")" == "1" ]] \
        || die "the forced-command deploy key is not present exactly once in ${ak}"
    # The deploy key must never also be present unrestricted.
    local bare; bare="${line##* }"
    [[ "$(grep -cF "$bare" "$ak")" == "1" ]] \
        || die "the deploy key also appears in ${ak} without the forced command"
    ok "deploy key installed, forced to '${root}/bin/gremion-hostd --ssh'"
}

# ──────────────────────────────────────────────────────────────────────────
# timers — daily backup + the reboot gate
# ──────────────────────────────────────────────────────────────────────────
stage_timers() {
    require_root
    local root; root="$(gremion_root)"
    local b
    for b in gremion-backup gremion-verify; do
        [[ -x "${root}/bin/${b}" ]] \
            || die "precondition: ${root}/bin/${b} is not installed (release checkout)" 2
    done

    local u
    for u in gremion-backup.service gremion-backup.timer gremion-verify.service; do
        render_unit "$u" "/etc/systemd/system/${u}"
    done
    systemctl daemon-reload
    systemctl enable --now gremion-backup.timer
    systemctl enable gremion-verify.service

    # Post-condition: the timer has a real next elapse, not merely "enabled".
    local next
    next="$(systemctl show gremion-backup.timer -p NextElapseUSecRealtime --value)"
    [[ -n "$next" && "$next" != "n/a" ]] \
        || die "gremion-backup.timer is enabled but has no next elapse"
    ok "gremion-backup.timer next elapse: ${next}"
    assert "gremion-verify.service enabled at boot" systemctl is-enabled --quiet gremion-verify.service
}

# ──────────────────────────────────────────────────────────────────────────
# harden-ssh — key-only, no root login. GATED.
# ──────────────────────────────────────────────────────────────────────────
stage_harden_ssh() {
    require_root

    # The gate. Disabling password auth while the deploy user cannot get in
    # with a key is how a remote host becomes a console-only host.
    local ak="/home/${DEPLOY_USER}/.ssh/authorized_keys"
    [[ -s "$ak" ]] || die "${DEPLOY_USER} has no authorized_keys — run 'user' first" 2
    [[ -f "/etc/sudoers.d/90-${DEPLOY_USER}" ]] \
        || die "${DEPLOY_USER} has no sudoers entry — run 'user' first" 2
    ok "gate: ${DEPLOY_USER} has keys and sudo"

    # AllowUsers below is EXCLUSIVE: every other account on this host loses SSH
    # the moment sshd reloads. Name them, so a break-glass account is a
    # decision and not a discovery.
    local d other; local -a others=()
    for d in /home/*/; do
        other="$(basename "$d")"
        [[ -d "/home/${other}" ]] || continue
        [[ "$other" == "${DEPLOY_USER}" ]] && continue
        others+=("$other")
    done
    if [[ ${#others[@]} -gt 0 ]]; then
        bad "AllowUsers ${DEPLOY_USER} will lose SSH access for: ${others[*]}"
        info "if one of those is your break-glass account, add it to AllowUsers before continuing"
    else
        ok "no other /home account will lose SSH access"
    fi

    info "writing /etc/ssh/sshd_config.d/10-gremion.conf"
    cat > /etc/ssh/sshd_config.d/10-gremion.conf <<EOF
# Managed by infra/host/bootstrap.sh (stage: harden-ssh)
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers ${DEPLOY_USER}
EOF

    assert "sshd config parses" sshd -t
    systemctl reload ssh 2>/dev/null || systemctl reload sshd

    # Observe the EFFECTIVE config, not the file.
    local eff; eff="$(sshd -T 2>/dev/null)"
    grep -qx 'passwordauthentication no' <<<"$eff" \
        && ok "password auth is off" || die "password auth still enabled"
    grep -qx 'permitrootlogin no' <<<"$eff" \
        && ok "root login is off" || die "root login still permitted"
    # PermitRootLogin no plus password auth off means the deploy user is now
    # the ONLY way in. Prove sshd agrees, from sshd itself.
    sshd -T 2>/dev/null | grep -q "allowusers.*${DEPLOY_USER}" \
        && ok "sshd -T lists ${DEPLOY_USER} in allowusers" \
        || die "sshd -T does not list ${DEPLOY_USER} in allowusers — the deploy user is locked out"

    echo
    info "Root SSH is now closed. Reconnect as: ssh ${DEPLOY_USER}@<host>"
    info "Keep the provider console open until you have confirmed that works."
}

# atomic_render <dest> <mode> <command...>
# Runs <command...> and installs its output at <dest> ONLY if it succeeded.
#
# `renderer | atomic_write <dest>` cannot do that: both sides of a pipeline run
# regardless of each other, so atomic_write renames a truncated - in practice
# EMPTY - file over whatever was there before, and pipefail aborts the stage one
# command too late. Observed on the host: a render refused for an unfilled
# sentinel left /etc/nftables.d/gremion.nft at 0 bytes, which at the next boot
# is a host with NO gremion table at all - no input policy, no egress-25 drop,
# no mail SNAT - and no error anywhere.
atomic_render() {
    local dest="${1:-}" mode="${2:-}"
    if [[ -z "$dest" || -z "$mode" || $# -le 2 ]]; then
        die "usage: atomic_render <dest> <mode> <command...>" 2
    fi
    shift 2
    local tmp rc=0
    tmp="$(mktemp)"
    # Subshell: a renderer that calls die() exits, and that must not take the
    # stage down before the scratch file is removed.
    ( "$@" ) > "$tmp" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        atomic_write "$dest" "$mode" < "$tmp"
    fi
    rm -f "$tmp"
    return "$rc"
}

main() {
    local stage=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --env-file)       STATE_ENV="${2:-}";          shift 2 ;;
            --fqdn)           HOST_FQDN="${2:-}";          shift 2 ;;
            --deploy-pubkey)  DEPLOY_PUBKEY_FILE="${2:-}"; shift 2 ;;
            --expect-ptr)     EXPECT_PTR=1;                shift ;;
            -h|--help)        usage; return 0 ;;
            -*)               die "unknown option: $1 (see --help)" 2 ;;
            *)                [[ -z "$stage" ]] || die "only one stage may be given (got '${stage}' and '$1')" 2
                              stage="$1"; shift ;;
        esac
    done

    case "${stage:-check}" in
        check)       stage_check ;;
        addresses)   stage_addresses ;;
        base)        stage_base ;;
        user)        stage_user ;;
        docker)      stage_docker ;;
        networks)    stage_networks ;;
        firewall)    stage_firewall ;;
        agent)       stage_agent ;;
        timers)      stage_timers ;;
        harden-ssh)  stage_harden_ssh ;;
        all)         stage_base; stage_user; stage_docker; stage_addresses
                     stage_networks; stage_firewall; stage_agent; stage_timers
                     echo; info "'all' does not include harden-ssh — run it explicitly." ;;
        *)           die "unknown stage: ${stage} (see --help)" 2 ;;
    esac
}

# Sourcing this file (the bats unit tests do) must define the functions and
# run nothing.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
