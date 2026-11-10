#!/bin/sh
# image-step.sh <src> <out> <deps> - makes the code map inside the control-panel image build.
#
#   <src>   the whole repository, copied into the builder stage (no git program, maybe a .git/HEAD)
#   <out>   the folder that the runner stage copies; it gets code-map.html and status.json, nothing else
#   <deps>  a folder with a node_modules that holds typescript (apps/control-panel)
#
# THE RULE: this script never exits non-zero, and it always leaves a valid <out>/status.json. A code map
# problem (a stale text, a crash, no memory, a timeout, a missing commit) must never stop the image build.
# On any failure the status file says ok:false with a FIXED reason (no stack, no path, no matched text),
# and graph.json and any partial page are removed. The page of the control panel then shows the reason.
#
# POSIX sh for busybox ash: no `set -e`, no arrays, no [[ ]].
# CODEMAP_TIMEOUT_SECONDS lowers the 300 s limit; the test uses it, the Dockerfile does not.

SRC=$1
OUT=$2
DEPS=$3
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
LINE=

# first line of a file, without a carriage return, in $LINE; fails when the file cannot be read
read_first_line() {
  LINE=
  [ -f "$1" ] && [ -r "$1" ] || return 1
  { IFS= read -r LINE; } < "$1" 2>/dev/null || true
  LINE=$(printf '%s' "$LINE" | tr -d '\r')
}

# 40 lower-case hex characters, nothing else
is_sha() {
  case $1 in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

# prints the commit of the checkout in $1, or unknown. Reads .git/HEAD, a loose ref or packed-refs.
read_commit() {
  gitdir=$1/.git
  read_first_line "$gitdir/HEAD" || { echo unknown; return 0; }
  case $LINE in
    "ref: "*) ref=${LINE#ref: } ;;
    *)
      if is_sha "$LINE"; then echo "$LINE"; else echo unknown; fi
      return 0
      ;;
  esac
  case $ref in
    refs/*) ;;
    *) echo unknown; return 0 ;;
  esac
  case $ref in
    *[!A-Za-z0-9._/-]* | *..* | *//*) echo unknown; return 0 ;;
  esac
  if read_first_line "$gitdir/$ref" && is_sha "$LINE"; then
    echo "$LINE"
    return 0
  fi
  if [ -f "$gitdir/packed-refs" ] && [ -r "$gitdir/packed-refs" ]; then
    while IFS=' ' read -r sha name; do
      if [ "$name" = "$ref" ] && is_sha "$sha"; then
        echo "$sha"
        return 0
      fi
    done < "$gitdir/packed-refs"
  fi
  echo unknown
}

# status.json for a failure. $1 is the validated commit, $2 a fixed reason with no quote and no backslash.
write_failure() {
  printf '{"ok":false,"commit":"%s","generatedFor":"unavailable","counts":{"functions":0,"connections":0},"staleSteps":[],"staleAreas":[],"undescribedAreas":[],"reason":"%s"}\n' "$1" "$2" > "$OUT/status.json" 2>/dev/null
  rm -f "$OUT/graph.json" "$OUT/code-map.html"
}

main() {
  [ -n "$OUT" ] || return 0
  mkdir -p "$OUT" 2>/dev/null
  COMMIT=$(read_commit "$SRC")
  is_sha "$COMMIT" || COMMIT=unknown
  echo "code map: commit $COMMIT"
  rm -f "$OUT/status.json" "$OUT/graph.json" "$OUT/code-map.html"

  LIMIT=300
  case ${CODEMAP_TIMEOUT_SECONDS:-} in
    '' | *[!0-9]*) ;;
    *) LIMIT=$CODEMAP_TIMEOUT_SECONDS ;;
  esac
  START=$(date +%s 2>/dev/null || echo 0)
  timeout -s KILL "$LIMIT" node --max-old-space-size=3072 "$HERE/extract.mjs" --tree --kernel "$SRC" --commit "$COMMIT" --deps "$DEPS" --out "$OUT/graph.json"
  rc=$?
  END=$(date +%s 2>/dev/null || echo 0)
  if [ "$rc" -ne 0 ]; then
    case $rc in
      124 | 137 | 143)
        if [ $((END - START)) -ge $((LIMIT - 1)) ]; then
          write_failure "$COMMIT" "extract timed out"
          echo "code map: extract timed out"
          return 0
        fi
        ;;
    esac
    write_failure "$COMMIT" "extract failed (exit $rc)"
    echo "code map: extract failed (exit $rc)"
    return 0
  fi

  node "$HERE/build.mjs" --graph "$OUT/graph.json" --commit "$COMMIT" --out-dir "$OUT"
  rc=$?
  rm -f "$OUT/graph.json"
  if [ "$rc" -ne 0 ]; then
    write_failure "$COMMIT" "build failed (exit $rc)"
    echo "code map: build failed (exit $rc)"
    return 0
  fi
  if [ ! -s "$OUT/status.json" ]; then
    write_failure "$COMMIT" "build failed (no status)"
    echo "code map: build failed (no status)"
  fi
  return 0
}

main
exit 0
