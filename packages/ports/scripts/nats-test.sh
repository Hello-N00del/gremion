#!/usr/bin/env bash
#
# Run the @gremion/ports JetStream integration suite against a REAL NATS server.
#
# Integration defect D8 (run findings 11, 25). Before this script the only proof
# that NatsBroker works against real JetStream was a manual `docker run` pasted
# into a comment: nobody could re-run it, so the one gate that exercises the
# changed ensureStream() default and the changed subscribe() error path was, in
# practice, never run. `packages/ports/package.json` has no NATS_TEST_URL, so a
# plain `pnpm --filter @gremion/ports test` SKIPS nats-broker.integration.test.ts
# and still reports green -- a skipped file is not a passing file.
#
# This script is that missing target, committed: it starts a throwaway
# JetStream server, points the suite at it, and tears it down again whatever
# happens. Run it directly, via `make test-ports-nats`, or as part of
# `make test-all`.
#
#   ./packages/ports/scripts/nats-test.sh
#
# Port 14222 is deliberately not 4222 and not the 4224 the older header comment
# used, so a developer's already-running stack (and a stale container from that
# older recipe) cannot collide with this one. The container NAME is unique per
# run, so a container left behind by a crashed run can neither be mistaken for
# this one nor be removed out from under it. A container that still publishes
# the port is NOT removed: it may be another run's live server (a second
# terminal, a parallel worktree, a CI agent) -- round 3 killed whichever
# container held the port, mid-suite. The holder is named and this run refuses;
# NATS_TEST_PORT picks another port.
#
# Post-condition, not exit code. Vitest exits 0 on a fully skipped file AND on a
# file whose every test is skipped individually, so the exit code alone cannot
# tell a passing proof from an absent one. The suite runs with the verbose
# reporter, and the script counts the passing tests it printed FOR THE
# INTEGRATION FILE ITSELF (`✓ src/nats-broker.integration.test.ts > …`), failing
# below a pinned minimum. Round 2's assertions never named the file: a log with
# the file deleted passed every one of them.
#
# Failure is loud. The script's own stderr is never redirected (round 2's
# readiness probe did `exec … 2>/dev/null` in the main shell, which made
# /dev/null the script's stderr for good and discarded every FAILED line that
# followed); on a non-zero exit the server's `docker logs` are printed and the
# vitest output file is kept and named.
#
# Runs from Git Bash on Windows too. The suite is started from the repo root
# with a plain `cd`, not `pnpm --dir "$ROOT"`: on Windows the POSIX path bash
# computes for ROOT (`/c/Users/...`) reaches pnpm unconverted, pnpm resolves it
# against the current drive (`C:\c\Users\...`) and the run dies with ENOENT
# before vitest starts -- which is what happened to every "run it via make"
# attempt on the Windows staging host through round 4.
#
# Guard-efficacy hook: NATS_TEST_CHECK_LOG=<file> runs ONLY the post-condition
# against that file (no docker, no vitest) and exits 0/1. That is how the
# assertion is proved to go RED on a synthetic log lacking the integration file,
# and how .github/workflows/ports.yml applies the same rule to its own run.

set -euo pipefail

PORT="${NATS_TEST_PORT:-14222}"
IMAGE="${NATS_TEST_IMAGE:-nats:2.12-alpine}"
READY_TIMEOUT_S="${NATS_TEST_READY_TIMEOUT_S:-60}"
CONTAINER="${NATS_TEST_CONTAINER:-gremion-nats-test-$$-$(date +%s)}"
# The file whose tests ARE the JetStream proofs, and the MINIMUM number of them
# that must have passed for this run to count. A minimum, not an exact count:
# adding a proof needs no edit here, while removing one below the floor fails
# the gate until the number is lowered on purpose.
INTEGRATION_FILE="src/nats-broker.integration.test.ts"
# ONE place. .github/workflows/ports.yml applies this same post-condition to
# its own run through NATS_TEST_CHECK_LOG, so there is no second copy of the
# number to go stale.
MIN_PROOFS="${NATS_TEST_MIN_PROOFS:-20}"
# Repo root: this file is packages/ports/scripts/nats-test.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

fail() {
  echo "[nats-test] FAILED: $*" >&2
}

# The point of the whole target: prove the JetStream proofs RAN, at every
# granularity -- the file was not skipped, no file failed, no test was skipped,
# and the integration file itself contributed at least MIN_PROOFS passing tests.
assert_proofs_ran() {
  local log="$1"
  if grep -q "SKIPPING: NATS_TEST_URL is not set" "$log"; then
    fail "the integration file SKIPPED -- NATS_TEST_URL did not reach it"
    return 1
  fi
  if ! grep -Eq "^[[:space:]]*Test Files[[:space:]]+[0-9]+ passed \([0-9]+\)" "$log"; then
    fail "no all-passed file summary -- some test file was skipped or failed"
    grep -E "Test Files|Tests " "$log" >&2 || true
    return 1
  fi
  # A file can be collected and still contribute zero running tests
  # (describe.skip, it.skip, a `todo`). The file-level line says nothing about
  # that, and it is exactly how this suite would silently stop proving anything.
  if grep -Eq "^[[:space:]]*Tests[[:space:]]+.*(skipped|todo)" "$log"; then
    fail "some TEST was skipped -- a collected file is not a running file"
    grep -E "Test Files|Tests " "$log" >&2 || true
    return 1
  fi
  if ! grep -Eq "^[[:space:]]*Tests[[:space:]]+[0-9]+ passed \([0-9]+\)" "$log"; then
    fail "no all-passed test summary found -- cannot confirm the proofs ran"
    grep -E "Test Files|Tests " "$log" >&2 || true
    return 1
  fi
  # THE integration file. The verbose reporter prints one
  # `✓ <file> > <suite> > <test> <ms>` line per passing test; count this file's.
  local ran
  ran="$(grep -Fc "✓ ${INTEGRATION_FILE} >" "$log" || true)"
  if [ "$ran" -lt "$MIN_PROOFS" ]; then
    fail "only ${ran} passing test(s) from ${INTEGRATION_FILE} in this run (need >= ${MIN_PROOFS}) -- the JetStream proofs did not run"
    grep -F "$INTEGRATION_FILE" "$log" >&2 || true
    return 1
  fi
  echo "[nats-test] ${ran} passing tests from ${INTEGRATION_FILE} (minimum ${MIN_PROOFS})"
}

if [ -n "${NATS_TEST_CHECK_LOG:-}" ]; then
  if assert_proofs_ran "$NATS_TEST_CHECK_LOG"; then
    echo "[nats-test] OK -- $NATS_TEST_CHECK_LOG passes the post-condition"
    exit 0
  fi
  exit 1
fi

LOG="$(mktemp -t gremion-ports-nats.XXXXXX.log)"
started=0

# Teardown must never mask the real failure or fail the run itself: every step
# is individually tolerated, including docker being absent entirely. On a
# failure the server log and the suite output are what an operator needs, so
# both are surfaced BEFORE anything is removed.
remove_container() {
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$started" -eq 1 ]; then
      echo "[nats-test] exit $rc -- server log of $CONTAINER follows" >&2
      docker logs "$CONTAINER" >&2 2>&1 || true
    fi
    echo "[nats-test] suite output kept at $LOG" >&2
  else
    rm -f "$LOG" 2>/dev/null || true
  fi
  remove_container
  return "$rc"
}
trap cleanup EXIT

# A REAL readiness probe: open a TCP connection and require the NATS protocol's
# INFO greeting -- and require that greeting to say JetStream is enabled, since
# a core-only server answers INFO just the same. "The container is up" and "the
# log said ready" both pass while the port is still refusing connections.
#
# Everything happens inside the command substitution's subshell: the probe's
# file descriptor and the muted stderr of a refused connect end with it, and
# the script's own stderr is never touched.
nats_ready() {
  local banner
  banner="$( { exec 3<>"/dev/tcp/127.0.0.1/${PORT}" && IFS= read -r -t 2 line <&3; printf '%s' "${line:-}"; } 2>/dev/null )" || true
  case "$banner" in
    INFO*'"jetstream":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

echo "[nats-test] starting $IMAGE as $CONTAINER on 127.0.0.1:$PORT (JetStream)"
# A container still publishing our port is not necessarily ours, and this run
# never started one (its name is unique): never remove what another run may be
# using. Name the holder and refuse; the caller picks another port.
holder="$(docker ps --filter "publish=${PORT}" --format '{{.Names}}' 2>/dev/null | head -n 1 || true)"
if [ -n "$holder" ]; then
  fail "127.0.0.1:${PORT} is already published by container ${holder} -- another run in progress? Set NATS_TEST_PORT to a free port, or stop that container yourself"
  exit 1
fi
# No --rm: a container that dies must keep its log until cleanup has printed it.
docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:4222" "$IMAGE" -js >/dev/null
started=1

echo "[nats-test] waiting for a JetStream INFO greeting on 127.0.0.1:$PORT"
ready=0
deadline=$(( $(date +%s) + READY_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  # Twice in a row: a port proxy that accepts one connection and drops the next
  # (seen on Docker Desktop) is not ready either.
  if nats_ready && nats_ready; then
    ready=1
    break
  fi
  # Fail fast if the container died rather than burning the whole timeout.
  # `docker inspect` answers for a container the moment `docker run` returns;
  # `docker ps --filter name=` did not always, and reported a live container as
  # gone.
  if ! container_running; then
    fail "container $CONTAINER exited before becoming ready"
    exit 1
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  fail "$CONTAINER never answered a JetStream INFO greeting on 127.0.0.1:$PORT within ${READY_TIMEOUT_S}s"
  exit 1
fi

# NO_COLOR: the assertions above match vitest's summary and per-test lines.
# With colour on, those lines carry ANSI escapes that break an anchored match
# -- a green run would be reported as a skipped one, or worse, the reverse.
# `exec vitest run` is what the package's `test` script runs, plus the verbose
# reporter the post-condition counts; `--filter` rather than a path because
# downstream this package lives at upstream/gremion/packages/ports. Run from
# the repo root in a subshell (see the header: `--dir "$ROOT"` breaks on
# Windows); PIPESTATUS[0] is the subshell's -- pnpm's -- exit status.
echo "[nats-test] running the ports suite against nats://127.0.0.1:$PORT"
set +e
(
  cd "$ROOT" && NO_COLOR=1 FORCE_COLOR=0 NATS_TEST_URL="nats://127.0.0.1:$PORT" \
    pnpm --filter @gremion/ports exec vitest run --reporter=verbose
) 2>&1 | tee "$LOG"
status="${PIPESTATUS[0]}"
set -e

if [ "$status" -ne 0 ]; then
  fail "ports suite exited $status"
  exit "$status"
fi

assert_proofs_ran "$LOG"

echo "[nats-test] OK -- the JetStream proofs ran against a real server"
