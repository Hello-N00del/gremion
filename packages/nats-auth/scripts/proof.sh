#!/usr/bin/env bash
#
# The TASK-024 acceptance against a REAL broker (TRD-419, D12).
#
#   packages/nats-auth/scripts/proof.sh --auth   the kernel's broker: the
#       state project's image by digest, docker/nats/nats.conf and an
#       accounts file ensureTenantAccount() renders. Every case must pass.
#   packages/nats-auth/scripts/proof.sh --open   today's open broker (-js, no
#       config -- the StuRaOS test env's shape). The RECORD that the A cases
#       test something an open broker does not do: every A case must FAIL and
#       every F case PASS. This mode always exits non-zero: 1 when that
#       pattern holds, 2 when it does not.
#
# Pattern of packages/ports/scripts/nats-test.sh (which stays the OPEN library
# proof): a uniquely named container (t024-<sha8>-nats-<mode>) on an ephemeral
# loopback port, removed BY NAME on exit, never a prune; its log printed on
# failure. Config, seeds and the suite output live in
# .scratch/t024/proof-<mode>/ (git-ignored), never in mktemp. The monitor is
# bound to the container's loopback (nats.conf), so the healthcheck and the
# suite read it with `docker exec`.
#
# Post-condition, not exit code: the verbose reporter's per-test lines for
# test/live/nats-auth.live.test.ts are counted, and --auth fails below
#   [nats-auth-proof] N passing (minimum MIN_PASS)
# Guard-efficacy hook: NATS_AUTH_CHECK_LOG=<file> runs only the post-condition
# for the given mode against that log (no docker, no vitest).
#
# Q12: in --auth, `nats-auth init` runs BEFORE the broker starts, as it does
# before the first state up on a host.

set -euo pipefail

MODE=""
case "${1:-}" in
  --auth) MODE=auth ;;
  --open) MODE=open ;;
  *) echo "usage: $0 --auth | --open" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# The SAME reference as the nats service in docker-compose.yml.
IMAGE="${NATS_AUTH_IMAGE:-nats:2.12.15-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6}"
LIVE_FILE="test/live/nats-auth.live.test.ts"
# A minimum, not an exact count (25 cases today): adding a case needs no
# edit here, removing one below the floor fails until lowered on purpose --
# in this file, never from the environment (the verify judge pins it too).
MIN_PASS=25
OPEN_F_CASES=4
READY_TIMEOUT_S="${NATS_AUTH_READY_TIMEOUT_S:-60}"

fail() { echo "[nats-auth-proof] FAILED: $*" >&2; }

# --auth: every case of the live file passed, none skipped, at least MIN_PASS.
check_auth() {
  local log="$1" ran bad
  # An unreadable log must never read as zero failures: grep would print
  # nothing, the numeric tests below would error, and inside `&&` / `if`
  # errexit does not fire.
  if [ ! -r "$log" ] || [ ! -s "$log" ]; then
    fail "no readable log at $log"
    return 1
  fi
  bad="$(grep -Ec "^[[:space:]]*(×|✗|↓) ${LIVE_FILE} >" "$log" || true)"
  bad="${bad:-0}"
  if [ "$bad" -ne 0 ]; then
    fail "${bad} case(s) of ${LIVE_FILE} failed or were skipped"
    grep -E "^[[:space:]]*(×|✗|↓) ${LIVE_FILE} >" "$log" >&2 || true
    return 1
  fi
  if grep -Eq "^[[:space:]]*Tests[[:space:]]+.*(failed|skipped|todo)" "$log"; then
    fail "the summary reports failed/skipped tests"
    grep -E "Test Files|Tests " "$log" >&2 || true
    return 1
  fi
  ran="$(grep -Ec "^[[:space:]]*✓ ${LIVE_FILE} >" "$log" || true)"
  ran="${ran:-0}"
  if [ "$ran" -lt "$MIN_PASS" ]; then
    fail "only ${ran} passing case(s) from ${LIVE_FILE} (need >= ${MIN_PASS})"
    return 1
  fi
  echo "[nats-auth-proof] ${ran} passing (minimum ${MIN_PASS})"
}

# --open: every A case failed, every F case passed. Returns 0 when the
# record holds (the caller still exits 1: the suite failed, as it must).
check_open() {
  local log="$1" a_total a_red f_green
  if [ ! -r "$log" ] || [ ! -s "$log" ]; then
    fail "no readable log at $log"
    return 1
  fi
  # A skipped (↓) A case counts in the total and not as RED: it fails the record.
  a_total="$(grep -Ec "^[[:space:]]*(✓|×|↓) ${LIVE_FILE} > A[0-9]" "$log" || true)"
  a_red="$(grep -Ec "^[[:space:]]*× ${LIVE_FILE} > A[0-9]" "$log" || true)"
  f_green="$(grep -Ec "^[[:space:]]*✓ ${LIVE_FILE} > F " "$log" || true)"
  a_total="${a_total:-0}" a_red="${a_red:-0}" f_green="${f_green:-0}"
  echo "[nats-auth-proof] open broker: A cases RED ${a_red}/${a_total}, F cases GREEN ${f_green}/${OPEN_F_CASES}"
  if [ "$a_total" -eq 0 ] || [ "$a_red" -ne "$a_total" ]; then
    fail "an A case PASSED against the open broker (or none ran) -- it does not test authentication"
    grep -E "^[[:space:]]*✓ ${LIVE_FILE} > A[0-9]" "$log" >&2 || true
    return 1
  fi
  if [ "$f_green" -ne "$OPEN_F_CASES" ]; then
    fail "an F case failed against the open broker -- the flow test itself is broken"
    return 1
  fi
}

if [ -n "${NATS_AUTH_CHECK_LOG:-}" ]; then
  if [ "$MODE" = auth ]; then
    check_auth "$NATS_AUTH_CHECK_LOG" && { echo "[nats-auth-proof] OK"; exit 0; }
    exit 1
  fi
  check_open "$NATS_AUTH_CHECK_LOG" && exit 1
  exit 2
fi

SHA8="$(git -C "$ROOT" rev-parse --short=8 HEAD)"
CONTAINER="t024-${SHA8}-nats-${MODE}"
SCRATCH="$ROOT/.scratch/t024/proof-${MODE}"
LOG="$SCRATCH/vitest.log"
started=0

cleanup() {
  local rc=$?
  if [ "$started" -eq 1 ] && [ "$rc" -ne 0 ] && [ "$MODE" = auth ]; then
    echo "[nats-auth-proof] exit $rc -- server log of $CONTAINER follows" >&2
    docker logs "$CONTAINER" >&2 2>&1 || true
  fi
  [ -f "$LOG" ] && echo "[nats-auth-proof] suite output kept at $LOG" >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  return "$rc"
}
trap cleanup EXIT

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  fail "a container named $CONTAINER already exists -- another run of this commit in progress? Remove it yourself if not"
  exit 1
fi
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/secrets/nats" "$SCRATCH/accounts"

export NATS_SECRETS_DIR="$SCRATCH/secrets/nats" NATS_ACCOUNTS_DIR="$SCRATCH/accounts"
if [ "$MODE" = auth ]; then
  node "$ROOT/packages/nats-auth/bin/nats-auth.mjs" init
  docker run -d --name "$CONTAINER" -p 127.0.0.1::4222 \
    -v "$ROOT/docker/nats/nats.conf:/etc/nats/nats.conf:ro" \
    -v "$SCRATCH/accounts:/etc/nats/accounts:ro" \
    "$IMAGE" -c /etc/nats/nats.conf >/dev/null
else
  docker run -d --name "$CONTAINER" -p 127.0.0.1::4222 "$IMAGE" -js --store_dir /data -m 8222 >/dev/null
fi
started=1

# The compose healthcheck's own command, inside the container.
echo "[nats-auth-proof] waiting for $CONTAINER to report healthy"
deadline=$(( $(date +%s) + READY_TIMEOUT_S ))
until docker exec "$CONTAINER" wget -qO- "http://127.0.0.1:8222/healthz?js-enabled-only=true" >/dev/null 2>&1; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != true ]; then
    fail "$CONTAINER exited before becoming healthy"
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "$CONTAINER not healthy within ${READY_TIMEOUT_S}s"
    exit 1
  fi
  sleep 0.5
done
PORT="$(docker port "$CONTAINER" 4222/tcp | head -n 1 | sed 's/.*://')"
echo "[nats-auth-proof] $MODE broker $CONTAINER on 127.0.0.1:$PORT"

set +e
(
  cd "$ROOT" && NO_COLOR=1 FORCE_COLOR=0 NATS_AUTH_PROOF="$MODE" NATS_AUTH_URL="nats://127.0.0.1:$PORT" \
    NATS_AUTH_CONTAINER="$CONTAINER" NATS_AUTH_SECRETS="$NATS_SECRETS_DIR" NATS_AUTH_ACCOUNTS="$NATS_ACCOUNTS_DIR" \
    pnpm --filter @gremion/nats-auth exec vitest run --reporter=verbose
) > "$LOG" 2>&1
status=$?
set -e
grep -E "^[[:space:]]*(✓|×|↓) ${LIVE_FILE} >|Test Files|Tests " "$LOG" || true

if [ "$MODE" = open ]; then
  if check_open "$LOG"; then
    echo "[nats-auth-proof] open broker record holds (suite exit $status) -- exit 1 by design"
    exit 1
  fi
  exit 2
fi
if [ "$status" -ne 0 ]; then
  fail "the live suite exited $status"
  exit "$status"
fi
check_auth "$LOG"
echo "[nats-auth-proof] OK -- the authenticated broker admits and refuses as specified"
