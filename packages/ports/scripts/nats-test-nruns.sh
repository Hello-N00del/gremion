#!/usr/bin/env bash
#
# N-run determinism artifact for the @gremion/ports JetStream proofs.
#
# nats-test.sh answers "did the suite pass once against a fresh server". A claim
# that it passes EVERY time -- "twenty green runs" -- is only as good as the
# record behind it, and a run count asserted in prose is not a record. This
# script runs nats-test.sh N times in a row (each run starts its own throwaway
# nats container, so no run inherits another's streams or consumers) and leaves
# an artifact that can be read back later:
#
#   <out>/runs.tsv      one row per run: run, exit status, seconds, passing
#                       integration proofs, failing tests (';'-separated)
#   <out>/run-NN.log    the full output of run NN
#   <out>/summary.txt   the distribution: runs, passed, failed, pass rate,
#                       duration min/median/max, and a count per failing test
#
# The summary is also printed. The exit status is 0 only when EVERY run passed,
# so the script can gate a claim as well as record it.
#
#   ./packages/ports/scripts/nats-test-nruns.sh [N]        # or: make test-ports-nats-nruns N=20
#
# Environment:
#   NATS_NRUN_COUNT          runs (default 20; the positional argument wins)
#   NATS_NRUN_OUT            output directory (default: a new directory under
#                            ${TMPDIR:-/tmp}; created if missing, never cleaned)
#   NATS_NRUN_STOP_ON_FAIL   1 = stop at the first failing run (default 0: the
#                            point is the distribution, so every run is made)
#   NATS_NRUN_TARGET         the script to repeat (default: nats-test.sh next to
#                            this file). The self-test points it at a stand-in.
#
# Every NATS_TEST_* variable nats-test.sh understands passes straight through.
# The runs are sequential: nats-test.sh publishes a fixed host port and refuses
# to start while another container holds it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${NATS_NRUN_TARGET:-$HERE/nats-test.sh}"
COUNT="${1-${NATS_NRUN_COUNT:-20}}"
STOP_ON_FAIL="${NATS_NRUN_STOP_ON_FAIL:-0}"

usage() {
  echo "usage: nats-test-nruns.sh [N]   (N = a positive whole number of runs; NATS_NRUN_COUNT is the default)" >&2
}

case "$COUNT" in
  '' | *[!0-9]* | 0 | 0[0-9]*)
    echo "[nats-nruns] FAILED: the run count must be a positive whole number, got '$COUNT'" >&2
    usage
    exit 2
    ;;
esac
if [ ! -f "$TARGET" ]; then
  echo "[nats-nruns] FAILED: no script to repeat at $TARGET" >&2
  exit 2
fi

OUT="${NATS_NRUN_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/gremion-ports-nats-nruns.XXXXXX")}"
mkdir -p "$OUT"
TSV="$OUT/runs.tsv"
SUMMARY="$OUT/summary.txt"
printf 'run\texit\tseconds\tproofs\tfailing\n' >"$TSV"

# Log-name width: enough digits for N, at least two.
width="${#COUNT}"
[ "$width" -ge 2 ] || width=2

echo "[nats-nruns] $COUNT run(s) of $TARGET, records in $OUT"

passed=0
failed=0
done_runs=0
durations=()
for ((i = 1; i <= COUNT; i++)); do
  n="$(printf "%0${width}d" "$i")"
  log="$OUT/run-$n.log"
  started="$(date +%s)"
  # The target's own failure is DATA here, not the end of this script.
  set +e
  bash "$TARGET" >"$log" 2>&1
  status=$?
  set -e
  seconds=$(($(date +%s) - started))

  proofs="$(sed -n 's/^\[nats-test\] \([0-9][0-9]*\) passing tests from .*/\1/p' "$log" | tail -n 1)"
  proofs="${proofs:--}"
  # vitest's verbose reporter prints ` FAIL  <file> > <suite> > <test>` per
  # failing test (NO_COLOR is set by the target, so the line is plain text).
  failing="$(sed -n 's/^[[:space:]]*FAIL[[:space:]][[:space:]]*//p' "$log" | sort -u | paste -sd ';' -)"
  failing="${failing:--}"

  printf '%s\t%s\t%s\t%s\t%s\n' "$i" "$status" "$seconds" "$proofs" "$failing" >>"$TSV"
  durations+=("$seconds")
  done_runs=$((done_runs + 1))
  if [ "$status" -eq 0 ]; then
    passed=$((passed + 1))
    echo "[nats-nruns] run $i/$COUNT: PASS (${seconds}s, ${proofs} proofs)"
  else
    failed=$((failed + 1))
    echo "[nats-nruns] run $i/$COUNT: FAIL exit $status (${seconds}s) -- $log" >&2
    if [ "$STOP_ON_FAIL" = "1" ]; then
      echo "[nats-nruns] stopping at the first failure (NATS_NRUN_STOP_ON_FAIL=1)" >&2
      break
    fi
  fi
done

# Duration spread. Sorted numerically; the median of an even count is the lower
# of the two middle values (a whole second is all the clock resolves anyway).
sorted="$(printf '%s\n' "${durations[@]}" | sort -n)"
dmin="$(printf '%s\n' "$sorted" | head -n 1)"
dmax="$(printf '%s\n' "$sorted" | tail -n 1)"
dmed="$(printf '%s\n' "$sorted" | sed -n "$(((done_runs + 1) / 2))p")"

# One count per failing test across the runs that failed it (the TSV column is
# already de-duplicated within a run).
by_test="$(tail -n +2 "$TSV" | cut -f5 | tr ';' '\n' | grep -v '^-$' | sort | uniq -c | sort -rn | sed 's/^ *\([0-9][0-9]*\) /  \1x /' || true)"

{
  echo "NATS port proofs, N-run record"
  echo "  date          $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "  tree          $(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)$(git -C "$HERE" diff --quiet HEAD -- 2>/dev/null || echo ' (+ uncommitted changes)')"
  echo "  image         ${NATS_TEST_IMAGE:-nats:2.12-alpine}"
  echo "  target        $TARGET"
  echo "  runs          $done_runs of $COUNT requested"
  echo "  passed        $passed"
  echo "  failed        $failed"
  echo "  pass rate     $((passed * 100 / done_runs))%"
  echo "  seconds/run   min $dmin, median $dmed, max $dmax"
  if [ -n "$by_test" ]; then
    echo "  failing tests (runs that failed each):"
    printf '%s\n' "$by_test"
  fi
  echo "  records       $TSV"
} >"$SUMMARY"

cat "$SUMMARY"

# A short run (stopped early) is not the claim that was asked for.
if [ "$failed" -ne 0 ] || [ "$done_runs" -ne "$COUNT" ]; then
  echo "[nats-nruns] FAILED: $passed of $COUNT run(s) passed" >&2
  exit 1
fi
echo "[nats-nruns] OK -- all $COUNT run(s) passed"
