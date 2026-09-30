#!/bin/bash
# test-edge-retention-bound.sh - R29-RETENTION-30 [D R29-I6]: no record kept by
# the edge (Traefik access log, Traefik's own log, the derived security and
# retained logs) outlives B = 30 d = 2592000 s. Static: reads the shipped
# logrotate.conf, prune-retained.sh, entrypoint.sh and docker/traefik/traefik.yml
# and computes the worst-case record age per family. No Docker, no logrotate.
# This script is the ONE place the bound arithmetic lives; the policy doc quotes
# its printed table (docs/log-retention-policy.md, "Upper bound").
#
# Terms (seconds):
#   I  loop interval, as clamped by the entrypoint (<= 3600)
#   R  one loop run (logrotate + compress + prune), allowance 300, measured by
#      test-edge-retention-sim.sh
#   L  ingest lag of a record replayed by process-logs.sh's `tail -F` after a
#      restart (the last 10 lines of the live access.log, at most 1 d + I old);
#      applies to security.log and the retained family only
#   live log family (rotate N):  (N+1) d + I + R
#   security.log family:         (N+1) d + I + R + L
#   retained family (window W):  (W+1) d + I + R + L
#
# Test hooks: EDGE_VECTOR_DIR (directory holding logrotate.conf, entrypoint.sh,
# prune-retained.sh; default: this script's directory) and EDGE_TRAEFIK_YML
# (default: ../traefik/traefik.yml) let a scratch copy be checked, so a mutation
# can be proven RED without touching the tree.
#
# Written with bash builtins where it can: process spawns are slow on Windows.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
VEC="${EDGE_VECTOR_DIR:-$DIR}"
TRAEFIK_YML="${EDGE_TRAEFIK_YML:-$DIR/../traefik/traefik.yml}"
CONF="$VEC/logrotate.conf"
ENTRY="$VEC/entrypoint.sh"
PRUNE="$VEC/prune-retained.sh"

B=2592000
DAY=86400
R=300
# Smallest traefik.yml log.maxSize (MB) that counts as "Traefik never rotates by
# itself": 1000000 MB = 1 TB of cumulative ERROR output, which no volume reaches.
TRAEFIK_MAXSIZE_MIN_MB=1000000
fail=0

bad() {
  echo "FAIL: $*"
  fail=1
}

fmt() {
  # fmt <seconds> -> FMT
  printf -v FMT '%dd %dh %dm' $(($1 / DAY)) $(($1 % DAY / 3600)) $(($1 % 3600 / 60))
}

for f in "$CONF" "$ENTRY" "$PRUNE" "$TRAEFIK_YML"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: missing input $f"
    echo "RESULT: FAIL"
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 1. logrotate.conf -> one record per rule: "<path>\t;dir;dir;dir;"
# ---------------------------------------------------------------------------
declare -A BODY
while IFS=$'\t' read -r rpath rbody; do
  [ -n "$rpath" ] && BODY["$rpath"]="$rbody;"
done < <(awk '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*\/.*\{[[:space:]]*$/ { path = $1; body = ""; inb = 1; next }
  inb && /^[[:space:]]*\}/ { print path "\t" body; inb = 0; next }
  inb { gsub(/^[[:space:]]+/, ""); gsub(/[[:space:]]+$/, ""); if ($0 != "") body = body ";" $0 }
' "$CONF")

if [ "${#BODY[@]}" -eq 0 ]; then
  bad "no rotation rule found in ${CONF##*/}"
fi

# count_dir <body> <directive> -> N (directives whose first word is <directive>)
count_dir() {
  local d IFS=';'
  N=0
  for d in $1; do
    [ "${d%% *}" = "$2" ] && N=$((N + 1))
  done
}
# dir_val <body> <directive> -> VAL (second word of the first such directive)
dir_val() {
  local d IFS=';'
  VAL=""
  for d in $1; do
    if [ "${d%% *}" = "$2" ] && [ "$d" != "$2" ]; then
      VAL="${d#* }"
      return
    fi
  done
}

FORBIDDEN="weekly monthly yearly hourly size minsize maxsize dateext olddir"

# Generic checks for every rule.
for p in "${!BODY[@]}"; do
  body="${BODY[$p]}"
  count_dir "$body" daily
  [ "$N" -eq 1 ] || bad "$p: needs exactly one 'daily' (found $N)"
  for w in $FORBIDDEN; do
    count_dir "$body" "$w"
    if [ "$N" -gt 0 ]; then
      bad "$p: forbidden directive '$w' (the bound assumes one rotation per day, named by generation)"
    fi
  done
  dir_val "$body" rotate
  rot="$VAL"
  dir_val "$body" maxage
  age="$VAL"
  case "$rot" in '' | *[!0-9]*) bad "$p: rotate is missing or not an integer"; continue ;; esac
  case "$age" in '' | *[!0-9]*) bad "$p: maxage is missing or not an integer"; continue ;; esac
  [ "$rot" = "$age" ] || bad "$p: rotate ($rot) and maxage ($age) differ; maxage only masks a rotate change"
done

# ---------------------------------------------------------------------------
# 2. Interval clamp: the block between the markers, run with hostile values.
# ---------------------------------------------------------------------------
STATE_PATH=""
while IFS= read -r line; do
  # A comment quoting the command must not stand in for it.
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in "#"*) continue ;; esac
  case "$line" in
    *"logrotate -s /logs/processed/"*)
      rest="${line#*logrotate -s }"
      STATE_PATH="${rest%% *}"
      break
      ;;
  esac
done <"$ENTRY"
if [ -z "$STATE_PATH" ]; then
  bad "entrypoint.sh: logrotate does not run with '-s /logs/processed/<state file>' (a state file in the container filesystem is lost on every re-create)"
else
  case "${STATE_PATH##*/}" in
    retained-*) bad "entrypoint.sh: state file $STATE_PATH matches the retained-* glob prune-retained.sh deletes" ;;
  esac
fi

CLAMP=""
on=0
while IFS= read -r line; do
  if [ "$line" = "# BEGIN interval" ]; then
    on=1
    continue
  fi
  if [ "$line" = "# END interval" ]; then
    on=0
    continue
  fi
  [ "$on" -eq 1 ] && CLAMP="$CLAMP$line"$'\n'
done <"$ENTRY"

run_clamp() {
  # run_clamp <value|-unset-> -> GOT: the interval the block leaves behind
  if [ "$1" = "-unset-" ]; then
    GOT=$(env -u LOGROTATE_INTERVAL bash -c "$CLAMP"$'\n''printf "%s" "$LOGROTATE_INTERVAL"' 2>/dev/null)
  else
    GOT=$(LOGROTATE_INTERVAL="$1" bash -c "$CLAMP"$'\n''printf "%s" "$LOGROTATE_INTERVAL"' 2>/dev/null)
  fi
}
I=0
if [ -z "$CLAMP" ]; then
  bad "entrypoint.sh: no '# BEGIN interval' .. '# END interval' clamp block"
  I=$DAY
else
  for v in 86400 abc 0 -unset-; do
    run_clamp "$v"
    got="$GOT"
    case "$got" in '' | *[!0-9]*) bad "interval clamp: '$v' left a non-integer ('$got')"; got=$DAY ;; esac
    if [ "$v" != "-unset-" ] && [ "$got" -ne 3600 ]; then
      bad "interval clamp: LOGROTATE_INTERVAL='$v' leaves $got, expected 3600"
    fi
    [ "$got" -gt "$I" ] && I=$got
  done
  [ "$I" -le 3600 ] || bad "interval clamp: worst-case interval $I > 3600"
fi
L=$((DAY + I))

# ---------------------------------------------------------------------------
# 3. Files Traefik writes under /logs, as the vector container sees them.
# ---------------------------------------------------------------------------
declare -A TPATH
while IFS=$'\t' read -r sect fp; do
  [ -n "$sect" ] && TPATH["$sect"]="$fp"
done < <(awk '
  /^[A-Za-z]/ { sect = $1; sub(/:.*/, "", sect) }
  (sect == "accessLog" || sect == "log") && $1 == "filePath:" { v = $2; gsub(/"/, "", v); print sect "\t" v }
  sect == "log" && $1 == "maxSize:" { v = $2; gsub(/"/, "", v); print "logMaxSize\t" v }
' "$TRAEFIK_YML")

vec_path() {
  # /logs/<name> (Traefik's mount) -> /logs/traefik/<name> (the vector mount)
  VP=""
  case "$1" in
    /logs/*/*) ;;
    /logs/*) VP="/logs/traefik/${1#/logs/}" ;;
  esac
}
ACCESS_RULE=""
TRAEFIK_RULE=""
if [ -z "${TPATH[accessLog]:-}" ]; then
  bad "traefik.yml: no accessLog.filePath"
else
  vec_path "${TPATH[accessLog]}"
  ACCESS_RULE="$VP"
  [ -n "$ACCESS_RULE" ] || bad "traefik.yml: accessLog.filePath '${TPATH[accessLog]}' is not directly under /logs"
fi
if [ -z "${TPATH[log]:-}" ]; then
  bad "traefik.yml: no log.filePath (Traefik's own log would go to container stdout, which has no time limit)"
else
  vec_path "${TPATH[log]}"
  TRAEFIK_RULE="$VP"
  [ -n "$TRAEFIK_RULE" ] || bad "traefik.yml: log.filePath '${TPATH[log]}' is not directly under /logs"
  # With log.filePath set, Traefik writes through a size-rotating writer (lumberjack):
  # maxSize 0 means 100 MB, maxBackups 0 keeps every backup for ever, and its size
  # counter ignores logrotate's copytruncate. Cumulative output past the cap renames
  # the live file to traefik-<timestamp>.log, a name no rule above matches, so it
  # would never be deleted. A cap no volume can reach leaves logrotate as the only
  # rotator, which is what the per-family bound below assumes.
  case "${TPATH[logMaxSize]:-}" in
    '' | *[!0-9]*) bad "traefik.yml: log.maxSize is missing or not an integer (Traefik's own rotation, default 100 MB, would leave traefik-<timestamp>.log files no logrotate rule deletes)" ;;
    *)
      [ "${TPATH[logMaxSize]}" -ge "$TRAEFIK_MAXSIZE_MIN_MB" ] \
        || bad "traefik.yml: log.maxSize ${TPATH[logMaxSize]} MB is reachable; need >= $TRAEFIK_MAXSIZE_MIN_MB so Traefik never rotates by itself"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 4. Per-family worst case.
# ---------------------------------------------------------------------------
fmt "$B"
echo "Edge retention bound: B = $B s ($FMT); I = $I s, R = $R s, L = $L s"
printf '%-16s %-30s %9s  %s\n' family formula seconds duration

report() {
  # report <family> <formula> <seconds>
  local verdict="ok"
  if [ "$3" -gt "$B" ]; then
    verdict="EXCEEDS B"
    fail=1
  fi
  fmt "$3"
  printf '%-16s %-30s %9s  %s  %s\n' "$1" "$2" "$3" "$FMT" "$verdict"
}

live_family() {
  # live_family <label> <rule path> <with_lag 0|1>
  local label="$1" rpath="$2" lag="$3" body secs formula
  [ -n "$rpath" ] || return 0
  if [ -z "${BODY[$rpath]+x}" ]; then
    bad "logrotate.conf: no rule for $rpath (a file Traefik or process-logs.sh writes)"
    return 0
  fi
  body="${BODY[$rpath]}"
  count_dir "$body" notifempty
  if [ "$N" -gt 0 ]; then
    echo "$label unbounded (notifempty)"
    bad "$rpath: notifempty on a live log stops rotation on a zero-traffic day, so the file (and maxage, checked only on rotation) stretches without limit"
    return 0
  fi
  dir_val "$body" rotate
  case "$VAL" in '' | *[!0-9]*) return 0 ;; esac
  if [ "$lag" -eq 1 ]; then
    secs=$(((VAL + 1) * DAY + I + R + L))
    formula="($VAL+1) d + I + R + L"
  else
    secs=$(((VAL + 1) * DAY + I + R))
    formula="($VAL+1) d + I + R"
  fi
  report "$label" "$formula" "$secs"
}

live_family "access.log" "$ACCESS_RULE" 0
live_family "traefik.log" "$TRAEFIK_RULE" 0
live_family "security.log" "/logs/processed/security.log" 1

# Retained family: the prune script is the authority (by file name), logrotate's
# rule only compresses; take the worse of the two.
W=""
while IFS= read -r line; do
  case "$line" in
    *'RETAINED_RETENTION_DAYS:-'*)
      rest="${line#*RETAINED_RETENTION_DAYS:-}"
      W="${rest%%[!0-9]*}"
      break
      ;;
  esac
done <"$PRUNE"
RET_RULE="/logs/processed/retained-*.log"
if [ -z "$W" ]; then
  bad "prune-retained.sh: no RETAINED_RETENTION_DAYS default"
elif [ -z "${BODY[$RET_RULE]+x}" ]; then
  bad "logrotate.conf: no rule for $RET_RULE"
else
  dir_val "${BODY[$RET_RULE]}" rotate
  worst=$W
  case "$VAL" in '' | *[!0-9]*) ;; *) [ "$VAL" -gt "$worst" ] && worst=$VAL ;; esac
  report "retained-*.log" "($worst+1) d + I + R + L (W=$W)" $(((worst + 1) * DAY + I + R + L))
fi

if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
