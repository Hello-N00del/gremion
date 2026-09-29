#!/bin/bash
# test-retained-prune.sh — R28-VECTOR-RETENTION: the day-bucketed retained sink
# (/logs/processed/retained-YYYY-MM-DD.log, written by vector.toml) is pruned by
# the DATE IN THE FILE NAME, never by mtime.
#
# Why a dedicated prune step: logrotate applies `maxage` only to a log it is
# rotating (logrotate(8): "The age is only checked if the logfile is to be
# rotated"). Each day file is rotated once (-> .1, empty base re-created) and
# `notifempty` then stops every later rotation, so its `.1` was never compressed
# nor deleted — the running host held every retained day since first deploy.
#
# Deterministic: a fixed "today" (RETAINED_TODAY) chosen so the offsets cross a
# month boundary and a 28-day February. Expected dates are written out by hand,
# not computed with the code under test.
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
# 1. Name-dated pruning at the 31-day retention.
#    today = 2026-03-02 (2026 is not a leap year):
#      today-40 = 2026-01-21   today-32 = 2026-01-29   today-31 = 2026-01-30
#      today-30 = 2026-01-31   today-1  = 2026-03-01   today    = 2026-03-02
#    > 31 days old (must be gone): 2026-01-21, 2026-01-29.
#    <= 31 days old (must stay):   2026-01-30, 2026-01-31, 2026-03-01, 2026-03-02.
# ---------------------------------------------------------------------------
T1="$WORK/case1"; mkdir -p "$T1"
for d in 2026-01-21 2026-01-29 2026-01-30 2026-01-31 2026-03-01 2026-03-02; do
  : > "$T1/retained-$d.log"            # the EMPTY base left by the one rotation
  echo '{"x":1}' > "$T1/retained-$d.log.1"
  echo 'gz' > "$T1/retained-$d.log.1.gz"
done
echo '{"x":1}' > "$T1/retained-2026-03-02.log"   # today's live file has data
echo 'gz' > "$T1/retained-2026-01-21.log.2.gz"   # any generation N
# Files the prune step must never touch.
echo '{}' > "$T1/security.log"
echo '{}' > "$T1/security.log.1"
echo 'gz' > "$T1/security.log.2.gz"
echo '{}' > "$T1/retained-notadate.log"
echo '{}' > "$T1/keep-2026-01-01.log"
# mtime must NOT drive the decision: make an old-by-name file look brand new and
# a kept-by-name file look ancient.
touch "$T1/retained-2026-01-21.log.1"
touch -d '2000-01-01 00:00:00' "$T1/retained-2026-03-01.log.1" 2>/dev/null || true

run_prune "$T1" RETAINED_TODAY=2026-03-02 RETAINED_RETENTION_DAYS=31
check $? "prune exits 0 on a valid run"

expected1="keep-2026-01-01.log
retained-2026-01-30.log
retained-2026-01-30.log.1
retained-2026-01-30.log.1.gz
retained-2026-01-31.log
retained-2026-01-31.log.1
retained-2026-01-31.log.1.gz
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
actual1="$(listing "$T1")"
[ "$actual1" = "$expected1" ]
check $? "exactly the > 31-day retained files (base, .N, .N.gz) are gone; the rest are kept"
if [ "$actual1" != "$expected1" ]; then
  echo "  expected:"; echo "$expected1" | sed 's/^/    /'
  echo "  actual:";   echo "$actual1"   | sed 's/^/    /'
fi

[ ! -e "$T1/retained-2026-01-29.log" ] && [ ! -e "$T1/retained-2026-01-21.log" ]
check $? "the empty base files of the aged-out days are removed with their day"

[ -e "$T1/retained-2026-01-30.log.1" ]
check $? "the boundary day (exactly 31 days old) is kept"

# ---------------------------------------------------------------------------
# 2. Fail safe: an unusable clock or retention value deletes NOTHING and exits
#    non-zero (the entrypoint loop reports it on stderr).
# ---------------------------------------------------------------------------
T2="$WORK/case2"; mkdir -p "$T2"
echo '{}' > "$T2/retained-2000-01-01.log"
echo '{}' > "$T2/retained-2000-01-01.log.1"

run_prune "$T2" RETAINED_TODAY=not-a-date RETAINED_RETENTION_DAYS=31
rc=$?; [ "$rc" -ne 0 ] && [ -e "$T2/retained-2000-01-01.log" ] && [ -e "$T2/retained-2000-01-01.log.1" ]
check $? "invalid RETAINED_TODAY: non-zero exit, nothing deleted"

run_prune "$T2" RETAINED_TODAY=2026-02-30 RETAINED_RETENTION_DAYS=31
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
# 3. Defaults: real UTC clock and the 31-day default retention.
# ---------------------------------------------------------------------------
T3="$WORK/case3"; mkdir -p "$T3"
today_utc="$(date -u +%Y-%m-%d)"
echo '{}' > "$T3/retained-2000-01-01.log.1"
echo '{}' > "$T3/retained-$today_utc.log"
run_prune "$T3"
rc=$?; [ "$rc" -eq 0 ] && [ ! -e "$T3/retained-2000-01-01.log.1" ] && [ -e "$T3/retained-$today_utc.log" ]
check $? "defaults (UTC today, 31 days): an ancient day is pruned, today's file is kept"

# ---------------------------------------------------------------------------
# 4. The retention value is honoured (not hard-wired to 31).
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
