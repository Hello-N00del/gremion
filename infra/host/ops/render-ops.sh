#!/usr/bin/env bash
# Render the host-owned files the ${STACK}-ops project (compose/observability/,
# TASK-039) mounts: the Prometheus file-SD target lists, the Grafana
# provisioning tree with its alert contact point, and the ops credential
# files. Prometheus and Grafana do not read ops.env, so this is where
# PLATFORM_DOMAIN, EDGE_BIND_IP, the tenant host list and the alert sinks
# become files. Re-run it after every tenant change; file SD is watched, so
# no container needs a reload (a contact-point change needs a Grafana restart).
#
# usage: render-ops.sh [--env-file FILE] [--tenant-hosts FILE]
# exit 0 rendered · 1 post-condition failed · 2 usage/precondition · 3 blocked on an operator step
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

# The release tree this script ships in: infra/host/ops -> <release>.
RELEASE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROVISIONING_SRC="$RELEASE_DIR/compose/observability/grafana/provisioning"

# R29-I6: no store of the ops project keeps anything longer than 30 days.
PROM_RETENTION_MAX_DAYS=30

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
need_cmd grep tr cp find

# The Stalwart app password legitimately still carries its CHANGE_ME_ sentinel
# before the mail bring-up, and this script's job is to say so precisely
# (exit 3), not to be stopped by load_env's blanket sentinel check. load_env's
# duplicate-key refusal (exit 2) still applies and is not suppressed.
ALLOW_SENTINELS=1 load_env "$ENV_FILE"

require_var() {
    local name="$1"
    [[ -n "${!name:-}" ]] || die "$name is empty in $ENV_FILE" 2
}
for v in PLATFORM_DOMAIN EDGE_BIND_IP OPS_BIND_IP OPS_INGEST_BIND_IP OPS_UID OPS_GID \
         GREMION_ROOT_DIR PROM_RETENTION_TIME ALERT_EMAIL_FROM ALERT_SMTP_USER; do
    require_var "$v"
done

for v in OPS_BIND_IP OPS_INGEST_BIND_IP; do
    case "${!v}" in
        0.0.0.0 | :: | "*")
            die "$v must be a concrete address, never a wildcard (got '${!v}')" 2
            ;;
    esac
done
[[ "$(id -u)" == "$OPS_UID" ]] \
    || die "OPS_UID=$OPS_UID but this process runs as $(id -u); set OPS_UID=$(id -u) in $ENV_FILE" 2
[[ "$(id -g)" == "$OPS_GID" ]] \
    || die "OPS_GID=$OPS_GID but this process runs as $(id -g); set OPS_GID=$(id -g) in $ENV_FILE" 2

# PROM_RETENTION_TIME: whole days or hours only, never above the ceiling.
if [[ "$PROM_RETENTION_TIME" =~ ^([0-9]+)d$ ]]; then
    (( BASH_REMATCH[1] <= PROM_RETENTION_MAX_DAYS )) \
        || die "PROM_RETENTION_TIME=$PROM_RETENTION_TIME exceeds the ${PROM_RETENTION_MAX_DAYS}-day ceiling [D R29-I6]" 2
elif [[ "$PROM_RETENTION_TIME" =~ ^([0-9]+)h$ ]]; then
    (( BASH_REMATCH[1] <= PROM_RETENTION_MAX_DAYS * 24 )) \
        || die "PROM_RETENTION_TIME=$PROM_RETENTION_TIME exceeds the ${PROM_RETENTION_MAX_DAYS}-day ceiling [D R29-I6]" 2
else
    die "PROM_RETENTION_TIME must be <N>d or <N>h (got '$PROM_RETENTION_TIME')" 2
fi

TENANT_HOSTS="${TENANT_HOSTS_ARG:-${OPS_TENANT_HOSTS_FILE:-$ROOT/etc/tenant-hosts.txt}}"
OPS_RUNTIME="$ROOT/runtime/ops"
TARGETS_DIR="$OPS_RUNTIME/targets"
PROVISIONING_DIR="$OPS_RUNTIME/grafana-provisioning"
SECRETS_DIR="$ROOT/etc/secrets/ops"
GRAFANA_SECRETS_DIR="$ROOT/etc/secrets/grafana"
CONTACT_FILE="$PROVISIONING_DIR/alerting/contact-points.yaml"
POLICY_FILE="$PROVISIONING_DIR/alerting/policies.yaml"
TARGET_COUNT=0
FILE_COUNT=0
EMAIL_STATE="off"
WEBHOOK_STATE="off"
STALWART_KEY_STATE="unset"
SSO_STATE="pending"

[[ -d "$PROVISIONING_SRC" ]] || die "the Grafana provisioning source is absent: $PROVISIONING_SRC" 2

# Every directory a bind mount of the ops project names. Created here, as the
# deploy user, so Docker never creates one root-owned on first start.
mkdir -p "$TARGETS_DIR" \
         "$OPS_RUNTIME/prometheus-data" \
         "$OPS_RUNTIME/grafana-data" \
         "$OPS_RUNTIME/grafana-logs" \
         "$OPS_RUNTIME/loki-data" \
         "$OPS_RUNTIME/tempo-data" \
         "$OPS_RUNTIME/alloy-data" \
         "$ROOT/runtime/textfile"
mkdir -p "$SECRETS_DIR" "$GRAFANA_SECRETS_DIR"
chmod 700 "$SECRETS_DIR" "$GRAFANA_SECRETS_DIR"

write_targets() {
    local file="$1"; shift
    [[ $# -gt 0 ]] || die "refusing to write an empty target list: $file" 1
    {
        printf -- '- targets:\n'
        local t
        for t in "$@"; do printf -- '    - "%s"\n' "$t"; done
    } | atomic_write "$TARGETS_DIR/$file" 0644
    TARGET_COUNT=$((TARGET_COUNT + $#))
    FILE_COUNT=$((FILE_COUNT + 1))
}

read_tenant_hosts() {
    [[ -f "$TENANT_HOSTS" ]] \
        || { bad "no tenant host list at $TENANT_HOSTS — platform hosts only"; return 0; }
    grep -vE '^[[:space:]]*(#|$)' "$TENANT_HOSTS" | tr -d '\r'
}

# PRD-DEP-002 (operator half): OPS_THIRD_PARTY_PROBES is a space-separated list
# of <service>=<url> pairs (nextcloud=https://cloud.example.org/status.php ...).
# Empty is legitimate (a host whose councils use none of them) and renders `[]`,
# which Prometheus' file SD reads as no targets.
render_third_party() {
    local entry name url entries=()
    # Split on whitespace on purpose: the value is a list (no glob: set -f).
    read -r -a entries <<< "${OPS_THIRD_PARTY_PROBES:-}"
    # Validated BEFORE anything is written: a die inside the pipeline below
    # would leave a half-written list behind.
    for entry in ${entries[@]+"${entries[@]}"}; do
        name="${entry%%=*}"
        url="${entry#*=}"
        [[ "$entry" == *=* && "$name" =~ ^[a-z0-9][a-z0-9-]*$ && "$url" =~ ^https?://[^[:space:]\"]+$ ]] \
            || die "OPS_THIRD_PARTY_PROBES entry '$entry' is not <service>=<http(s) url>" 2
    done
    {
        for entry in ${entries[@]+"${entries[@]}"}; do
            printf -- '- targets: ["%s"]\n  labels:\n    kind: third_party\n    service: %s\n' "${entry#*=}" "${entry%%=*}"
        done
        (( ${#entries[@]} > 0 )) || printf -- '[]\n'
    } | atomic_write "$TARGETS_DIR/blackbox-third-party.yml" 0644
    TARGET_COUNT=$((TARGET_COUNT + ${#entries[@]}))
    FILE_COUNT=$((FILE_COUNT + 1))
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
    # Section C keeps :80 open on BOTH families for HTTP-01. An ACME probe that
    # only ever asked the v4 address would report green while v6 answered nothing.
    if [[ -n "${EDGE_BIND_IP6:-}" && "${EDGE_BIND_IP6}" != CHANGE_ME_* ]]; then
        acme_targets+=("http://[${EDGE_BIND_IP6}]:80/.well-known/acme-challenge/probe")
    fi
    write_targets blackbox-acme.yml "${acme_targets[@]}"

    write_targets blackbox-smtp.yml "mail.${PLATFORM_DOMAIN}:587"
    write_targets blackbox-smtp25.yml "mail.${PLATFORM_DOMAIN}:25"
    write_targets blackbox-tls.yml "mail.${PLATFORM_DOMAIN}:465" "mail.${PLATFORM_DOMAIN}:993"
    write_targets stalwart.yml "mail.${PLATFORM_DOMAIN}"
    render_third_party
}

render_stalwart_key() {
    # STALWART_API_KEY is Task 1's ops.env key, sharing the stalwart_api
    # sentinel group with mail.env so both carry one value (TASK-015 removed
    # the reader-less copy from state.env).
    local key="${STALWART_API_KEY:-}"
    if [[ -z "$key" || "$key" == CHANGE_ME_* ]]; then
        key="unset"
        STALWART_KEY_STATE="unset"
    else
        STALWART_KEY_STATE="set"
    fi
    printf '%s\n' "$key" | atomic_write "$SECRETS_DIR/stalwart-api-key" 0600
}

# Q15: the OTLP ingest is never open. The token is a generated ops.env value
# (sentinel group otlp_ingest); an empty one, or one gremion-init-secrets never
# replaced, is refused. Written WITHOUT a trailing newline: Alloy compares the
# file's bytes with the bearer token a sender presents.
render_ingest_token() {
    local token="${OTLP_INGEST_TOKEN:-}"
    [[ -n "$token" && "$token" != CHANGE_ME_* ]] \
        || die "OTLP_INGEST_TOKEN is empty or still a sentinel in $ENV_FILE: the OTLP ingest would be open (run gremion-init-secrets)" 2
    [[ "${#token}" -ge 32 ]] || die "OTLP_INGEST_TOKEN is shorter than 32 characters" 2
    printf '%s' "$token" | atomic_write "$SECRETS_DIR/otlp-ingest-token" 0600
}

# A value for a single-quoted YAML scalar inside a Grafana provisioning file:
# a quote doubles. A `$` stays as it is: the pinned Grafana does not expand
# environment variables in alerting provisioning files (measured by
# test/host/integration/observability-proof.sh).
yaml_value() {
    local v="$1"
    v="${v//\'/\'\'}"
    printf "'%s'" "$v"
}

render_alerting() {
    # ALERT_SMTP_PASSWORD is Task 1's ops.env key (sentinel group alert_smtp,
    # shared with mail.env only: the alerts@ principal, TASK-015). It is NOT
    # called PLATFORM_SMTP_PASSWORD here, and it is not the app tier's value.
    local email_to="${ALERT_EMAIL_TO:-}" password="${ALERT_SMTP_PASSWORD:-}"
    local webhook="${ALERT_WEBHOOK_URL:-}"
    # A freshly rendered ops.env still carries the operator sentinels. "Not
    # configured yet" is not "configured wrongly": rendering a sentinel as a
    # recipient would address mail to CHANGE_ME_..., and blocking on the app
    # password would stop a render nobody asked for e-mail in. The printed
    # email=off / webhook=off is what tells the operator it is not on.
    [[ "$email_to" == CHANGE_ME_* ]] && email_to=""
    # Q12: the webhook is a second contact point, off while a sentinel.
    [[ "$webhook" == CHANGE_ME_* ]] && webhook=""
    if [[ -n "$email_to" ]]; then
        if [[ -z "$password" || "$password" == CHANGE_ME_* ]]; then
            die "BLOCKED: ALERT_SMTP_PASSWORD not provisioned (Stalwart app password, §I)" 3
        fi
        if [[ -z "${ALERT_SMTP_HOST:-}" || "${ALERT_SMTP_HOST}" == CHANGE_ME_* ]]; then
            die "BLOCKED: ALERT_SMTP_HOST is not set (the vendor's submission host, mail.<PLATFORM_DOMAIN>)" 3
        fi
        EMAIL_STATE="on"
    else
        password="unset"
    fi
    [[ -n "$webhook" ]] && WEBHOOK_STATE="on"
    printf '%s\n' "$password" | atomic_write "$SECRETS_DIR/smtp-password" 0600
    password=""

    # The static half of the provisioning tree, copied fresh: a file removed
    # from the release must not survive in runtime/ (stale rules would keep
    # alerting on conditions that no longer exist).
    local tmp
    tmp="$(mktemp -d "$OPS_RUNTIME/.grafana-provisioning.XXXXXX")"
    cp -R "$PROVISIONING_SRC/." "$tmp/"
    mkdir -p "$tmp/alerting"
    if [[ "$EMAIL_STATE" == on || "$WEBHOOK_STATE" == on ]]; then
        {
            printf '# Rendered by infra/host/ops/render-ops.sh from %s. Do not edit.\n' "$(basename "$ENV_FILE")"
            printf 'apiVersion: 1\n\ncontactPoints:\n  - orgId: 1\n    name: platform\n    receivers:\n'
            if [[ "$EMAIL_STATE" == on ]]; then
                printf '      - uid: platform-email\n        type: email\n'
                printf '        disableResolveMessage: false\n        settings:\n'
                printf '          addresses: %s\n          singleEmail: true\n' "$(yaml_value "$email_to")"
            fi
            if [[ "$WEBHOOK_STATE" == on ]]; then
                printf '      - uid: platform-webhook\n        type: webhook\n'
                printf '        disableResolveMessage: false\n        settings:\n'
                printf '          url: %s\n          httpMethod: POST\n' "$(yaml_value "$webhook")"
            fi
        } > "$tmp/alerting/contact-points.yaml"
    else
        # No sink configured: no contact point and no policy routing to one.
        # The rules still evaluate and show in Grafana; nothing is sent.
        rm -f "$tmp/alerting/policies.yaml"
    fi
    chmod -R a+rX "$tmp"
    rm -rf "$PROVISIONING_DIR"
    mv "$tmp" "$PROVISIONING_DIR"
}

grafana_sso_state() {
    # Written by gremion-tenant init (the platform realm's grafana client).
    # Absent, Grafana still starts and nobody can sign in: fail closed.
    if [[ -s "$GRAFANA_SECRETS_DIR/client_secret" ]]; then SSO_STATE="ready"; fi
}

post_conditions() {
    local f
    for f in "$SECRETS_DIR/smtp-password" "$SECRETS_DIR/stalwart-api-key" "$SECRETS_DIR/otlp-ingest-token" \
             "$TARGETS_DIR/blackbox-https.yml" "$TARGETS_DIR/blackbox-control.yml" \
             "$TARGETS_DIR/blackbox-acme.yml" "$TARGETS_DIR/blackbox-smtp.yml" \
             "$TARGETS_DIR/blackbox-smtp25.yml" "$TARGETS_DIR/blackbox-tls.yml" \
             "$TARGETS_DIR/stalwart.yml" "$TARGETS_DIR/blackbox-third-party.yml" \
             "$PROVISIONING_DIR/datasources/datasources.yaml" "$PROVISIONING_DIR/alerting/rules.yaml"; do
        [[ -f "$f" && ! -d "$f" && -s "$f" ]] \
            || die "post-condition failed, not a non-empty file: $f" 1
    done
    if [[ "$EMAIL_STATE" == on || "$WEBHOOK_STATE" == on ]]; then
        [[ -s "$CONTACT_FILE" && -s "$POLICY_FILE" ]] \
            || die "post-condition failed: an alert sink is configured but the contact point or policy is missing" 1
        # A carriage return lands inside the YAML value (Git for Windows).
        ! grep -q $'\r' "$CONTACT_FILE" \
            || die "post-condition failed, carriage returns in $CONTACT_FILE" 1
        ! grep -q 'CHANGE_ME_' "$CONTACT_FILE" \
            || die "post-condition failed, a sentinel in $CONTACT_FILE" 1
    else
        [[ ! -e "$POLICY_FILE" ]] || die "post-condition failed: a policy routes to a contact point that was not rendered" 1
    fi
}

main() {
    render_targets
    render_stalwart_key
    render_ingest_token
    render_alerting
    grafana_sso_state
    post_conditions
    echo "OPS-RENDER: files=${FILE_COUNT} targets=${TARGET_COUNT} email=${EMAIL_STATE} webhook=${WEBHOOK_STATE} stalwart-key=${STALWART_KEY_STATE} grafana-sso=${SSO_STATE}"
}

main "$@"
