#!/usr/bin/env bash
# bootstrap-sops.sh — One-time SOPS / age bootstrap for production secrets.
#
# G-028 closure: this script guides an operator through generating the age
# key that .sops.yaml needs and uploading its private half to the operator
# vault. It does NOT itself commit anything; it prints the next-step
# commands you must run.
#
# Re-running this script on a workstation that already has an age key is
# safe — it detects the existing key and prints the public half without
# touching the keyring.
#
# Prerequisites:
#   - age installed:  https://github.com/FiloSottile/age/releases
#   - sops installed: https://github.com/getsops/sops/releases
#
# Usage:
#   bash k8s/overlays/production/secrets/bootstrap-sops.sh

set -euo pipefail

KEYS_FILE="${HOME}/.config/sops/age/keys.txt"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

info()  { echo "[bootstrap-sops] $*"; }
fatal() { echo "[bootstrap-sops] ERROR: $*" >&2; exit 1; }

# ── Prereq checks ──────────────────────────────────────────────
command -v age        >/dev/null 2>&1 || fatal "age not installed — see header"
command -v age-keygen >/dev/null 2>&1 || fatal "age-keygen not on PATH"
command -v sops       >/dev/null 2>&1 || fatal "sops not installed — see header"

# ── Generate (or detect) age key ───────────────────────────────
if [[ -f "${KEYS_FILE}" ]]; then
  info "Existing age key found at ${KEYS_FILE} — not regenerating."
else
  info "Generating age key at ${KEYS_FILE}..."
  mkdir -p "$(dirname "${KEYS_FILE}")"
  age-keygen -o "${KEYS_FILE}" 2>&1
  chmod 600 "${KEYS_FILE}"
  info "Done. Key written and chmod'd to 0600."
fi

# Extract public half (line beginning "# public key: age1...")
PUBLIC_KEY=$(grep -E '^# public key: ' "${KEYS_FILE}" | head -1 | awk '{print $4}')
[[ -n "${PUBLIC_KEY}" ]] || fatal "could not parse public key from ${KEYS_FILE}"

cat <<EOF

================================================================
  Public age key (paste this into .sops.yaml at the project root):
  ----------------------------------------------------------------
  ${PUBLIC_KEY}
================================================================

Next steps (manual — operator handoff):

  1. Edit ${PROJECT_ROOT}/.sops.yaml and replace
     <OPERATOR_AGE_PUBLIC_KEY_REPLACE_VIA_BOOTSTRAP_SOPS_SH>
     with the public key printed above.

  2. Upload the PRIVATE half of the key to the operator vault
     (1Password / Bitwarden). The private key file is:
       ${KEYS_FILE}
     Use the secret-note attachment feature; tag with:
       project=sturaos / role=sops-age-key / env=production
     Two operators MUST be able to access it (custody quorum).

  3. Verify the encryption works end-to-end:
       cp "${SCRIPT_DIR}/redis-secret.example.yaml" /tmp/test-secret.yaml
       sops --encrypt --config "${PROJECT_ROOT}/.sops.yaml" /tmp/test-secret.yaml \\
         > /tmp/test-secret.enc.yaml
       sops --decrypt /tmp/test-secret.enc.yaml | grep -q REDIS_PASSWORD
       rm /tmp/test-secret.yaml /tmp/test-secret.enc.yaml
       echo "OK — encrypt/decrypt round-trip green"

  4. For each .example.yaml template in this directory:
       - Copy to .yaml, fill in real values, encrypt, delete plaintext:
           cp foo-secret.example.yaml foo-secret.yaml
           # ...edit foo-secret.yaml, replace every <PLACEHOLDER> ...
           bash ./encrypt-all.sh
       - encrypt-all.sh writes foo-secret.enc.yaml and removes the
         plaintext. Only the .enc.yaml file is committed.

  5. Commit ONLY the .sops.yaml change + each new .enc.yaml file:
       git add .sops.yaml k8s/overlays/production/secrets/*.enc.yaml
       git commit -m 'chore(infra/sops): operator-supplied production secrets'

  6. After commit, scrub the keys.txt from any disk it should not
     persist on (CI runners, ephemeral VMs). On operator workstations
     the file at ${KEYS_FILE} (chmod 600) is fine.

DO NOT commit ${KEYS_FILE} — it is the private half and would
de-anonymise every encrypted Secret in the repo if leaked.

EOF
