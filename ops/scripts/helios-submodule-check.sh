#!/usr/bin/env bash
# helios-submodule-check.sh -- run at EVERY bump of the Helios submodule
# (TASK-005, TRD-268; scope record: docs/compliance/elections-scope.md).
#
# Reads two files from the commit the superproject PINS for the Helios
# submodule -- not from the submodule's working tree, which can sit on any
# commit -- and fails the bump unless:
#   * `.python-version` names Python 3.13 or a later 3.x (first entry, the one
#     pyenv and uv select), and
#   * `LICENSE` (or LICENSE.txt / LICENSE.md) is the Apache License 2.0 text
#     with no other licence's terms added to it.
#
# On success it prints ONE record line, meant to be pasted into the bump's
# commit message or PR description ("recorded at each bump", TRD-268):
#   helios-submodule-check: PASS commit=<sha> python=<v> licence=Apache-2.0 file=<name> source=<index|rev>
#
# Usage:
#   ops/scripts/helios-submodule-check.sh [--repo DIR] [--path PATH] [--rev REV]
#     --repo DIR   superproject that carries the gitlink (default: the git
#                  top level of the current directory)
#     --path PATH  submodule path inside the superproject (default: helios-src)
#     --rev REV    read the gitlink from this superproject revision. Default:
#                  the INDEX, so a staged-but-uncommitted bump is what gets
#                  checked (use it from a pre-commit hook or right after
#                  `git add <path>`); in CI pass --rev HEAD.
#
# Exit status: 0 pass; 1 the pinned commit fails a check; 2 the check could
# not run (usage error, no gitlink, submodule not initialised, pinned commit
# not fetched). Both 1 and 2 must block the bump -- "could not check" is not
# "checked".
#
# Bash builtins are used for all text handling on purpose: on a loaded
# Windows/MSYS box every fork costs seconds, and a slow guard stops being run.
set -euo pipefail

PROG="helios-submodule-check"
MIN_MINOR=13
CR=$'\r'
WS=$'\r\n\t'

usage() {
  echo "usage: $0 [--repo DIR] [--path PATH] [--rev REV]" >&2
}

die() { # exit 2: the check could not run
  echo "$PROG: ERROR $*" >&2
  exit 2
}

repo=""
path="helios-src"
rev=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || { usage; exit 2; }; repo="$2"; shift 2 ;;
    --path) [ "$#" -ge 2 ] || { usage; exit 2; }; path="$2"; shift 2 ;;
    --rev)  [ "$#" -ge 2 ] || { usage; exit 2; }; rev="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "$PROG: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$repo" ]; then
  repo="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository; pass --repo"
fi
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repository"

# -- 1. The pinned commit -----------------------------------------------------
# Index:    "<mode> <sha> <stage>\t<path>"      (git ls-files -s)
# Revision: "<mode> <type> <sha>\t<path>"       (git ls-tree)
if [ -z "$rev" ]; then
  entry="$(git -C "$repo" ls-files -s -- "$path")"
  source_desc="index"
  mode="${entry%% *}"
  rest="${entry#* }"
  sha="${rest%% *}"
else
  entry="$(git -C "$repo" ls-tree "$rev" -- "$path")" || die "cannot read revision $rev"
  source_desc="$rev"
  mode="${entry%% *}"
  rest="${entry#* }"
  rest="${rest#* }"
  sha="${rest%%$'\t'*}"
fi
[ -n "$entry" ] || die "$path is not tracked in $source_desc of $repo -- not a submodule gitlink"
# More than one line means a directory or a conflicted index entry.
case "$entry" in
  *$'\n'*) die "$path in $source_desc resolves to more than one entry -- not a submodule gitlink" ;;
esac
[ "$mode" = "160000" ] || die "$path in $source_desc has mode $mode -- not a submodule gitlink"
case "$sha" in
  *[!0-9a-f]*|"") die "could not parse the gitlink for $path: $entry" ;;
esac

# -- 2. The submodule's object store -------------------------------------------
# Without the .git marker, `git -C <sub>` would silently walk UP into the
# superproject and look for the Helios commit there.
sub="$repo/$path"
[ -e "$sub/.git" ] || die "submodule $path is not initialised (run: git submodule update --init -- $path)"
git -C "$sub" cat-file -e "${sha}^{commit}" 2>/dev/null \
  || die "pinned commit $sha is not present in $path (run: git -C $path fetch)"

fail=0
report_fail() {
  echo "$PROG: FAIL commit=$sha $*" >&2
  fail=1
}

# -- 3. .python-version ---------------------------------------------------------
python="?"
if pyfile="$(git -C "$sub" show "${sha}:.python-version" 2>/dev/null)"; then
  # First entry that is not blank or a comment; CR stripped for CRLF files.
  python=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line//$CR/}"
    if [[ "$line" =~ ^[[:space:]]*([^[:space:]]+) ]]; then
      python="${BASH_REMATCH[1]}"
      break
    fi
  done <<<"$pyfile"
  if [[ "$python" =~ ^(cpython-)?([0-9]+)\.([0-9]+)(\.[0-9]+)?$ ]]; then
    major="${BASH_REMATCH[2]}"
    minor="${BASH_REMATCH[3]}"
    if [ "$major" -ne 3 ] || [ "$minor" -lt "$MIN_MINOR" ]; then
      report_fail "python .python-version reports $python, below 3.$MIN_MINOR (or not a confirmed-compatible 3.x)"
    fi
  else
    report_fail "python .python-version entry '${python}' is unrecognised; expected 3.<minor>[.<patch>]"
  fi
else
  report_fail "python .python-version is missing at the pinned commit"
fi

# -- 4. LICENSE -------------------------------------------------------------------
licence_file=""
licence_text=""
for candidate in LICENSE LICENSE.txt LICENSE.md; do
  if licence_text="$(git -C "$sub" show "${sha}:${candidate}" 2>/dev/null)"; then
    licence_file="$candidate"
    break
  fi
done
if [ -z "$licence_file" ]; then
  report_fail "licence LICENSE file is missing at the pinned commit"
else
  # Whitespace collapsed so a re-wrapped header still matches; compared
  # case-insensitively.
  flat="${licence_text//[$WS]/ }"
  while [[ "$flat" == *"  "* ]]; do flat="${flat//  / }"; done
  shopt -s nocasematch
  if [[ "$flat" != *"Apache License"* ]] \
    || [[ "$flat" != *"Version 2.0, January 2004"* ]] \
    || [[ "$flat" != *"TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"* ]]; then
    report_fail "licence $licence_file is not Apache-2.0 (Apache License 2.0 header and terms not found)"
  else
    for other in 'GNU AFFERO GENERAL PUBLIC LICENSE' 'GNU GENERAL PUBLIC LICENSE' \
                 'GNU LESSER GENERAL PUBLIC LICENSE' 'Mozilla Public License' \
                 'Commons Clause' 'Business Source License' \
                 'Server Side Public License' 'Elastic License'; do
      if [[ "$flat" == *"$other"* ]]; then
        report_fail "licence $licence_file is not plain Apache-2.0: it also contains '$other'"
      fi
    done
  fi
  shopt -u nocasematch
fi

if [ "$fail" -ne 0 ]; then
  echo "$PROG: the Helios bump to $sha is BLOCKED (TRD-268)." >&2
  exit 1
fi
echo "$PROG: PASS commit=$sha python=$python licence=Apache-2.0 file=$licence_file source=$source_desc"
