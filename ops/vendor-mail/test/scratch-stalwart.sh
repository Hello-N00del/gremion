#!/usr/bin/env bash
# ops/vendor-mail/test/scratch-stalwart.sh — TASK-015 TDD item 5, live half.
#
#   bash ops/vendor-mail/test/scratch-stalwart.sh [--out FILE] [--ban-probe N]
#
# Boots the PINNED Stalwart (STALWART_IMAGE of mail.env.tmpl, by digest) as
# ONE throwaway container, t015-<sha8>-stalwart, on a loopback address, with
# the project's own config.toml.tmpl rendered with test values, and proves on
# the running server what the unit tests can only model:
#   * provision-roles.sh creates system@, alerts@, platform@, roles@;
#   * principals issue A and B (through the real launcher) -> both 235 on 587;
#   * revoke A -> A 535, B still 235 (TRD-049);
#   * a re-issue without --rotate is refused; --rotate: old 535, new 235;
#   * a foreign MAIL FROM is refused (must-match-sender);
#   * TRD-253 negative: kc-A with a council-domain From -- envelope, and
#     header only -- is refused; system@/alerts@ send as themselves;
#   * platform@ with MAIL FROM:<no-reply@> (what realm-doc.ts stamps) is
#     RECORDED (Q4: a refusal is TASK-043's defect);
#   * the auth-failure probe (TASK-042-b): N bad AUTH, then a valid one from
#     the same source, RECORDED (auto-ban).
# The result is one JSON document (stdout, and --out FILE); every secret is
# generated per run, held in shell variables and never printed.
#
# SCRATCH DEVIATIONS from a host, each forced by what a scratch box lacks:
# no [acme] block (a self-signed certificate instead), the listeners bind
# 0.0.0.0 inside the container (this sandbox has no IPv6 sockets), and the
# management API / submission are published on 127.0.0.15 only.
#
# NEVER `docker compose down`, never a prune, never a gremion_* volume: the
# one container is removed BY NAME in the EXIT trap.
#
# EXIT: 0 every asserted post-condition held - 1 one did not - 2 precondition.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT=""
BAN_N=110
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) OUT="$2"; shift 2 ;;
        --ban-probe) BAN_N="$2"; shift 2 ;;
        *) echo "usage: $0 [--out FILE] [--ban-probe N]" >&2; exit 2 ;;
    esac
done
for c in docker node openssl curl jq awk git; do
    command -v "$c" >/dev/null || { echo "missing required command: $c" >&2; exit 2; }
done

SHA8="$(git -C "$ROOT" rev-parse --short=8 HEAD)"
NAME="t015-${SHA8}-stalwart"
IP=127.0.0.15
API="http://${IP}:8086"
SUB_PORT=10587
DOMAIN=example.org
IMAGE="$(sed -n 's/^STALWART_IMAGE=//p' "$ROOT/infra/host/templates/env/mail.env.tmpl")"
[[ "$IMAGE" == *@sha256:* ]] || { echo "STALWART_IMAGE in mail.env.tmpl is not pinned by digest" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

gen() { openssl rand -hex 16; }
ADMIN_PW="$(gen)"

# ── render config.toml.tmpl with test values ───────────────────────────────
mkdir -p "$WORK/dkim" "$WORK/tls" "$WORK/sieve" "$WORK/env" "$WORK/root/etc/env"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/tls/tls.key" -out "$WORK/tls/tls.crt" \
    -days 1 -subj "/CN=mail.${DOMAIN}" -addext "subjectAltName=DNS:mail.${DOMAIN}" 2>/dev/null
openssl genrsa -out "$WORK/dkim/g2026a.private" 2048 2>/dev/null
cp "$WORK/dkim/g2026a.private" "$WORK/dkim/g2026b.private"
chmod 644 "$WORK/dkim/"* "$WORK/tls/"*
cp "$ROOT/infra/host/mail/from-align.sieve" "$WORK/sieve/"
# shellcheck disable=SC2016  # the ${...} are LITERAL template placeholders
awk -v D="$DOMAIN" -v PW="$ADMIN_PW" '
/^\[acme\."le"\]/ { skip = 1; next }
skip && /^# Two selectors/ { skip = 0 }
skip { next }
/^\[certificate\.default\]/ {
    print; print "cert = \"%{file:/opt/stalwart/etc/tls/tls.crt}%\""
    print "private-key = \"%{file:/opt/stalwart/etc/tls/tls.key}%\""; next }
{ gsub(/"\[::\]:/, "\"0.0.0.0:")
  gsub(/\$\{MAIL_HOSTNAME\}/, "mail." D); gsub(/\$\{PLATFORM_DOMAIN\}/, D); gsub(/\$\{ACME_EMAIL\}/, "ops@" D)
  gsub(/\$\{DKIM_SELECTOR_A\}/, "g2026a"); gsub(/\$\{DKIM_SELECTOR_B\}/, "g2026b")
  gsub(/\$\{MAIL_RATE_LIMIT_RCPT\}/, "100/1h"); gsub(/\$\{MAIL_LOG_RETENTION_DAYS\}/, "7")
  gsub(/\$\{STALWART_ADMIN_USER\}/, "admin"); gsub(/\$\{STALWART_ADMIN_PASSWORD\}/, PW); print }' \
    "$ROOT/infra/host/mail/config.toml.tmpl" > "$WORK/config.toml"
# shellcheck disable=SC2016  # the LITERAL two characters a surviving placeholder starts with
if grep -q '\${' "$WORK/config.toml"; then echo "scratch render left a placeholder" >&2; exit 2; fi

# ── the scratch mail.env: every template key, test values, fresh secrets ──
VENDOR_PW="$(gen)"; ALERT_PW="$(gen)"; PLATFORM_PW="$(gen)"; ROLES_PW="$(gen)"
grep -vE '^(GREMION_ROOT|STALWART_ADMIN_URL|STALWART_ADMIN_PASSWORD|VENDOR_SMTP_PASSWORD|ALERT_SMTP_PASSWORD|PLATFORM_SMTP_PASSWORD|ROLES_IMAP_PASSWORD|STACK)=' \
    "$ROOT/ops/vendor-mail/__fixtures__/env/mail.env" > "$WORK/root/etc/env/mail.env"
{
    echo "GREMION_ROOT=$WORK/root"
    echo "STACK=t015${SHA8:0:4}"
    echo "STALWART_ADMIN_URL=${API}"
    echo "STALWART_ADMIN_PASSWORD=${ADMIN_PW}"
    echo "VENDOR_SMTP_PASSWORD=${VENDOR_PW}"
    echo "ALERT_SMTP_PASSWORD=${ALERT_PW}"
    echo "PLATFORM_SMTP_PASSWORD=${PLATFORM_PW}"
    echo "ROLES_IMAP_PASSWORD=${ROLES_PW}"
} >> "$WORK/root/etc/env/mail.env"
chmod 600 "$WORK/root/etc/env/mail.env"

# ── boot ────────────────────────────────────────────────────────────────────
docker run -d --name "$NAME" --label t015=scratch-stalwart -e STALWART_PATH=/opt/stalwart \
    -p "${IP}:8086:8080" -p "${IP}:${SUB_PORT}:587" \
    -v "$WORK/config.toml:/opt/stalwart/etc/config.toml:ro" \
    -v "$WORK/dkim:/opt/stalwart/etc/dkim:ro" -v "$WORK/tls:/opt/stalwart/etc/tls:ro" \
    -v "$WORK/sieve:/opt/stalwart/etc/sieve:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "${API}/healthz/live" 2>/dev/null && break
    sleep 1
done
curl -fsS -o /dev/null "${API}/healthz/live" || { docker logs "$NAME" 2>&1 | tail -20 >&2; echo "stalwart did not come up" >&2; exit 2; }

FAILS=0
declare -A R=()
record() { R["$1"]="$2"; }
expect() {   # <label> <actual> <wanted regex>
    if [[ "$2" =~ $3 ]]; then record "$1" "$2"; else record "$1" "$2 (WANTED $3)"; FAILS=$((FAILS + 1)); fi
}
probe() {    # <password var value> <user> [probe args...]  -> JSON line
    local pw="$1" user="$2"; shift 2
    SMTP_PROBE_PASSWORD="$pw" node "$ROOT/ops/vendor-mail/test/smtp-probe.mjs" \
        --host "$IP" --port "$SUB_PORT" --user "$user" "$@"
}
auth_code() { probe "$1" "$2" | jq -r '.auth // .error'; }
LAUNCH() { MAIL_ENV="$WORK/root/etc/env/mail.env" GREMION_ROOT="$WORK/root" "$ROOT/infra/host/bin/gremion-vendor-mail" "$@"; }

# ── provision-roles.sh against the real server ──────────────────────────────
rc=0; prov="$("$ROOT/infra/host/mail/provision-roles.sh" --env "$WORK/root/etc/env/mail.env" --allow-unrestricted 2>&1)" || rc=$?
expect provision_roles_exit "$rc" '^0$'
expect provision_roles_line "$(grep -o 'MAIL-ROLES:.*' <<<"$prov" || echo none)" 'vendor-app-password=ok alerts-app-password=ok platform-app-password=ok source-restriction=residual'
expect system_auth "$(auth_code "$VENDOR_PW" "system@${DOMAIN}")" '^235$'
expect alerts_auth "$(auth_code "$ALERT_PW" "alerts@${DOMAIN}")" '^235$'
expect system_sends_as_itself "$(probe "$VENDOR_PW" "system@${DOMAIN}" --mail-from "system@${DOMAIN}" --rcpt "probe@example.net" --header-from "\"Gremion\" <system@${DOMAIN}>" | jq -r .data)" '^250$'
expect alerts_sends_as_itself "$(probe "$ALERT_PW" "alerts@${DOMAIN}" --mail-from "alerts@${DOMAIN}" --rcpt "probe@example.net" --header-from "alerts@${DOMAIN}" | jq -r .data)" '^250$'
expect vendor_password_is_not_platform "$(auth_code "$PLATFORM_PW" "system@${DOMAIN}")" '^535$'

# ── principals through the launcher (node image by digest, --network host) ─
issue_pw() { LAUNCH principals issue --tenant "$1" "${@:2}" | sed -n 's/^APP-PASSWORD: //p'; }
A_PW="$(issue_pw alpha_council)"; B_PW="$(issue_pw beta_council)"
expect a_issued "$([[ "$A_PW" =~ ^[A-Za-z0-9]{32}$ ]] && echo yes || echo no)" '^yes$'
expect b_issued "$([[ "$B_PW" =~ ^[A-Za-z0-9]{32}$ ]] && echo yes || echo no)" '^yes$'
L1="$(LAUNCH principals list | tr '\n' ' ')"; L2="$(LAUNCH principals list | tr '\n' ' ')"
expect list_idempotent "$([[ "$L1" == "$L2" && "$L1" == *kc-alpha_council@* && "$L1" == *kc-beta_council@* ]] && echo same || echo "differs: $L1 | $L2")" '^same$'
expect a_auth "$(auth_code "$A_PW" "kc-alpha_council@${DOMAIN}")" '^235$'
expect b_auth "$(auth_code "$B_PW" "kc-beta_council@${DOMAIN}")" '^235$'
expect a_cannot_be_b "$(auth_code "$A_PW" "kc-beta_council@${DOMAIN}")" '^535$'
rc=0; LAUNCH principals issue --tenant alpha_council >/dev/null 2>&1 || rc=$?
expect reissue_without_rotate_exit "$rc" '^2$'
A2_PW="$(issue_pw alpha_council --rotate)"
expect rotate_old_password "$(auth_code "$A_PW" "kc-alpha_council@${DOMAIN}")" '^535$'
expect rotate_new_password "$(auth_code "$A2_PW" "kc-alpha_council@${DOMAIN}")" '^235$'

# ── sender binding (must-match-sender + from-align.sieve) ───────────────────
m="$(probe "$B_PW" "kc-beta_council@${DOMAIN}" --mail-from "system@${DOMAIN}" --rcpt "probe@example.net")"
expect foreign_mail_from "$(jq -r '.mailFromText' <<<"$m")" '^5[0-9][0-9] '
m="$(probe "$B_PW" "kc-beta_council@${DOMAIN}" --mail-from "info@council.example" --rcpt "probe@example.net")"
expect council_envelope_from "$(jq -r '.mailFromText' <<<"$m")" '^5[0-9][0-9] '
m="$(probe "$B_PW" "kc-beta_council@${DOMAIN}" --mail-from "kc-beta_council@${DOMAIN}" --rcpt "probe@example.net" --header-from "info@council.example")"
expect council_header_from "$(jq -r '.dataText' <<<"$m")" '^5[0-9][0-9] .*5\.7\.1'
m="$(probe "$B_PW" "kc-beta_council@${DOMAIN}" --mail-from "kc-beta_council@${DOMAIN}" --rcpt "probe@example.net" --header-from "system@${DOMAIN}")"
expect customer_as_vendor_header_from "$(jq -r '.dataText' <<<"$m")" '^5[0-9][0-9] .*5\.7\.1'
m="$(probe "$B_PW" "kc-beta_council@${DOMAIN}" --mail-from "kc-beta_council@${DOMAIN}" --rcpt "probe@example.net" --header-from "\"Gremion\" <kc-beta_council@${DOMAIN}>")"
expect customer_own_from "$(jq -r '.data' <<<"$m")" '^250$'
m="$(probe "$PLATFORM_PW" "platform@${DOMAIN}" --mail-from "no-reply@${DOMAIN}" --rcpt "probe@example.net")"
record platform_with_no_reply_mail_from "$(jq -r '.mailFromText // .authText' <<<"$m")"

# ── revoke (TRD-049) ────────────────────────────────────────────────────────
LAUNCH principals revoke --tenant alpha_council >/dev/null
expect a_revoked "$(auth_code "$A2_PW" "kc-alpha_council@${DOMAIN}")" '^535$'
expect b_survives_a_revoke "$(auth_code "$B_PW" "kc-beta_council@${DOMAIN}")" '^235$'
expect a_gone_from_list "$(LAUNCH principals list --tenant alpha_council | tail -n1)" '^KC-PRINCIPALS: 0$'

# ── auth-failure probe (TASK-042-b, Q13): recorded, not asserted ────────────
if [[ "$BAN_N" -gt 0 ]]; then
    record ban_probe_bad_auths "$(SMTP_PROBE_PASSWORD=wrong node "$ROOT/ops/vendor-mail/test/smtp-probe.mjs" \
        --host "$IP" --port "$SUB_PORT" --user "kc-beta_council@${DOMAIN}" --repeat "$BAN_N" | jq -c .auth)"
    record ban_probe_then_valid "$(auth_code "$B_PW" "kc-beta_council@${DOMAIN}")"
    record ban_probe_log "$(docker logs "$NAME" 2>&1 | grep -o 'Banned due to authentication errors\|Blocked IP address' | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
fi

json="$(for k in "${!R[@]}"; do printf '%s\t%s\n' "$k" "${R[$k]}"; done | sort \
       | jq -Rn --arg image "$IMAGE" --arg sha "$SHA8" --argjson fails "$FAILS" \
           '{image: $image, head: $sha, failures: $fails, results: ([inputs | split("\t") | {(.[0]): .[1]}] | add)}')"
printf '%s\n' "$json"
[[ -z "$OUT" ]] || printf '%s\n' "$json" > "$OUT"
[[ "$FAILS" -eq 0 ]] || exit 1
