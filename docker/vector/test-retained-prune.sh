#!/bin/bash
# test-retained-prune.sh — R28-VECTOR-RETENTION / R29-RETENTION-30: the day-bucketed
# retained sink (/logs/processed/retained-YYYY-MM-DD.log, written by vector.toml)
# is pruned by the DATE IN THE FILE NAME, never by mtime.
#
# Why a dedicated prune step: logrotate applies `maxage` only to a log it is
# rotating (logrotate(8): "The age is only checked if the logfile is to be
# rotated"). Each day file is rotated once (-> .1, empty base re-created) and
# `notifempty` then stops every later rotation, so its `.1` was never compressed
# nor deleted — the running host held every retained day since first deploy.
#
# Window: R29-RETENTION-30 [D R29-I6] keeps today-27 .. today (UTC), 28 calendar
# days; the worst-case record age of the family is computed in
# test-edge-retention-bound.sh (29 d + 2 h 5 min against the 30 d bound).
#
# Deterministic: a fixed "today" (RETAINED_TODAY) chosen so the offsets cross a
# month boundary and a 28-day February. The expected dates are derived once with
# GNU date and written out by hand, not computed with the code under test:
#   date -u -d '2026-03-02 -27 days' +%F   ->  2026-02-03   (kept: the boundary)
#   date -u -d '2026-03-02 -28 days' +%F   ->  2026-02-02   (gone)
#   date -u -d '2026-03-02 -30 days' +%F   ->  2026-01-31   (gone)
#
# Runs anywhere with bash + GNU or busybox coreutils; the prune script itself is
# executed with `sh` (dash on the Debian-based vector image) to keep it POSIX.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PRUNE="$DIR/prune-retained.sh"
fail=0

check() {
  # check "<exit-code>" "<description>"
  if [ "$1" -eq 0 ]; then
    echo "PASS: $2"
  else
    echo "FAIL: $2"
    fail=1
  fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/retained-prune.XXXXXX")" || { echo "FAIL: mktemp"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

run_prune() {
  # run_prune <dir> [VAR=value ...] — returns the prune script's exit code
  local d="$1"; shift
  env RETAINED_DIR="$d" "$@" sh "$PRUNE" >"$WORK/prune.out" 2>&1
}

listing() { (cd "$1" && ls -1A | LC_ALL=C sort); }

# ---------------------------------------------------------------------------
# 1. Name-dated pruning at the 27-day window, at the explicit value and at the
#    default.
#    today = 2026-03-02 (2026 is not a leap year):
#      today-40 = 2026-01-21   today-30 = 2026-01-31   today-28 = 2026-02-02
#      today-27 = 2026-02-03   today-1  = 2026-03-01   today    = 2026-03-02
#    > 27 days old (must be gone): 2026-01-21, 2026-01-31, 2026-02-02.
#    <= 27 days old (must stay):   2026-02-03, 2026-03-01, 2026-03-02.
# ---------------------------------------------------------------------------
build_case1() {
  local T="$1"
  mkdir -p "$T"
  for d in 2026-01-21 2026-01-31 2026-02-02 2026-02-03 2026-03-01 2026-03-02; do
    : > "$T/retained-$d.log"            # the EMPTY base left by the one rotation
    echo '{"x":1}' > "$T/retained-$d.log.1"
    echo 'gz' > "$T/retained-$d.log.1.gz"
  done
  echo '{"x":1}' > "$T/retained-2026-03-02.log"   # today's live file has data
  echo 'gz' > "$T/retained-2026-01-21.log.2.gz"   # any generation N
  echo 'gz' > "$T/retained-2026-02-02.log.27.gz"  # the highest configured generation
  # Files the prune step must never touch.
  echo '{}' > "$T/security.log"
  echo '{}' > "$T/security.log.1"
  echo 'gz' > "$T/security.log.2.gz"
  echo '{}' > "$T/retained-notadate.log"
  echo '{}' > "$T/keep-2026-01-01.log"
  echo '{}' > "$T/.logrotate.status"                # the logrotate state file
  # mtime must NOT drive the decision: make an old-by-name file look brand new and
  # a kept-by-name file look ancient.
  touch "$T/retained-2026-01-21.log.1"
  touch -d '2000-06-15 12:00:00' "$T/retained-2026-02-03.log.1"
}

expected1="keep-2026-01-01.log
.logrotate.status
retained-2026-02-03.log
retained-2026-02-03.log.1
retained-2026-02-03.log.1.gz
retained-2026-03-01.log
retained-2026-03-01.log.1
retained-2026-03-01.log.1.gz
retained-2026-03-02.log
retained-2026-03-02.log.1
retained-2026-03-02.log.1.gz
retained-notadate.log
security.log
security.log.1
security.log.2.gz"
# ls -A sorts the dot file first under C collation; keep expected in that order.
expected1="$(printf '%s\n' "$expected1" | LC_ALL=C sort)"

T1="$WORK/case1"; build_case1 "$T1"
# A touch without -d support (or a failed backdate) must not pass silently: the
# "mtime must NOT drive the decision" claim below is only proven if the mtime
# really is ancient. Mid-year, local-to-local: no timezone can move the year.
[ "$(date -r "$T1/retained-2026-02-03.log.1" +%Y)" = 2000 ]
check $? "precondition: touch -d backdated retained-2026-02-03.log.1 to year 2000 (else the mtime-independence check is vacuous)"

run_prune "$T1" RETAINED_TODAY=2026-03-02 RETAINED_RETENTION_DAYS=27
check $? "prune exits 0 on a valid run (explicit RETAINED_RETENTION_DAYS=27)"

actual1="$(listing "$T1")"
[ "$actual1" = "$expected1" ]
check $? "explicit 27: exactly the > 27-day retained files (base, .N, .N.gz) are gone; the rest are kept"
if [ "$actual1" != "$expected1" ]; then
  echo "  expected:"; echo "$expected1" | sed 's/^/    /'
  echo "  actual:";   echo "$actual1"   | sed 's/^/    /'
fi

T1D="$WORK/case1-default"; build_case1 "$T1D"
run_prune "$T1D" RETAINED_TODAY=2026-03-02
check $? "prune exits 0 on a valid run (default window)"
actual1d="$(listing "$T1D")"
[ "$actual1d" = "$expected1" ]
check $? "default window: the same files are gone and kept as at the explicit 27 (default = 27)"
if [ "$actual1d" != "$expected1" ]; then
  echo "  expected:"; echo "$expected1" | sed 's/^/    /'
  echo "  actual:";   echo "$actual1d"  | sed 's/^/    /'
fi

[ ! -e "$T1/retained-2026-02-02.log" ] && [ ! -e "$T1/retained-2026-01-21.log" ] && [ ! -e "$T1/retained-2026-01-31.log" ]
check $? "the empty base files of the aged-out days are removed with their day"

[ -e "$T1/retained-2026-02-03.log.1" ] && [ ! -e "$T1/retained-2026-02-02.log.1" ] && [ ! -e "$T1/retained-2026-01-31.log.1" ]
check $? "the boundary day today-27 (2026-02-03) is kept; today-28 (2026-02-02) and today-30 (2026-01-31) are gone"

[ -e "$T1/.logrotate.status" ]
check $? "the logrotate state file in the same directory is never touched"

# ---------------------------------------------------------------------------
# 2. Fail safe: an unusable clock or retention value deletes NOTHING and exits
#    non-zero (the entrypoint loop reports it on stderr).
# ---------------------------------------------------------------------------
T2="$WORK/case2"; mkdir -p "$T2"
echo '{}' > "$T2/retained-2000-01-01.log"
echo '{}' > "$T2/retained-2000-01-01.log.1"

run_prune "$T2" RETAINED_TODAY=not-a-date RETAINED_RETENTION_DAYS=27
rc=$?; [ "$rc" -ne 0 ] && [ -e "$T2/retained-2000-01-01.log" ] && [ -e "$T2/retained-2000-01-01.log.1" ]
check $? "invalid RETAINED_TODAY: non-zero exit, nothing deleted"

run_prune "$T2" RETAINED_TODAY=2026-02-30 RETAINED_RETENTION_DAYS=27
rc=$?; [ "$rc" -ne 0 ] && [ -e "$T2/retained-2000-01-01.log" ]
check $? "non-calendar RETAINED_TODAY (2026-02-30): non-zero exit, nothing deleted"

run_prune "$T2" RETAINED_TODAY=2026-03-02 RETAINED_RETENTION_DAYS=abc
rc=$?; [ "$rc" -ne 0 ] && [ -e "$T2/retained-2000-01-01.log" ]
check $? "non-numeric retention: non-zero exit, nothing deleted"

run_prune "$T2" RETAINED_TODAY=2026-03-02 RETAINED_RETENTION_DAYS=0
rc=$?; [ "$rc" -ne 0 ] && [ -e "$T2/retained-2000-01-01.log" ]
check $? "zero retention: non-zero exit, nothing deleted"

run_prune "$WORK/does-not-exist" RETAINED_TODAY=2026-03-02
check $? "a missing log directory is not an error (nothing written yet)"

# ---------------------------------------------------------------------------
# 3. Defaults: real UTC clock and the 27-day default window. The boundary is
#    derived with `date -u`, so the case holds on any day the suite runs.
# ---------------------------------------------------------------------------
T3="$WORK/case3"; mkdir -p "$T3"
today_utc="$(date -u +%Y-%m-%d)"
d27="$(date -u -d '27 days ago' +%Y-%m-%d)"
d28="$(date -u -d '28 days ago' +%Y-%m-%d)"
echo '{}' > "$T3/retained-2000-01-01.log.1"
echo '{}' > "$T3/retained-$today_utc.log"
echo '{}' > "$T3/retained-$d27.log.1"
echo '{}' > "$T3/retained-$d28.log.1"
run_prune "$T3"
rc=$?; [ "$rc" -eq 0 ] && [ ! -e "$T3/retained-2000-01-01.log.1" ] && [ -e "$T3/retained-$today_utc.log" ]
check $? "defaults (UTC today, 27 days): an ancient day is pruned, today's file is kept"
[ ! -e "$T3/retained-$d28.log.1" ] && [ -e "$T3/retained-$d27.log.1" ]
check $? "defaults on the real UTC clock: a file dated today-28 is removed, today-27 is kept"

# The default itself: one number, stated in the script.
grep -qE 'RETAINED_RETENTION_DAYS:-27\}' "$PRUNE"
check $? "prune-retained.sh default RETAINED_RETENTION_DAYS is 27"

# ---------------------------------------------------------------------------
# 4. The retention value is honoured (not hard-wired to 27).
# ---------------------------------------------------------------------------
T4="$WORK/case4"; mkdir -p "$T4"
echo '{}' > "$T4/retained-2026-02-22.log"   # today-8 -> gone at 7 days
echo '{}' > "$T4/retained-2026-02-23.log"   # today-7 -> kept
run_prune "$T4" RETAINED_TODAY=2026-03-02 RETAINED_RETENTION_DAYS=7
rc=$?; [ "$rc" -eq 0 ] && [ ! -e "$T4/retained-2026-02-22.log" ] && [ -e "$T4/retained-2026-02-23.log" ]
check $? "RETAINED_RETENTION_DAYS=7 prunes today-8 and keeps today-7"

# ---------------------------------------------------------------------------
# 5. Wiring: the image ships the script and the container's own loop runs it,
#    reporting (not swallowing) a failure.
# ---------------------------------------------------------------------------
grep -qE '^COPY prune-retained\.sh /usr/local/bin/prune-retained\.sh$' "$DIR/Dockerfile" \
  && grep -qE 'chmod \+x /usr/local/bin/prune-retained\.sh' "$DIR/Dockerfile"
check $? "Dockerfile installs prune-retained.sh as an executable"

awk '/^while true; do$/{inloop=1} inloop && /prune-retained\.sh/{found=1} /^done &$/{inloop=0} END{exit !found}' "$DIR/entrypoint.sh"
check $? "entrypoint.sh runs prune-retained.sh inside the rotation loop"

grep -qE 'prune-retained\.sh[^#]*\|\|[^#]*>&2' "$DIR/entrypoint.sh"
check $? "entrypoint.sh reports a prune failure on stderr"

if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
