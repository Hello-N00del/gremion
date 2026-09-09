#!/bin/sh
# Substitute __<VAR>__ placeholders in a realm-import file with the matching
# environment variable. Fails if any sentinel remains unsubstituted OR if any
# secret contains the chosen sed delimiter.
#
# Implementation notes:
#   * sed delimiters must be a single byte that does NOT appear in either the
#     pattern or the replacement. Printable separators like `|`, `#`, `/` can
#     all show up inside secrets and would corrupt the output, so we use the
#     ASCII control char ETX (0x03). Refuse to run if any secret contains it.
#   * Secrets are passed via env vars rather than on the command line, to keep
#     them out of any `ps` snapshot.
set -eu
SRC="${1:?source file required}"
DST="${2:?destination file required}"

: "${GREMION_UI_OIDC_CLIENT_SECRET:?must be set}"
: "${GREMION_ADMIN_OIDC_CLIENT_SECRET:?must be set}"
# The realm template carries the deployment apex host as __APEX_DOMAIN__ rather
# than a literal, so the shipped realm trusts no host the deployer does not own.
# Non-secret, but REQUIRED: an unset DOMAIN would leave the sentinel in place and
# the trailing unsubstituted-placeholder guard would abort the boot anyway — fail
# here instead, with a message that names the variable.
: "${DOMAIN:?must be set (the deployment apex host, e.g. gremion.de)}"

# G-080: realm sslRequired is parametrized via __SSL_REQUIRED__ in the import
# template. Non-secret, so it defaults (to the secure "all") rather than failing.
# The dev override sets it to "external" for local http://localhost:8082 login.
KC_REALM_SSL_REQUIRED="${KC_REALM_SSL_REQUIRED:-all}"
case "$KC_REALM_SSL_REQUIRED" in
    all|external|none) ;;
    *)
        echo "[substitute-realm-secrets] ERROR: KC_REALM_SSL_REQUIRED must be all|external|none, got '$KC_REALM_SSL_REQUIRED'." >&2
        exit 1
        ;;
esac

DELIM="$(printf '\003')"
# Literal newline for containment checks; command substitution strips
# trailing newlines, so use a heredoc/read instead.
NL="$(printf '\n_')"; NL="${NL%_}"

# Refuse to run if any substituted value contains the sed delimiter or a raw
# newline — either would corrupt the resulting JSON. A standard random secret and
# a well-formed DOMAIN will not.
for name in \
    GREMION_UI_OIDC_CLIENT_SECRET \
    GREMION_ADMIN_OIDC_CLIENT_SECRET \
    DOMAIN
do
    eval "val=\${$name}"
    case "$val" in
        *"$DELIM"*)
            echo "[substitute-realm-secrets] ERROR: $name contains the reserved sed delimiter (0x03)." >&2
            exit 1
            ;;
    esac
    case "$val" in
        *"$NL"*)
            echo "[substitute-realm-secrets] ERROR: $name contains a newline; regenerate without line breaks." >&2
            exit 1
            ;;
    esac
done

# Create destination directory if it doesn't exist (fresh Keycloak image
# doesn't ship /opt/keycloak/data/import/, which is where kc.sh looks for
# realm files). mkdir -p is a no-op if the path already exists.
IMPORT_DIR="$(dirname "$DST")"
mkdir -p "$IMPORT_DIR"

# Keycloak's DirImportProvider expects the conventional naming pattern:
#   {realm}-realm.json        — full realm definition (single file)
#   {realm}-users-{N}.json    — user batches loaded AFTER the realm file
# The entrypoint passes a generic DST name; we translate to the
# conventional name so DirImportProvider actually picks the file up.
# Without this rename DirImportProvider treats the directory as an
# ad-hoc collection, skips the realm file entirely on multi-file runs,
# and then fails on user imports that reference the realm's groups.
REALM_DST="${IMPORT_DIR}/sturaos-realm.json"

sed \
    -e "s${DELIM}__GREMION_UI_OIDC_CLIENT_SECRET__${DELIM}${GREMION_UI_OIDC_CLIENT_SECRET}${DELIM}g" \
    -e "s${DELIM}__GREMION_ADMIN_OIDC_CLIENT_SECRET__${DELIM}${GREMION_ADMIN_OIDC_CLIENT_SECRET}${DELIM}g" \
    -e "s${DELIM}__SSL_REQUIRED__${DELIM}${KC_REALM_SSL_REQUIRED}${DELIM}g" \
    -e "s${DELIM}__APEX_DOMAIN__${DELIM}${DOMAIN}${DELIM}g" \
    "$SRC" > "$REALM_DST"

# Copy optional dev-users.json fragment into the import directory with
# the conventional users-batch filename so DirImportProvider loads it
# after the realm. Mounted only by docker-compose.override.yml (dev);
# absent in production-like `docker compose -f docker-compose.yml up`.
#
# #239 boot guard: the fixtures carry well-known passwords, so importing
# them into a hardened (internet-facing) realm must be structurally
# impossible — not dependent on the convention that the dev override is
# never composed on such a host. TWO independent refusal signals:
#   1. KC_REALM_SSL_REQUIRED resolves to "all" — the prod/staging default
#      (base docker-compose.yml). A realm that requires TLS for every
#      request is a hardened realm.
#   2. KC_HTTPS_CERTIFICATE_FILE is non-empty — set ONLY by
#      docker-compose.prod.yml, and it survives the documented 3-file
#      staging merge regardless of -f order because no other compose file
#      unsets it. This catches the composition where signal 1 is inert:
#      the dev override HARD-CODES KC_REALM_SSL_REQUIRED=external while
#      still mounting dev-users.json — exactly the issue-239 scenario.
# Deliberately NOT a hostname check: KC_HOSTNAME is unset in prod (the
# base file only sets KC_HOSTNAME_STRICT=false; only the dev override
# sets KC_HOSTNAME, to localhost), so the prod-overlay cert marker is the
# structural equivalent of a public-hostname signal.
# On refusal: loud ERROR, scrub any stale users batch, SKIP the copy but
# keep booting — a hardened fresh-volume init simply comes up with no dev
# users and the operator seeds test users explicitly.
if [ -f /opt/keycloak-init/dev-users.json ]; then
    if [ "$KC_REALM_SSL_REQUIRED" = "all" ]; then
        echo "[substitute-realm-secrets] ERROR (#239): hardened realm (signal 1: KC_REALM_SSL_REQUIRED=all) — refusing to import dev-users.json; seed test users explicitly." >&2
        rm -f "${IMPORT_DIR}/sturaos-users-0.json"
    elif [ -n "${KC_HTTPS_CERTIFICATE_FILE:-}" ]; then
        echo "[substitute-realm-secrets] ERROR (#239): prod overlay detected (signal 2: KC_HTTPS_CERTIFICATE_FILE is set) — refusing to import dev-users.json despite sslRequired=${KC_REALM_SSL_REQUIRED}; seed test users explicitly." >&2
        rm -f "${IMPORT_DIR}/sturaos-users-0.json"
    else
        echo "[substitute-realm-secrets] dev composition — importing dev users (sturaos-users-0.json)."
        cp /opt/keycloak-init/dev-users.json "${IMPORT_DIR}/sturaos-users-0.json"
    fi
fi

if grep -q '__[A-Z_]*__' "$REALM_DST"; then
    echo "[substitute-realm-secrets] ERROR: unsubstituted placeholders remain in $REALM_DST" >&2
    grep -n '__[A-Z_]*__' "$REALM_DST" >&2 || true
    exit 1
fi
