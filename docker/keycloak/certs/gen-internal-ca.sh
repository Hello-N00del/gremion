#!/usr/bin/env bash
# =============================================================================
# G-080 — generate the internal CA + Keycloak server cert for intra-cluster TLS.
#
# Produces (in this directory, all git-ignored):
#   internal-ca.key   — the internal CA private key (KEEP SECRET, never commit)
#   internal-ca.crt   — the internal CA certificate (mounted into every client
#   internal-ca.pem     as the trust anchor: Node NODE_EXTRA_CA_CERTS,
#                        Helios REQUESTS_CA_BUNDLE, Nextcloud ca-certificates)
#   keycloak.crt      — the Keycloak server cert (SAN: keycloak,localhost,127.0.0.1)
#   keycloak.key      — the Keycloak server key  (KC_HTTPS_CERTIFICATE_KEY_FILE)
#
# Idempotent: re-running is a no-op unless --force is passed. The cert SAN
# includes the docker-DNS name `keycloak` so server-to-server TLS verifies for
# https://keycloak:8443. localhost/127.0.0.1 are included for host-side probes.
#
# Usage:  ./gen-internal-ca.sh [--force]
# =============================================================================
set -euo pipefail

# Git Bash / MSYS on Windows rewrites leading-slash args (openssl -subj "/O=…")
# into C:\Program Files\Git paths. Disable that path conversion (no-op on Linux).
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

CERT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAYS_CA=3650        # 10y CA
DAYS_SRV=825        # ~27mo server leaf (under the 825d browser cap; rotate via --force)
CN_SRV="keycloak"
SAN="DNS:keycloak,DNS:localhost,IP:127.0.0.1"

force=0
[ "${1:-}" = "--force" ] && force=1

if [ -f "$CERT_DIR/internal-ca.crt" ] && [ -f "$CERT_DIR/keycloak.crt" ] && [ "$force" -eq 0 ]; then
  echo "[gen-internal-ca] certs already present in $CERT_DIR — pass --force to regenerate."
  exit 0
fi

umask 077
cd "$CERT_DIR"

echo "[gen-internal-ca] minting internal CA…"
openssl genrsa -out internal-ca.key 4096
openssl req -x509 -new -nodes -key internal-ca.key -sha256 -days "$DAYS_CA" \
  -subj "/O=Gremion Internal/CN=Gremion Internal CA" \
  -out internal-ca.crt

echo "[gen-internal-ca] minting Keycloak server cert (CN=$CN_SRV, SAN=$SAN)…"
openssl genrsa -out keycloak.key 2048
openssl req -new -key keycloak.key \
  -subj "/O=Gremion Internal/CN=$CN_SRV" \
  -addext "subjectAltName=$SAN" \
  -out keycloak.csr

# Signing extensions (server leaf): SAN + non-CA + serverAuth EKU.
# Written into CERT_DIR (cwd) with a RELATIVE name so the native Windows openssl
# can open it — an MSYS /tmp path from mktemp is unreadable to a non-MSYS binary.
EXT_FILE="keycloak-ext.cnf"
trap 'rm -f "$CERT_DIR/$EXT_FILE" "$CERT_DIR/keycloak.csr"' EXIT
{
  printf 'subjectAltName=%s\n' "$SAN"
  printf 'basicConstraints=CA:FALSE\n'
  printf 'keyUsage=digitalSignature,keyEncipherment\n'
  printf 'extendedKeyUsage=serverAuth\n'
} > "$EXT_FILE"

openssl x509 -req -in keycloak.csr \
  -CA internal-ca.crt -CAkey internal-ca.key -CAcreateserial \
  -days "$DAYS_SRV" -sha256 -extfile "$EXT_FILE" \
  -out keycloak.crt

# Clients want a .pem trust anchor; keep a copy with the conventional extension.
cp internal-ca.crt internal-ca.pem

# Container processes (keycloak user, node user, www-data) must be able to READ
# the mounted files. umask 077 above protects the host copy; loosen read bits so
# the ro bind-mount is usable inside containers (the private keys still never
# leave this git-ignored dir).
chmod 0644 internal-ca.crt internal-ca.pem keycloak.crt
chmod 0640 keycloak.key internal-ca.key 2>/dev/null || true

echo "[gen-internal-ca] done. Files in $CERT_DIR:"
ls -1 internal-ca.crt internal-ca.pem keycloak.crt keycloak.key
echo "[gen-internal-ca] verify SAN:"
openssl x509 -in keycloak.crt -noout -ext subjectAltName
