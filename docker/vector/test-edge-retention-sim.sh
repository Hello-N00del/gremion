#!/bin/bash
# test-edge-retention-sim.sh - R29-RETENTION-30: 60 simulated days through the
# REAL logrotate and the shipped prune-retained.sh, inside the built image:
#
#   docker build -t <img> docker/vector
#   docker run --rm --entrypoint bash -v "<wt>/docker/vector:/t:ro" <img> /t/test-edge-retention-sim.sh
#
# It refuses to run outside a container: it writes /logs/traefik and
# /logs/processed and rewrites file mtimes.
#
# Order of each simulated day n (pinned, so a guard cannot pass by ordering):
#   (1) age every file by 86400 s (mtime) and set the logrotate state entries to
#       real yesterday, so `daily` fires again on the same real day;
#   (2) run `logrotate -s <state> <conf>` and the prune with RETAINED_TODAY = day n
#       (timed: one run must stay within R = 300 s);
#   (3) on a traffic day stamp records `D=<n>` into access.log, traefik.log,
#       security.log and retained-<day n>.log;
#   (4) measure: every surviving D (plain and zcat) must be >= n-14 for access.log
#       and traefik.log and >= n-27 for security.log and the retained family.
# Traffic: days 1-20 yes, 21-40 none, 41-60 yes. The quiet stretch is what
# `notifempty` used to stretch past the bound.
#
# Test hooks (RED runs against an older or mutated copy): SIM_CONF (logrotate
# config, default /etc/logrotate.d/vector-logs) and SIM_PRUNE (default
# /usr/local/bin/prune-retained.sh), both copied to a scratch path first.
set -u

CONF_SRC="${SIM_CONF:-/etc/logrotate.d/vector-logs}"
PRUNE_SRC="${SIM_PRUNE:-/usr/local/bin/prune-retained.sh}"
DAYS=60
R_MAX=300
BASE_DATE=2026-01-01

if [ ! -e /.dockerenv ] && [ "${SIM_ALLOW:-}" != 1 ]; then
  echo "FAIL: refusing to run outside a container (writes /logs, rewrites mtimes)"
  exit 2
fi
for c in logrotate zcat; do
  command -v "$c" >/dev/null 2>&1 || { echo "FAIL: $c not installed (run inside the built vector image)"; exit 2; }
done
[ -f "$CONF_SRC" ] || { echo "FAIL: no logrotate config at $CONF_SRC"; exit 2; }
[ -f "$PRUNE_SRC" ] || { echo "FAIL: no prune script at $PRUNE_SRC"; exit 2; }
if [ -n "$(ls -A /logs/processed 2>/dev/null)" ] || [ -n "$(ls -A /logs/traefik 2>/dev/null)" ]; then
  echo "FAIL: /logs is not empty; refusing to touch existing logs"
  exit 2
fi

WORK=/tmp/edge-sim
rm -rf "$WORK"
mkdir -p "$WORK" /logs/traefik /logs/processed
cp "$CONF_SRC" "$WORK/vector-logs"
chmod 0644 "$WORK/vector-logs"
cp "$PRUNE_SRC" "$WORK/prune-retained.sh"
STATE="$WORK/state"

fail=0
declare -A first_bad maxobs seen_gz
FAMILIES="access traefik security retained"
declare -A CUT=([access]=14 [traefik]=14 [security]=27 [retained]=27)
declare -A GLOB_DIR=([access]=/logs/traefik [traefik]=/logs/traefik [security]=/logs/processed [retained]=/logs/processed)
declare -A GLOB_PFX=([access]=access.log [traefik]=traefik.log [security]=security.log [retained]=retained-)
for fam in $FAMILIES; do maxobs[$fam]=-1; seen_gz[$fam]=0; done

age_files() {
  local f m
  while IFS= read -r -d '' f; do
    m=$(stat -c %Y "$f")
    touch -d "@$((m - 86400))" "$f"
  done < <(find /logs -type f -print0)
}

write_state() {
  local y f
  y=$(date -u -d yesterday +%Y-%-m-%-d-0:0:0)
  {
    echo "logrotate state -- version 2"
    for f in /logs/traefik/access.log /logs/traefik/traefik.log /logs/processed/security.log /logs/processed/retained-*.log; do
      [ -f "$f" ] && echo "\"$f\" $y"
    done
  } >"$STATE"
}

stamp() {
  # stamp <n> <simdate>
  local n=$1 sd=$2
  echo "D=$n sim-record" >>/logs/traefik/access.log
  echo "D=$n sim-record" >>/logs/traefik/traefik.log
  echo "D=$n sim-record" >>/logs/processed/security.log
  echo "D=$n sim-record" >>"/logs/processed/retained-$sd.log"
}

oldest_d() {
  # oldest_d <family> -> OLD (smallest surviving D, empty when none); GZ set when a .gz was read
  local fam=$1 f d
  OLD=""
  GZ=0
  for f in "${GLOB_DIR[$fam]}/${GLOB_PFX[$fam]}"*; do
    [ -f "$f" ] || continue
    case "$f" in
      *.gz)
        GZ=1
        out=$(zcat "$f" 2>/dev/null)
        ;;
      *) out=$(cat "$f") ;;
    esac
    for d in $(printf '%s\n' "$out" | grep -o 'D=[0-9]*' | cut -d= -f2); do
      if [ -z "$OLD" ] || [ "$d" -lt "$OLD" ]; then OLD=$d; fi
    done
  done
}

echo "simulating $DAYS days: conf=$CONF_SRC prune=$PRUNE_SRC"
for n in $(seq 1 "$DAYS"); do
  sd=$(date -u -d "$BASE_DATE +$n days" +%F)
  # (1) age
  age_files
  write_state
  # (2) rotate + prune, timed
  t0=$EPOCHREALTIME
  lr_out=$(logrotate -s "$STATE" "$WORK/vector-logs" 2>&1)
  lr_rc=$?
  pr_out=$(RETAINED_DIR=/logs/processed RETAINED_TODAY="$sd" sh "$WORK/prune-retained.sh" 2>&1)
  pr_rc=$?
  t1=$EPOCHREALTIME
  # EPOCHREALTIME is seconds.microseconds; compare in whole seconds
  run_s=$(((${t1/./} - ${t0/./}) / 1000000))
  if [ "$lr_rc" -ne 0 ]; then
    echo "FAIL day $n: logrotate exited $lr_rc"
    echo "$lr_out" | head -5
    fail=1
  fi
  if [ "$pr_rc" -ne 0 ]; then
    echo "FAIL day $n: prune exited $pr_rc"
    echo "$pr_out" | head -5
    fail=1
  fi
  if [ "$run_s" -gt "$R_MAX" ]; then
    echo "FAIL day $n: one loop run took ${run_s}s > R = ${R_MAX}s"
    fail=1
  fi
  # (3) traffic
  if [ "$n" -le 20 ] || [ "$n" -ge 41 ]; then
    stamp "$n" "$sd"
  fi
  # (4) measure
  for fam in $FAMILIES; do
    oldest_d "$fam"
    [ "$GZ" -eq 1 ] && seen_gz[$fam]=1
    [ -z "$OLD" ] && continue
    age=$((n - OLD))
    [ "$age" -gt "${maxobs[$fam]}" ] && maxobs[$fam]=$age
    if [ "$age" -gt "${CUT[$fam]}" ]; then
      fail=1
      if [ -z "${first_bad[$fam]:-}" ]; then
        first_bad[$fam]="day $n"
        echo "FAIL day $n family $fam: oldest surviving record D=$OLD is $age days old, limit ${CUT[$fam]}"
      fi
    fi
  done
done

for fam in $FAMILIES; do
  if [ "${maxobs[$fam]}" -lt 1 ]; then
    echo "FAIL family $fam: never held a record older than a day (the simulation proved nothing)"
    fail=1
  fi
  if [ "$fam" != retained ] && [ "${seen_gz[$fam]}" -ne 1 ]; then
    echo "FAIL family $fam: no compressed generation was ever read back (zcat path untested)"
    fail=1
  fi
  echo "family $fam: oldest record ever seen ${maxobs[$fam]} d (limit ${CUT[$fam]} d)"
done

if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
