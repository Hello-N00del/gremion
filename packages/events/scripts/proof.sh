#!/usr/bin/env bash
#
# The TASK-079 acceptance against a REAL Postgres and the kernel's authenticated NATS (TRD-420,
# TRD-421, TRD-422; the P1 verification rule). One phase per call, each under 4 minutes:
#
#   packages/events/scripts/proof.sh up                 the scratch stack (scripts/stack.mjs)
#   packages/events/scripts/proof.sh test <group>       core | consumer | deadletter | rebuild
#   packages/events/scripts/proof.sh alert-fire         the DLQ conditions fire exactly one e-mail each
#   packages/events/scripts/proof.sh alert-hold         a still-firing condition sends no second e-mail
#   packages/events/scripts/proof.sh alert-resolve      a resolve notice follows the clear
#   packages/events/scripts/proof.sh down               remove everything BY NAME; prints the verdict
#
# State: .scratch/t079/state.json (the stack) and .scratch/t079/groups (the groups that passed);
# `up` refuses while a state exists. Names are t079-<sha8>-*, bound to 127.0.0.1; nothing here runs
# `docker compose down`, a prune, or touches a gremion_* volume or a container it did not create.
#
# Post-condition, not exit code: the verbose reporter's per-test lines for
# test/live/<group>.live.test.ts are counted; a group fails below
#   [events-proof] N passing (minimum M)
# and a zero-test run is RED. Guard-efficacy hook: EVENTS_CHECK_LOG=<file> EVENTS_CHECK_GROUP=<g>
# runs only the post-condition against that log (no docker, no vitest).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG="$ROOT/packages/events"
SCRATCH="$ROOT/.scratch/t079"
LOGS="$ROOT/.scratch/t079-logs"
STATE="$SCRATCH/state.json"
GROUPS_FILE="$SCRATCH/groups"

# Minimums, not exact counts: adding a case needs no edit here; removing one below the floor fails
# until lowered on purpose -- in this file, never from the environment.
declare -A MIN_PASS=( [core]=15 [consumer]=15 [deadletter]=6 [rebuild]=2 )
REQUIRED_GROUPS="core consumer deadletter rebuild alert-fire alert-hold alert-resolve"

fail() { echo "[events-proof] FAILED: $*" >&2; }

# A group passed: every case of its file passed, none skipped, at least MIN_PASS.
check_group() {
  local group="$1" log="$2" file="test/live/$1.live.test.ts" ran bad min="${MIN_PASS[$1]:-}"
  [ -n "$min" ] || { fail "unknown group $group"; return 1; }
  # An unreadable log must never read as zero failures.
  if [ ! -r "$log" ] || [ ! -s "$log" ]; then fail "no readable log at $log"; return 1; fi
  bad="$(grep -Ec "^[[:space:]]*(×|✗|↓) ${file} >" "$log" || true)"
  bad="${bad:-0}"
  if [ "$bad" -ne 0 ]; then
    fail "${bad} case(s) of ${file} failed or were skipped"
    grep -E "^[[:space:]]*(×|✗|↓) ${file} >" "$log" >&2 || true
    return 1
  fi
  if grep -Eq "^[[:space:]]*Tests[[:space:]]+.*(failed|skipped|todo)" "$log"; then
    fail "the summary reports failed/skipped tests"
    grep -E "Test Files|Tests " "$log" >&2 || true
    return 1
  fi
  ran="$(grep -Ec "^[[:space:]]*✓ ${file} >" "$log" || true)"
  ran="${ran:-0}"
  if [ "$ran" -lt "$min" ]; then
    fail "only ${ran} passing case(s) from ${file} (need >= ${min})"
    return 1
  fi
  echo "[events-proof] ${ran} passing (minimum ${min})"
}

if [ -n "${EVENTS_CHECK_LOG:-}" ]; then
  check_group "${EVENTS_CHECK_GROUP:?EVENTS_CHECK_GROUP is required with EVENTS_CHECK_LOG}" "$EVENTS_CHECK_LOG" && { echo "[events-proof] group ${EVENTS_CHECK_GROUP} OK"; exit 0; }
  exit 1
fi

phase="${1:-}"
case "$phase" in
  up)
    mkdir -p "$LOGS"
    node "$PKG/scripts/stack.mjs" up
    : > "$GROUPS_FILE"
    ;;
  test)
    group="${2:-}"
    [ -n "${MIN_PASS[$group]:-}" ] || { echo "usage: $0 test core|consumer|deadletter|rebuild" >&2; exit 2; }
    [ -f "$STATE" ] || { fail "no stack: run '$0 up' first"; exit 1; }
    mkdir -p "$LOGS"
    log="$LOGS/$group.log"
    set +e
    ( cd "$PKG" && NO_COLOR=1 FORCE_COLOR=0 EVENTS_PROOF=1 EVENTS_STATE="$STATE" \
        pnpm exec vitest run --reporter=verbose "test/live/${group}.live.test.ts" ) > "$log" 2>&1
    status=$?
    set -e
    grep -E "^[[:space:]]*(✓|×|↓) test/live/${group}.live.test.ts >|Test Files|Tests " "$log" || true
    if [ "$status" -ne 0 ]; then fail "the ${group} suite exited ${status} (log: $log)"; exit "$status"; fi
    check_group "$group" "$log"
    echo "$group" >> "$GROUPS_FILE"
    echo "[events-proof] group ${group} OK"
    ;;
  alert-fire|alert-hold|alert-resolve)
    exec bash "$PKG/scripts/alert-proof.sh" "$phase"
    ;;
  down)
    node "$PKG/scripts/stack.mjs" down
    if [ -f "$PKG/scripts/alert-proof.sh" ]; then bash "$PKG/scripts/alert-proof.sh" down || true; fi
    missing=""
    for g in $REQUIRED_GROUPS; do grep -qx "$g" "$GROUPS_FILE" 2>/dev/null || missing="$missing $g"; done
    if [ -z "$missing" ]; then
      echo "[events-proof] OK"
    else
      echo "[events-proof] INCOMPLETE: groups not passed in this run:${missing}"
    fi
    ;;
  *)
    echo "usage: $0 up | test <group> | alert-fire | alert-hold | alert-resolve | down" >&2
    exit 2
    ;;
esac
