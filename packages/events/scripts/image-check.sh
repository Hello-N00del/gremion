#!/usr/bin/env bash
#
# Reachable where it runs (TASK-079 G7), proved on the IMAGE.
#
#   packages/events/scripts/image-check.sh
#
# Builds the builder stage of gremion-ui/Dockerfile (the migrate / tenant-create image) as
# t079-<sha8>-migrate -- or uses EVENTS_MIGRATE_IMAGE when set -- and runs, inside it, from
# tenant-create's working_dir /repo/gremion-ui, the call the runbook makes:
#   pnpm exec events                  prints the usage and exits 2 (the bin is linked: not "Command not found")
#   import('@gremion/events')         resolves and exports plumbingSql / enqueue
# Optional negative: EVENTS_RUNNER_IMAGE=<gremion-ui runner tag> also asserts the runner CANNOT import
# @gremion/events (devDependency, left out by `deploy --prod`); only a proven ERR_MODULE_NOT_FOUND passes.
# The built tag is removed BY NAME on exit, never a prune.

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

fail() { echo "[events-image] FAILED: $*" >&2; exit 1; }

IMG="${EVENTS_MIGRATE_IMAGE:-}"
if [ -z "$IMG" ]; then
  IMG="t079-${SHA8}-migrate"
  echo "[events-image] building $IMG (builder stage of gremion-ui/Dockerfile)"
  docker build --target builder -f "$ROOT/gremion-ui/Dockerfile" -t "$IMG" "$ROOT"
  BUILT="$IMG"
fi

# MSYS_NO_PATHCONV: Git Bash on Windows would rewrite the container paths; a no-op everywhere else.
rc=0
out="$(MSYS_NO_PATHCONV=1 docker run --rm -w /repo/gremion-ui "$IMG" sh -c '
  pnpm exec events 2>&1 || echo "@@events-exit=$?@@"
  node --input-type=module -e "const m = await import(\"@gremion/events\"); console.log(\"@@events-exports=\" + [\"enqueue\",\"createRelay\",\"createConsumer\",\"plumbingSql\"].filter((k) => typeof m[k] === \"function\").length + \"@@\")" 2>&1
' 2>&1)" || rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "docker run in $IMG exited $rc"
case "$out" in *"Command \"events\" not found"*) fail "pnpm exec cannot resolve events (the bin was copied after pnpm install)" ;; esac
printf '%s\n' "$out" | grep -q '@@events-exit=2@@' || fail "pnpm exec events did not print its usage and exit 2"
printf '%s\n' "$out" | grep -q '@@events-exports=4@@' || fail "import('@gremion/events') did not export enqueue, createRelay, createConsumer and plumbingSql"

if [ -n "${EVENTS_RUNNER_IMAGE:-}" ]; then
  rrc=0
  rout="$(MSYS_NO_PATHCONV=1 docker run --rm -w /app "$EVENTS_RUNNER_IMAGE" node -e "import('@gremion/events').then(()=>process.exit(0),e=>{console.log('EVENTS_IMPORT_REFUSED '+e.code);process.exit(3)})" 2>&1)" || rrc=$?
  if [ "$rrc" -eq 0 ]; then
    fail "the runner $EVENTS_RUNNER_IMAGE CAN import @gremion/events"
  fi
  if [ "$rrc" -ne 3 ] || ! printf '%s\n' "$rout" | grep -qx 'EVENTS_IMPORT_REFUSED ERR_MODULE_NOT_FOUND'; then
    printf '%s\n' "$rout" >&2
    fail "could not prove the runner $EVENTS_RUNNER_IMAGE refuses @gremion/events (exit $rrc, no ERR_MODULE_NOT_FOUND refusal; output above)"
  fi
  echo "[events-image] runner $EVENTS_RUNNER_IMAGE cannot import @gremion/events (as required)"
fi

echo "[events-image] OK -- pnpm exec events and the package import work in $IMG"
