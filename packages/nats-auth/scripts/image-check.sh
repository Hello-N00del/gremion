#!/usr/bin/env bash
#
# Reachable where it runs (TASK-024 G5, Q11, Q12), proved on the IMAGE.
#
#   packages/nats-auth/scripts/image-check.sh
#
# Builds the builder stage of gremion-ui/Dockerfile (the migrate /
# tenant-create image) as t024-<sha8>-migrate -- or uses NATS_AUTH_MIGRATE_IMAGE
# when set -- and runs, inside it, from tenant-create's working_dir
# /repo/gremion-ui, the exact call every site makes (make nats-init,
# gremion-deploy step 4, pooled-stack-proof phase_state_up):
#   pnpm exec nats-auth init     exits 0; _sys/reload.nk mode 600; accounts.conf
#                                holds SYS and no tenant account
#   pnpm exec nats-auth init     second run: accounts file unchanged
#   pnpm exec nats-auth render   exits 0 and prints the SYS account
# Round 1 shipped an image where the first call failed "Command not found"
# (exit 254): the bin was copied after `pnpm install`, so pnpm never linked it.
#
# Optional negative: NATS_AUTH_RUNNER_IMAGE=<gremion-ui runner tag> also
# asserts the runner CANNOT import @gremion/nats-auth (devDependency, left out
# by `deploy --prod`).
#
# Seeds are written inside the throwaway container only (--rm); nothing is
# mounted from the host. The built tag is removed BY NAME on exit, never a
# prune.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHA8="$(git -C "$ROOT" rev-parse --short=8 HEAD)"
BUILT=""

cleanup() {
  local rc=$?
  if [ -n "$BUILT" ]; then docker image rm "$BUILT" >/dev/null 2>&1 || true; fi
  return "$rc"
}
trap cleanup EXIT

fail() { echo "[nats-auth-image] FAILED: $*" >&2; exit 1; }

IMG="${NATS_AUTH_MIGRATE_IMAGE:-}"
if [ -z "$IMG" ]; then
  IMG="t024-${SHA8}-migrate"
  echo "[nats-auth-image] building $IMG (builder stage of gremion-ui/Dockerfile)"
  docker build --target builder -f "$ROOT/gremion-ui/Dockerfile" -t "$IMG" "$ROOT"
  BUILT="$IMG"
fi

# One container, the calls in order, each post-condition checked in place.
# MSYS_NO_PATHCONV: Git Bash on Windows would rewrite the container paths
# (/repo/..., /run/...) into host paths; a no-op everywhere else.
out="$(MSYS_NO_PATHCONV=1 docker run --rm -w /repo/gremion-ui \
  -e NATS_SECRETS_DIR=/run/secrets/nats -e NATS_ACCOUNTS_DIR=/etc/nats/accounts \
  "$IMG" sh -euc '
    pnpm exec nats-auth init
    mode="$(stat -c %a /run/secrets/nats/_sys/reload.nk)"
    [ "$mode" = 600 ] || { echo "reload.nk mode $mode, want 600" >&2; exit 11; }
    grep -q "SYS" /etc/nats/accounts/accounts.conf || { echo "accounts.conf has no SYS" >&2; exit 12; }
    if grep -Eq "^[[:space:]]+T_[^[:space:]]+ [{]" /etc/nats/accounts/accounts.conf; then echo "accounts.conf has a tenant account" >&2; exit 13; fi
    pnpm exec nats-auth init
    pnpm exec nats-auth render
  ' 2>&1)" || { printf '%s\n' "$out" >&2; fail "nats-auth in $IMG (see output above)"; }
printf '%s\n' "$out"

printf '%s\n' "$out" | grep -q 'init: sys reload seed created' || fail "first init did not create the reload seed"
printf '%s\n' "$out" | grep -q 'init: sys reload seed present;.*unchanged' || fail "second init changed the accounts file"
printf '%s\n' "$out" | grep -q 'SYS' || fail "render printed no SYS account"
case "$out" in *"Command \"nats-auth\" not found"*) fail "pnpm exec cannot resolve nats-auth" ;; esac

if [ -n "${NATS_AUTH_RUNNER_IMAGE:-}" ]; then
  if MSYS_NO_PATHCONV=1 docker run --rm -w /app "$NATS_AUTH_RUNNER_IMAGE" node -e "import('@gremion/nats-auth').then(()=>process.exit(0),e=>{console.error(e.code);process.exit(3)})" >/dev/null 2>&1; then
    fail "the runner $NATS_AUTH_RUNNER_IMAGE can import @gremion/nats-auth"
  fi
  echo "[nats-auth-image] runner $NATS_AUTH_RUNNER_IMAGE cannot import @gremion/nats-auth (as required)"
fi

echo "[nats-auth-image] OK -- pnpm exec nats-auth init|render run in $IMG"
