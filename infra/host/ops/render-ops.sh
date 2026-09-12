#!/usr/bin/env bash
# Render the host-owned files the ${STACK}-ops project mounts: the Alertmanager
# config and the Prometheus file-SD target lists. Prometheus does not read the
# environment, so this is where PLATFORM_DOMAIN, EDGE_BIND_IP and the tenant
# host list become targets. Re-run it after every tenant change; file SD is
# watched, so no container needs a reload.
#
# usage: render-ops.sh [--env-file FILE] [--tenant-hosts FILE]
# exit 0 rendered · 1 post-condition failed · 2 usage/precondition · 3 blocked on an operator step
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

usage() {
    cat >&2 <<'USAGE'
usage: render-ops.sh [--env-file FILE] [--tenant-hosts FILE]
  --env-file      default: <gremion root>/etc/env/ops.env
  --tenant-hosts  default: $OPS_TENANT_HOSTS_FILE, else <gremion root>/etc/tenant-hosts.txt
USAGE
    exit 2
}

# A trailing "--env-file" with no value must not quietly render the default
# file: "${2:-}" would leave the variable empty and the next line would hide
# the operator's mistake behind a plausible result.
need_value() {
    [[ "$2" -ge 2 ]] || { bad "$1 requires a value"; usage; }
}

ENV_FILE=""
TENANT_HOSTS_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file)     need_value --env-file "$#";     ENV_FILE="$2";         shift 2 ;;
        --tenant-hosts) need_value --tenant-hosts "$#"; TENANT_HOSTS_ARG="$2"; shift 2 ;;
        -h|--help)      usage ;;
        *)              bad "unknown argument: $1"; usage ;;
    esac
done

ROOT="$(gremion_root)"
ENV_FILE="${ENV_FILE:-$ROOT/etc/env/ops.env}"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE" 2
need_cmd envsubst id grep tr

# The Stalwart app password legitimately still carries its CHANGE_ME_ sentinel
# before the mail bring-up, and this script's job is to say so precisely
# (exit 3), not to be stopped by load_env's blanket sentinel check. load_env's
# duplicate-key refusal (exit 2) still applies and is not suppressed.
ALLOW_SENTINELS=1 load_env "$ENV_FILE"

require_var() {
    local name="$1"
    [[ -n "${!name:-}" ]] || die "$name is empty in $ENV_FILE" 2
}
for v in PLATFORM_DOMAIN EDGE_BIND_IP OPS_BIND_IP OPS_UID OPS_GID GREMION_ROOT_DIR \
         ALERT_WEBHOOK_URL ALERT_EMAIL_FROM ALERT_SMTP_USER; do
    require_var "$v"
done

case "$OPS_BIND_IP" in
    0.0.0.0 | :: | "*")
        die "OPS_BIND_IP must be a concrete address, never a wildcard (got '$OPS_BIND_IP')" 2
        ;;
esac
[[ "$(id -u)" == "$OPS_UID" ]] \
    || die "OPS_UID=$OPS_UID but this process runs as $(id -u); set OPS_UID=$(id -u) in $ENV_FILE" 2
[[ "$(id -g)" == "$OPS_GID" ]] \
    || die "OPS_GID=$OPS_GID but this process runs as $(id -g); set OPS_GID=$(id -g) in $ENV_FILE" 2

TENANT_HOSTS="${TENANT_HOSTS_ARG:-${OPS_TENANT_HOSTS_FILE:-$ROOT/etc/tenant-hosts.txt}}"
TARGETS_DIR="$ROOT/runtime/ops/targets"
SECRETS_DIR="$ROOT/etc/secrets/ops"
AM_FILE="$ROOT/runtime/ops/alertmanager.yml"
TARGET_COUNT=0
EMAIL_STATE="off"
STALWART_KEY_STATE="unset"

mkdir -p "$TARGETS_DIR" \
         "$ROOT/runtime/ops/prometheus-data" \
         "$ROOT/runtime/ops/alertmanager-data" \
         "$ROOT/runtime/textfile"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

write_targets() {
    local file="$1"; shift
    [[ $# -gt 0 ]] || die "refusing to write an empty target list: $file" 1
    {
        printf -- '- targets:\n'
        local t
        for t in "$@"; do printf -- '    - "%s"\n' "$t"; done
    } | atomic_write "$TARGETS_DIR/$file" 0644
    TARGET_COUNT=$((TARGET_COUNT + $#))
}

read_tenant_hosts() {
    [[ -f "$TENANT_HOSTS" ]] \
        || { bad "no tenant host list at $TENANT_HOSTS — platform hosts only"; return 0; }
    grep -vE '^[[:space:]]*(#|$)' "$TENANT_HOSTS" | tr -d '\r'
}

# PLATFORM_DOMAIN, EDGE_BIND_IP and EDGE_BIND_IP6 are exported by load_env
# above, not assigned in this file.
# shellcheck disable=SC2153
render_targets() {
    local https_targets=("https://${PLATFORM_DOMAIN}") host
    local acme_targets=()
    while IFS= read -r host; do
        [[ -n "$host" ]] || continue
        https_targets+=("https://${host}")
    done < <(read_tenant_hosts)
    write_targets blackbox-https.yml "${https_targets[@]}"
    write_targets blackbox-control.yml "https://control.${PLATFORM_DOMAIN}"

    acme_targets=("http://${EDGE_BIND_IP}:80/.well-known/acme-challenge/probe")
    # §C keeps :80 open on BOTH families for HTTP-01. An ACME probe that only
    # ever asked the v4 address would report green while v6 answered nothing.
    if [[ -n "${EDGE_BIND_IP6:-}" && "${EDGE_BIND_IP6}" != CHANGE_ME_* ]]; then
        acme_targets+=("http://[${EDGE_BIND_IP6}]:80/.well-known/acme-challenge/probe")
    fi
    write_targets blackbox-acme.yml "${acme_targets[@]}"

    write_targets blackbox-smtp.yml "mail.${PLATFORM_DOMAIN}:587"
    write_targets blackbox-smtp25.yml "mail.${PLATFORM_DOMAIN}:25"
    write_targets blackbox-tls.yml "mail.${PLATFORM_DOMAIN}:465" "mail.${PLATFORM_DOMAIN}:993"
    write_targets stalwart.yml "mail.${PLATFORM_DOMAIN}"
}

render_stalwart_key() {
    # STALWART_API_KEY is Task 1's ops.env key, sharing the stalwart_api
    # sentinel group with state.env and mail.env so all three carry one value.
    local key="${STALWART_API_KEY:-}"
    if [[ -z "$key" || "$key" == CHANGE_ME_* ]]; then
        key="unset"
        STALWART_KEY_STATE="unset"
    else
        STALWART_KEY_STATE="set"
    fi
    printf '%s\n' "$key" | atomic_write "$SECRETS_DIR/stalwart-api-key" 0600
}

render_alertmanager() {
    # ALERT_SMTP_PASSWORD is Task 1's ops.env key (sentinel group platform_smtp,
    # shared with mail.env). It is NOT called PLATFORM_SMTP_PASSWORD here.
    local email_to="${ALERT_EMAIL_TO:-}" password="${ALERT_SMTP_PASSWORD:-}"
    # A freshly rendered ops.env still carries ALERT_EMAIL_TO's operator
    # sentinel. "Not configured yet" is not "configured wrongly": rendering the
    # sentinel as a recipient would address mail to CHANGE_ME_…, and blocking on
    # the app password would stop a render nobody asked for e-mail in. The
    # printed email=off is what tells the operator it is not on.
    if [[ "$email_to" == CHANGE_ME_* ]]; then
        email_to=""
    fi
    if [[ -n "$email_to" ]]; then
        if [[ -z "$password" || "$password" == CHANGE_ME_* ]]; then
            die "BLOCKED: ALERT_SMTP_PASSWORD not provisioned (Stalwart app password, §I)" 3
        fi
        EMAIL_STATE="on"
    else
        password="unset"
        EMAIL_STATE="off"
    fi
    printf '%s\n' "$password" | atomic_write "$SECRETS_DIR/smtp-password" 0600

    {
        # tr -d: Git for Windows ships an envsubst that writes CRLF (measured:
        # /mingw64/bin/envsubst turns "a: 1\n" into "a: 1\r\n") and amtool
        # rejected the result. Debian's writes LF, so this is a no-op there and
        # the difference never becomes a Windows-only broken config.
        # The SHELL-FORMAT argument is a literal list of names envsubst is
        # allowed to substitute; expanding it here would pass their values.
        # shellcheck disable=SC2016
        envsubst '${PLATFORM_DOMAIN} ${ALERT_EMAIL_FROM} ${ALERT_SMTP_USER} ${ALERT_WEBHOOK_URL}' \
            < "$SCRIPT_DIR/alertmanager.yml.tmpl" | tr -d '\r'
        # email_configs is a sibling of webhook_configs, i.e. a key of the
        # receiver mapping: four spaces, not six. Six made amtool refuse the
        # file with "did not find expected '-' indicator".
        if [[ "$EMAIL_STATE" == "on" ]]; then
            printf '    email_configs:\n'
            printf "      - to: '%s'\n" "$email_to"
            printf '        send_resolved: true\n'
            printf '        require_tls: true\n'
        fi
    } | atomic_write "$AM_FILE" 0644
}

post_conditions() {
    local f
    for f in "$AM_FILE" "$SECRETS_DIR/smtp-password" "$SECRETS_DIR/stalwart-api-key" \
             "$TARGETS_DIR/blackbox-https.yml" "$TARGETS_DIR/blackbox-control.yml" \
             "$TARGETS_DIR/blackbox-acme.yml" "$TARGETS_DIR/blackbox-smtp.yml" \
             "$TARGETS_DIR/blackbox-smtp25.yml" "$TARGETS_DIR/blackbox-tls.yml" \
             "$TARGETS_DIR/stalwart.yml"; do
        [[ -f "$f" && ! -d "$f" && -s "$f" ]] \
            || die "post-condition failed, not a non-empty file: $f" 1
    done
    # Deliberately literal: the pattern searched for IS the two characters "${".
    # shellcheck disable=SC2016
    ! grep -q '\${' "$AM_FILE" \
        || die "post-condition failed, unsubstituted variable in $AM_FILE" 1
    # A carriage return here is not cosmetic: it lands inside the YAML value.
    ! grep -q $'\r' "$AM_FILE" \
        || die "post-condition failed, carriage returns in $AM_FILE" 1
}

main() {
    render_targets
    render_stalwart_key
    render_alertmanager
    post_conditions
    echo "OPS-RENDER: files=7 targets=${TARGET_COUNT} email=${EMAIL_STATE} stalwart-key=${STALWART_KEY_STATE}"
}

main "$@"
