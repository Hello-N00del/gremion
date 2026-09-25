#!/usr/bin/env bash
# helios-submodule-check.sh -- run at EVERY bump of the Helios submodule
# (TASK-005, TRD-268; scope record: docs/compliance/elections-scope.md).
#
# Reads two files from the commit the superproject PINS for the Helios
# submodule -- not from the submodule's working tree, which can sit on any
# commit -- and fails the bump unless:
#   * `.python-version` names Python 3.13 or a later 3.x (first entry, the one
#     pyenv and uv select), and
#   * `LICENSE` (or LICENSE.txt / LICENSE.md) is the Apache License 2.0 text:
#     its header, its terms section byte-identical (whitespace-normalised) to
#     the stock text, nothing after it but the "How to apply" appendix, and no
#     other licence-shaped file (COPYING*, LICENSE-*) at the root.
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
# SHA-256 of the Apache License 2.0 terms section (TERMS AND CONDITIONS FOR
# USE ... END OF TERMS AND CONDITIONS) with every whitespace run collapsed to
# one space. Identical for the stock text and Helios' older-template copy
# (docs/compliance/licence-register.md, section 2).
APACHE_TERMS_SHA256=b316b715c7f48af32f6265b3de80b9656fdbddc57f5854215c8a4c6e0ad42c05
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
  entry="$(git -C "$repo" ls-files -s -- "$path")" || die "cannot read the index of $repo"
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
  # Major pinned to 3 and components bounded, so the integer test below can
  # never error: a `[ ... -lt ... ]` error inside an `if` is just "false",
  # which is how "3.99999999999999999999" used to fall through to PASS.
  if [[ "$python" =~ ^(cpython-)?3\.(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,3}))?$ ]]; then
    minor="${BASH_REMATCH[2]}"
    if [ "$minor" -lt "$MIN_MINOR" ]; then
      report_fail "python .python-version reports $python, below 3.$MIN_MINOR (or not a confirmed-compatible 3.x)"
    fi
  else
    report_fail "python .python-version entry '${python}' is unrecognised; expected 3.<minor>[.<patch>] without leading zeros"
  fi
else
  report_fail "python .python-version is missing at the pinned commit"
fi

# -- 4. LICENSE -------------------------------------------------------------------
# Every licence-shaped file at the root is looked at, not only the first: an
# Apache LICENSE next to a COPYING or LICENSE-COMMERCIAL is not "Apache-2.0".
root_names="$(git -C "$sub" ls-tree --name-only "$sha")" || die "cannot list the root of $sha in $path"
licence_file=""
licence_text=""
for candidate in LICENSE LICENSE.txt LICENSE.md; do
  if licence_text="$(git -C "$sub" show "${sha}:${candidate}" 2>/dev/null)"; then
    licence_file="$candidate"
    break
  fi
done
shopt -s nocasematch
while IFS= read -r name; do
  [ -n "$name" ] && [ "$name" != "$licence_file" ] || continue
  if [[ "$name" =~ ^(LICEN[CS]E|COPYING|UNLICENSE) ]]; then
    report_fail "licence the pinned commit also carries licence file $name next to ${licence_file:-no LICENSE}; review it and this check"
  fi
done <<<"$root_names"
shopt -u nocasematch

if [ -z "$licence_file" ]; then
  report_fail "licence LICENSE file is missing at the pinned commit"
else
  # Whitespace collapsed (the Apache text is re-wrapped freely), then three
  # parts are checked against the stock text:
  #   header  "Apache License Version 2.0, January 2004 <url>" and nothing else,
  #   terms   TERMS AND CONDITIONS ... END OF TERMS AND CONDITIONS, by SHA-256
  #           (identical in every stock copy, including Helios' older template),
  #   tail    empty, or the "How to apply" appendix and nothing after it.
  flat="${licence_text//[$WS]/ }"
  while [[ "$flat" == *"  "* ]]; do flat="${flat//  / }"; done
  flat="${flat# }"
  flat="${flat% }"
  terms_start="TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"
  terms_end="END OF TERMS AND CONDITIONS"
  header="${flat%%"$terms_start"*}"
  if [[ "$flat" != *"$terms_start"*"$terms_end"* ]]; then
    report_fail "licence $licence_file is not Apache-2.0 (Apache License 2.0 terms section not found)"
  elif [[ ! "$header" =~ ^Apache\ License\ Version\ 2\.0,\ January\ 2004\ (https?://www\.apache\.org/licenses/?\ )?$ ]]; then
    report_fail "licence $licence_file does not begin with the Apache License 2.0 header (text before the terms: '${header:0:80}')"
  else
    after_start="${flat#"$header"}"
    terms="${after_start%%"$terms_end"*}$terms_end"
    tail="${after_start#"$terms"}"
    tail="${tail# }"
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(printf '%s' "$terms" | sha256sum)" || die "sha256sum failed"
    elif command -v shasum >/dev/null 2>&1; then
      digest="$(printf '%s' "$terms" | shasum -a 256)" || die "shasum failed"
    else
      die "neither sha256sum nor shasum is available to compare the licence terms"
    fi
    digest="${digest%% *}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "could not hash the licence terms (got '$digest')"
    if [ "$digest" != "$APACHE_TERMS_SHA256" ]; then
      report_fail "licence $licence_file terms differ from the Apache License 2.0 text (normalised terms sha256 $digest)"
    fi
    shopt -s nocasematch
    for other in 'GNU AFFERO GENERAL PUBLIC LICENSE' 'GNU GENERAL PUBLIC LICENSE' \
                 'GNU LESSER GENERAL PUBLIC LICENSE' 'Mozilla Public License' \
                 'Commons Clause' 'Business Source License' \
                 'Server Side Public License' 'Elastic License' 'MIT License'; do
      if [[ "$tail" == *"$other"* ]]; then
        report_fail "licence $licence_file is not plain Apache-2.0: it also contains '$other'"
      fi
    done
    shopt -u nocasematch
    if [ -n "$tail" ] \
      && ! [[ "$tail" == "APPENDIX: How to apply the Apache License to your work."*"limitations under the License." ]]; then
      report_fail "licence $licence_file text after the terms is not the Apache appendix"
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "$PROG: the Helios bump to $sha is BLOCKED (TRD-268)." >&2
  exit 1
fi
echo "$PROG: PASS commit=$sha python=$python licence=Apache-2.0 file=$licence_file source=$source_desc"
