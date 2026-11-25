#!/usr/bin/env bash
# Renders /data/homeserver.yaml from the template, and refuses -- before
# Synapse ever boots -- a render that is not the one TASK-198 ships:
#
#   * every required input (brief section 5.2) must be non-empty; a key that
#     has a default gets it only when UNSET, so `KEY=` is a refusal, never a
#     silent default;
#   * after substitution, the rendered YAML is parsed and asserted: the database
#     engine is psycopg2 (a SQLite render is refused naming sqlite3), and every
#     required YAML key is non-empty and equals its input -- a value that broke
#     out of its YAML quoting fails here, not inside Synapse.
#
# jwt_config.secret is empty after this render by design: the entrypoint
# injects the realm key afterwards (or disables jwt_config), and
# healthcheck.sh is what judges the result.
#
# SYNAPSE_JWT_LOGIN=on|off (default on, byte-identical to the render before the
# switch existed). off renders neither jwt_config nor oidc_providers: the
# homeserver then offers no JWT and no SSO login, the issuer and the OIDC client
# secret are not needed (a blank issuer is no refusal, a named secret file is
# never read), and the post-render assertion refuses an output that still
# carries a login block. Anything but on|off is a refusal.
#
# registration_shared_secret only appears in the rendered config when
# BOOTSTRAP_MODE=1. Outside of that one-time bootstrap window, the line is
# stripped so the shared-secret admin-register endpoint is unreachable even
# if the env var is still set.
#
# The script is invoked from two places:
#   1. modules/messaging/synapse/entrypoint.sh (real container init)
#   2. modules/messaging/synapse/test/*.test.mjs (the module's tests)
#
# Inputs (env vars):
#   SYNAPSE_TEMPLATE   path to the YAML template
#                      (default: /config/homeserver.yaml.tpl)
#   SYNAPSE_CONFIG     path to the rendered YAML
#                      (default: /data/homeserver.yaml)
#   BOOTSTRAP_MODE     "1" -> keep registration_shared_secret;
#                      anything else -> strip it (default: "0")
#   SYNAPSE_JWT_LOGIN  "on" (default) | "off": see above
#   SYNAPSE_OIDC_CLIENT_SECRET_FILE  the OIDC client secret as a file; wins
#                      over SYNAPSE_OIDC_CLIENT_SECRET. When unset, the default
#                      /run/secrets/synapse-oidc-client-secret is read if it
#                      exists; a NAMED file that cannot be read is a refusal.
#
# `render-homeserver.sh --fetch-url` prints the URL the entrypoint fetches the
# realm key from (SYNAPSE_KEYCLOAK_FETCH_URL, or, when blank, the in-network
# http://keycloak:8080/auth/realms/<the issuer's last path segment>) and
# renders nothing.
#
# Otherwise, after rendering, `exec "$@"` so the script can be used as an
# entrypoint prefix without forking a subshell. Nothing here ever prints a
# secret value.
set -euo pipefail

TPL="${SYNAPSE_TEMPLATE:-/config/homeserver.yaml.tpl}"
OUT="${SYNAPSE_CONFIG:-/data/homeserver.yaml}"
DEFAULT_SECRET_FILE=/run/secrets/synapse-oidc-client-secret

die() {
  echo "[render-homeserver] ERROR: $*" >&2
  exit 1
}

# The login switch: unset is on; set empty, or anything but on|off, is a refusal
# (the compose service always passes a non-empty value).
export SYNAPSE_JWT_LOGIN="${SYNAPSE_JWT_LOGIN-on}"
case "$SYNAPSE_JWT_LOGIN" in
  on|off) ;;
  *) die "SYNAPSE_JWT_LOGIN must be 'on' or 'off'" ;;
esac

# Defaults apply to an UNSET key only (`=`, not `:-`): a key set empty is a
# refusal below, not a quiet fallback.
: "${SYNAPSE_DB_HOST=messaging-postgres}"
: "${SYNAPSE_DB_PORT=5432}"
: "${SYNAPSE_DB_NAME=synapse}"
: "${SYNAPSE_DB_USER=synapse}"
export SYNAPSE_DB_HOST SYNAPSE_DB_PORT SYNAPSE_DB_NAME SYNAPSE_DB_USER

issuer="${SYNAPSE_KEYCLOAK_ISSUER_URL:-}"
if [[ "${1:-}" == "--fetch-url" ]]; then
  [[ -n "$issuer" ]] || die "SYNAPSE_KEYCLOAK_ISSUER_URL is empty -- no realm to fetch the key from"
  if [[ -n "${SYNAPSE_KEYCLOAK_FETCH_URL:-}" ]]; then
    printf '%s\n' "$SYNAPSE_KEYCLOAK_FETCH_URL"
  else
    realm="${issuer%/}"
    realm="${realm##*/}"
    [[ -n "$realm" ]] || die "SYNAPSE_KEYCLOAK_ISSUER_URL has no realm segment to derive the fetch URL from"
    printf 'http://keycloak:8080/auth/realms/%s\n' "$realm"
  fi
  exit 0
fi

# The OIDC client secret: the file wins (the provisioner's host file, mounted
# as a secret), the env value is the scratch fallback. With the login switch off
# no OIDC provider is rendered: neither the file nor the env value is read, and
# the issuer is not rendered either.
if [[ "$SYNAPSE_JWT_LOGIN" == off ]]; then
  secret_file=""
  SYNAPSE_OIDC_CLIENT_SECRET=""
  SYNAPSE_KEYCLOAK_ISSUER_URL=""
elif [[ -n "${SYNAPSE_OIDC_CLIENT_SECRET_FILE:-}" ]]; then
  [[ -r "$SYNAPSE_OIDC_CLIENT_SECRET_FILE" ]] || die "SYNAPSE_OIDC_CLIENT_SECRET_FILE names a file that cannot be read"
  secret_file="$SYNAPSE_OIDC_CLIENT_SECRET_FILE"
elif [[ -e "$DEFAULT_SECRET_FILE" ]]; then
  # Mounted but unreadable (a wrong mode on the secret) is a refusal, never
  # a quiet fallback to the env value.
  [[ -r "$DEFAULT_SECRET_FILE" ]] || die "$DEFAULT_SECRET_FILE exists but cannot be read"
  secret_file="$DEFAULT_SECRET_FILE"
else
  secret_file=""
fi
if [[ -n "$secret_file" ]]; then
  SYNAPSE_OIDC_CLIENT_SECRET="$(tr -d '\r\n' < "$secret_file")"
  [[ -n "$SYNAPSE_OIDC_CLIENT_SECRET" ]] || die "SYNAPSE_OIDC_CLIENT_SECRET (read from SYNAPSE_OIDC_CLIENT_SECRET_FILE) is empty"
fi
export SYNAPSE_OIDC_CLIENT_SECRET="${SYNAPSE_OIDC_CLIENT_SECRET:-}"

required_vars="SYNAPSE_SERVER_NAME MATRIX_PUBLIC_URL SYNAPSE_DB_HOST SYNAPSE_DB_PORT
SYNAPSE_DB_NAME SYNAPSE_DB_USER SYNAPSE_DB_PASSWORD"
# the issuer and the OIDC client secret belong to the login blocks, which the off render does not have
if [[ "$SYNAPSE_JWT_LOGIN" == on ]]; then
  required_vars="$required_vars SYNAPSE_KEYCLOAK_ISSUER_URL SYNAPSE_OIDC_CLIENT_SECRET"
fi
for v in $required_vars; do
  [[ -n "${!v:-}" ]] || die "$v is empty or unset -- refusing to render"
done
case "$SYNAPSE_DB_PORT" in
  *[!0-9]*) die "SYNAPSE_DB_PORT must be a plain integer" ;;
esac
export SYNAPSE_SERVER_NAME MATRIX_PUBLIC_URL SYNAPSE_DB_PASSWORD
export SYNAPSE_KEYCLOAK_ISSUER_URL="${SYNAPSE_KEYCLOAK_ISSUER_URL:-}"
# The admin bot is the only account allowed to create room aliases (alias_creation_rules).
# Required: an empty or malformed id would render a rule that locks the bot out or allows everyone.
[[ -n "${SYNAPSE_ADMIN_BOT_USER_ID:-}" ]] || die "SYNAPSE_ADMIN_BOT_USER_ID is empty or unset -- refusing to render"
[[ "$SYNAPSE_ADMIN_BOT_USER_ID" =~ ^@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
  || die "SYNAPSE_ADMIN_BOT_USER_ID must look like @localpart:server"
export SYNAPSE_ADMIN_BOT_USER_ID
export SYNAPSE_REGISTRATION_SHARED_SECRET="${SYNAPSE_REGISTRATION_SHARED_SECRET:-}"

# Env-gated security knobs. The template has no ${VAR:-default}
# syntax (nor does the substitution below), so the defaults live HERE: unset vars get the conservative
# production posture (password auth OFF, Synapse's upstream rate-limit
# defaults).
export SYNAPSE_PASSWORD_AUTH="${SYNAPSE_PASSWORD_AUTH:-false}"
# The OIDC provider's display name (was a fixed literal in the template).
export SYNAPSE_IDP_NAME="${SYNAPSE_IDP_NAME:-Gremion}"
case "$SYNAPSE_PASSWORD_AUTH" in
  true|false) ;;
  *) die "SYNAPSE_PASSWORD_AUTH must be 'true' or 'false', got '${SYNAPSE_PASSWORD_AUTH}'." ;;
esac
case "$SYNAPSE_IDP_NAME" in
  *[!A-Za-z0-9\ ._-]*) die "SYNAPSE_IDP_NAME may hold letters, digits, space, '.', '_' and '-' only" ;;
esac
export SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND="${SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND:-0.003}"
export SYNAPSE_RC_LOGIN_ADDRESS_BURST="${SYNAPSE_RC_LOGIN_ADDRESS_BURST:-5}"
export SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND="${SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND:-0.003}"
export SYNAPSE_RC_LOGIN_ACCOUNT_BURST="${SYNAPSE_RC_LOGIN_ACCOUNT_BURST:-5}"
export SYNAPSE_RC_MESSAGE_PER_SECOND="${SYNAPSE_RC_MESSAGE_PER_SECOND:-0.2}"
export SYNAPSE_RC_MESSAGE_BURST="${SYNAPSE_RC_MESSAGE_BURST:-10}"
# Numeric guard — a non-numeric value would inject raw YAML into the render.
for v in SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND SYNAPSE_RC_LOGIN_ADDRESS_BURST \
         SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND SYNAPSE_RC_LOGIN_ACCOUNT_BURST \
         SYNAPSE_RC_MESSAGE_PER_SECOND SYNAPSE_RC_MESSAGE_BURST; do
  val="${!v}"
  case "$val" in
    ''|.|*[!0-9.]*|*.*.*) die "$v must be a plain non-negative number, got '${val}'." ;;
  esac
done

# Only the named variables are substituted (envsubst's SHELL-FORMAT
# semantics, done in Python so the image needs no gettext-base apt layer);
# any other `$` in the template, comments included, is left alone.
export SYNAPSE_RENDER_VARS="SYNAPSE_SERVER_NAME MATRIX_PUBLIC_URL SYNAPSE_DB_USER SYNAPSE_DB_PASSWORD
SYNAPSE_DB_NAME SYNAPSE_DB_HOST SYNAPSE_DB_PORT SYNAPSE_REGISTRATION_SHARED_SECRET
SYNAPSE_KEYCLOAK_ISSUER_URL SYNAPSE_IDP_NAME SYNAPSE_OIDC_CLIENT_SECRET
SYNAPSE_PASSWORD_AUTH SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND SYNAPSE_RC_LOGIN_ADDRESS_BURST
SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND SYNAPSE_RC_LOGIN_ACCOUNT_BURST
SYNAPSE_RC_MESSAGE_PER_SECOND SYNAPSE_RC_MESSAGE_BURST SYNAPSE_ADMIN_BOT_USER_ID"
export BOOTSTRAP_MODE="${BOOTSTRAP_MODE:-0}"

# Every substituted value lands inside YAML double quotes (or bare): a
# newline, carriage return, double quote or backslash could break out and
# inject keys (a secret ending in "\nenable_registration: true" would open
# registration). Refused by key; the value is never printed.
for v in $SYNAPSE_RENDER_VARS; do
  val="${!v:-}"
  case "$val" in
    *$'\n'*|*$'\r'*|*'"'*|*$'\\'*) die "$v contains a newline, carriage return, double quote or backslash -- refusing to render it into YAML" ;;
  esac
done

# Render to a temporary file next to the output and move it into place only
# once it has passed: a refused render leaves no config behind.
[[ -r "$TPL" ]] || die "template $TPL cannot be read"
tmp="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# The render and its post-render assertion. Messages name the engine or the
# key, never a value; nothing is written unless every check passes.
python3 - "$TPL" "$tmp" <<'PY' || die "the rendered homeserver.yaml failed its assertion -- refusing to start Synapse"
import os
import re
import sys

import yaml

with open(sys.argv[1]) as f:
    text = f.read()
if os.environ["BOOTSTRAP_MODE"] != "1":
    # Strip the registration_shared_secret line from the TEMPLATE, before
    # substitution, so no value can ever reach the render through it. Only
    # matches at column 0 so commented references are left untouched.
    text = "".join(line for line in text.splitlines(keepends=True) if not line.startswith("registration_shared_secret:"))
JWT_OFF = os.environ["SYNAPSE_JWT_LOGIN"] == "off"
# The login blocks the off render does not have: the JWT block and the OIDC provider list.
LOGIN_BLOCKS = ("jwt_config", "oidc_providers")
LOGIN_KEYS = LOGIN_BLOCKS + ("oidc_config", "cas_config", "saml2_config")


def strip_block(src, key):
    """Drops the top-level block `key:` with the comment lines right above it. A block runs over its
    indented lines (comments included); the blank line after it stays."""
    lines = src.splitlines(keepends=True)
    at = next((i for i, line in enumerate(lines) if line.startswith(key + ":")), None)
    if at is None:
        return src
    first = at
    while first > 0 and lines[first - 1].startswith("#"):
        first -= 1
    last = at + 1
    while last < len(lines) and (lines[last].strip() == "" or lines[last][0] in " \t"):
        last += 1
    while last > at + 1 and lines[last - 1].strip() == "":
        last -= 1
    return "".join(lines[:first] + lines[last:])


if JWT_OFF:
    for block in LOGIN_BLOCKS:
        text = strip_block(text, block)
names =set(os.environ["SYNAPSE_RENDER_VARS"].split())
# One pass: a substituted value is never scanned again for ${...}.
text = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m.group(1), "") if m.group(1) in names else m.group(0), text)
try:
    cfg = yaml.safe_load(text)
except yaml.YAMLError as exc:
    mark = getattr(exc, "problem_mark", None)
    where = f" (line {mark.line + 1})" if mark else ""
    sys.stderr.write(f"[render-homeserver] ERROR: the render is not valid YAML{where}\n")
    sys.exit(1)
if not isinstance(cfg, dict):
    sys.stderr.write("[render-homeserver] ERROR: the render is not a YAML mapping\n")
    sys.exit(1)

problems = []


def get(path):
    node = cfg
    for part in path.split("."):
        if isinstance(node, list):
            node = node[int(part)] if part.isdigit() and int(part) < len(node) else None
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            node = None
    return node


db = cfg.get("database") if isinstance(cfg.get("database"), dict) else {}
engine = db.get("name")
if engine != "psycopg2":
    problems.append(f"database.name is {engine!r}: only psycopg2 (PostgreSQL) is allowed, never sqlite3")
for token in ("sqlite3", "homeserver.db"):
    if token in text:
        problems.append(f"the render names {token}")

issuer = os.environ["SYNAPSE_KEYCLOAK_ISSUER_URL"]
expect = {
    "server_name": os.environ["SYNAPSE_SERVER_NAME"],
    "public_baseurl": os.environ["MATRIX_PUBLIC_URL"] + "/",
    "database.args.user": os.environ["SYNAPSE_DB_USER"],
    "database.args.password": os.environ["SYNAPSE_DB_PASSWORD"],
    "database.args.dbname": os.environ["SYNAPSE_DB_NAME"],
    "database.args.host": os.environ["SYNAPSE_DB_HOST"],
    "database.args.port": int(os.environ["SYNAPSE_DB_PORT"]),
}
if JWT_OFF:
    # no login block of any kind may survive: the homeserver must offer no JWT and no SSO login
    for key in LOGIN_KEYS:
        if key in cfg:
            problems.append(f"{key} is rendered while SYNAPSE_JWT_LOGIN=off")
else:
    expect.update({
        "jwt_config.issuer": issuer,
        "oidc_providers.0.issuer": issuer,
        "oidc_providers.0.client_secret": os.environ["SYNAPSE_OIDC_CLIENT_SECRET"],
        "oidc_providers.0.token_endpoint": issuer + "/protocol/openid-connect/token",
    })
for key, want in expect.items():
    got = get(key)
    if got in (None, ""):
        problems.append(f"{key} is empty or missing in the render")
    elif got != want:
        problems.append(f"{key} does not hold its input (a value broke out of its YAML quoting?)")

if cfg.get("federation_domain_whitelist") != []:
    problems.append("federation_domain_whitelist is not []")
if cfg.get("trusted_key_servers") != []:
    problems.append("trusted_key_servers is not []")
for lst in cfg.get("listeners") or []:
    for res in lst.get("resources") or []:
        if "federation" in (res.get("names") or []):
            problems.append("a listener serves the federation resource")
for key in ("enable_registration", "enable_registration_without_verification"):
    if cfg.get(key) is not False:
        problems.append(f"{key} is not false (registration stays closed)")
if os.environ["BOOTSTRAP_MODE"] == "1":
    if cfg.get("registration_shared_secret") != os.environ.get("SYNAPSE_REGISTRATION_SHARED_SECRET"):
        problems.append("registration_shared_secret does not hold its input in a bootstrap render")
elif "registration_shared_secret" in cfg:
    problems.append("registration_shared_secret is rendered outside BOOTSTRAP_MODE=1")
if "media_storage_providers" in cfg:
    problems.append("media_storage_providers is set (S3 offload is not deployed)")

if problems:
    for p in problems:
        sys.stderr.write(f"[render-homeserver] ERROR: {p}\n")
    sys.exit(1)
with open(sys.argv[2], "w") as f:
    f.write(text)
PY

mv "$tmp" "$OUT"
trap - EXIT

exec "$@"
