#!/usr/bin/env bash
# ============================================================
# Gremion — B-01 guard: KEYCLOAK_REALM and AUTH_KEYCLOAK_ISSUER name ONE realm
#
# Two variables name the same realm:
#   KEYCLOAK_REALM          — the realm a dev/ops script addresses over the
#                             Keycloak Admin API (scripts/dev-configure.sh,
#                             scripts/configure-keycloak-clients.sh, and the
#                             CI job that creates the realm under test).
#   AUTH_KEYCLOAK_ISSUER    — the OIDC issuer the dev stack authenticates
#                             against. Keycloak issuers end in `/realms/<name>`.
#                             (Since TASK-042 no shipped gremion-ui code reads
#                             it: every tenant carries its own issuer in the
#                             registry. Retiring the env template is TASK-043.)
#
# B-01 deleted the boot import and started shipping KEYCLOAK_REALM SET in
# .env.example. Nothing compared the two, so an operator who renames the realm
# the documented way — by editing the issuer — left them pointing at different
# realms, and the failure was silent AND a write: configure-keycloak-clients.sh
# resets the confidential client secrets on the realm KEYCLOAK_REALM names
# while every login goes to the issuer's realm. Nothing logs an error; logins
# simply keep failing with `invalid_client`.
#
# Usage:
#   scripts/check-realm-env.sh              # compare the current environment
#   scripts/check-realm-env.sh path/to/.env # compare an env file
#
# Exit 0 (nothing to compare) when:
#   - KEYCLOAK_REALM is unset or empty  → the issuer is the only source of truth
#   - AUTH_KEYCLOAK_ISSUER is unset     → there is no issuer to compare
#   - the issuer carries no `/realms/<name>` segment → it is not Keycloak-
#     shaped, so KEYCLOAK_REALM is a legitimate override rather than a copy
# Exit 1 when both name a realm and the two names differ.
# ============================================================

set -euo pipefail

ENV_FILE="${1:-}"

# Read ONE key out of an env file the way a shell would: skip comments, take
# the LAST assignment (an appended correction wins over the stale line above
# it — `grep -m1` would read the stale one) and strip one layer of quotes.
read_env_key() {
    local key="$1" file="$2" line
    line=$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)
    [[ -n "$line" ]] || return 0
    line="${line#"${line%%[![:space:]]*}"}"   # drop leading whitespace
    local val="${line#*=}"
    val="${val#\"}" val="${val%\"}"
    val="${val#\'}" val="${val%\'}"
    printf '%s' "$val"
}

if [[ -n "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
        echo "[check-realm-env] ERROR: env file not found: ${ENV_FILE}" >&2
        exit 1
    fi
    REALM=$(read_env_key KEYCLOAK_REALM "$ENV_FILE")
    ISSUER=$(read_env_key AUTH_KEYCLOAK_ISSUER "$ENV_FILE")
else
    REALM="${KEYCLOAK_REALM:-}"
    ISSUER="${AUTH_KEYCLOAK_ISSUER:-}"
fi

# Compare by value: a stray space around either side is not a disagreement.
trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}
REALM=$(trim "$REALM")
ISSUER=$(trim "$ISSUER")

[[ -n "$REALM" ]]  || exit 0
[[ -n "$ISSUER" ]] || exit 0

# `https://host/auth/realms/<realm>` (with or without a trailing slash) -> <realm>
ISSUER_REALM=$(printf '%s' "$ISSUER" | sed -nE 's|.*/realms/([^/?#]+).*|\1|p')
[[ -n "$ISSUER_REALM" ]] || exit 0

if [[ "$REALM" != "$ISSUER_REALM" ]]; then
    {
        echo "[check-realm-env] ERROR: two variables name two DIFFERENT realms."
        echo "    KEYCLOAK_REALM       = ${REALM}"
        echo "    AUTH_KEYCLOAK_ISSUER = ${ISSUER}"
        echo "                           (its /realms/ segment is '${ISSUER_REALM}')"
        echo ""
        echo "  KEYCLOAK_REALM is the realm dev/ops scripts address over the Admin"
        echo "  API; the issuer's /realms/ segment is the realm gremion-ui logs in"
        echo "  against and the realm tenant #1 is registered with. With the two"
        echo "  apart, scripts/configure-keycloak-clients.sh would rewrite the"
        echo "  client secrets of '${REALM}' while every login goes to"
        echo "  '${ISSUER_REALM}' — and nothing would log an error."
        echo ""
        echo "  Fix: set both to the same realm (renaming the realm means editing"
        echo "  AUTH_KEYCLOAK_ISSUER, AUTH_KEYCLOAK_INTERNAL and KEYCLOAK_REALM"
        echo "  together), or unset KEYCLOAK_REALM and let the issuer be the only"
        echo "  source of truth."
    } >&2
    exit 1
fi
