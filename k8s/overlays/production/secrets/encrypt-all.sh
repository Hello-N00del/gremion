#!/usr/bin/env bash
# encrypt-all.sh — Encrypt all plaintext secret YAML files with SOPS age.
#
# Prerequisites:
#   1. Install sops:  https://github.com/getsops/sops/releases
#   2. Install age:   https://github.com/FiloSottile/age/releases
#   3. Generate key:  age-keygen -o ~/.config/sops/age/keys.txt
#   4. Add your public key to /.sops.yaml (project root) under creation_rules.age
#   5. Edit each *.yaml file in this directory, replacing CHANGE_ME values
#
# Usage:
#   cd k8s/overlays/production/secrets
#   ./encrypt-all.sh
#
# What this does:
#   - For each *.yaml file (excluding *.enc.yaml), runs sops --encrypt
#   - Writes the encrypted output to the matching *.enc.yaml file
#   - Deletes the plaintext file after successful encryption
#   - Prints a summary of what was encrypted
#
# After running, commit the *.enc.yaml files (NOT the plaintext *.yaml files).
# The plaintext files are gitignored — see the repo-root .gitignore
# (k8s/overlays/production/secrets/*.yaml and *.yml). There is no
# k8s/overlays/production/.gitignore; this pointer used to name one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

if ! command -v sops &>/dev/null; then
  echo "ERROR: sops not found. Install from https://github.com/getsops/sops/releases"
  exit 1
fi

if ! command -v age &>/dev/null; then
  echo "ERROR: age not found. Install from https://github.com/FiloSottile/age/releases"
  exit 1
fi

echo "Encrypting secrets in ${SCRIPT_DIR}..."
echo "Using .sops.yaml at: ${PROJECT_ROOT}/.sops.yaml"
echo ""

ENCRYPTED=0
SKIPPED=0

# Both YAML extensions: a hand-authored .yml was skipped by this glob, so it
# was never encrypted, never deleted, and never even warned about by the
# CHANGE_ME check below. nullglob keeps an unmatched pattern from being passed
# through literally as a filename.
shopt -s nullglob
for plaintext in "${SCRIPT_DIR}"/*.yaml "${SCRIPT_DIR}"/*.yml; do
  # Skip already-encrypted files, templates, and this script
  [[ "$plaintext" == *.enc.yaml || "$plaintext" == *.enc.yml ]] && continue
  [[ "$plaintext" == *.example.yaml || "$plaintext" == *.example.yml ]] && continue
  [[ "$plaintext" == *encrypt-all.sh ]] && continue

  filename="$(basename "$plaintext")"
  filename="${filename%.yaml}"
  filename="${filename%.yml}"
  encrypted="${SCRIPT_DIR}/${filename}.enc.yaml"

  # Check for unfilled placeholders
  if grep -q "CHANGE_ME" "$plaintext"; then
    echo "  SKIP (has CHANGE_ME values): $(basename "$plaintext")"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "  Encrypting: $(basename "$plaintext") → ${filename}.enc.yaml"
  sops --encrypt --config "${PROJECT_ROOT}/.sops.yaml" "$plaintext" > "$encrypted"
  rm -f "$plaintext"
  ENCRYPTED=$((ENCRYPTED + 1))
done

echo ""
echo "Done. Encrypted: ${ENCRYPTED}  Skipped (CHANGE_ME): ${SKIPPED}"
if [[ $SKIPPED -gt 0 ]]; then
  echo ""
  echo "Fill in all CHANGE_ME values in the remaining *.yaml files, then re-run."
fi
if [[ $ENCRYPTED -gt 0 ]]; then
  echo ""
  echo "Commit the *.enc.yaml files:"
  echo "  git add k8s/overlays/production/secrets/*.enc.yaml"
  echo "  git commit -m 'chore: add encrypted production secrets'"
fi
