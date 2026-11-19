#!/usr/bin/env bash
# scripts/cd-proof/make-proof-commits.sh -- the proof commits of the CD proof run.
#
# Makes a LOCAL BARE REPOSITORY with three branches, each exactly one commit on top of the
# main commit you name, each one a patch from patches/:
#   proof-readiness-fail   /readyz answers 503 for ever (anonymous and internal); /healthz is 200
#   proof-window-fail      /readyz flips to 503 while /tmp/cd-proof-fail exists in the container
#   proof-5xx              one public page answers 500 while that file exists; /readyz is left alone
# Nothing is pushed anywhere and no network is used. The result is what CD_PROOF_REPO points
# at (see run-sheet.md).
#
# Usage:
#   make-proof-commits.sh <main sha> [--repo DIR] [--out DIR] [--patches DIR]
#     <main sha>     a commit of the repository (7 to 40 hex characters), the parent of all three
#     --repo DIR     the repository that holds that commit (default: the one this script is in)
#     --out DIR      the bare repository to create (default: ${TMPDIR:-/tmp}/cd-proof-<sha12>.git);
#                    it must not exist yet
#     --patches DIR  where the three <branch>.patch files are (default: patches/ beside this file)
#
# Guards, each a refusal (exit 2) before anything is made: a patch may touch only files under
# gremion-ui/, may not touch a migration (a .sql file, or a folder or file whose name starts
# with "migrat", whatever its extension) and may only create or modify files (no rename, copy,
# delete or mode change). --out may be a drive-letter path (C:/dir) on a Windows workstation.
#
# The commits are built with plumbing (a temporary index, no checkout) with a fixed author,
# committer and date, so the same inputs give the same commit ids and no workstation identity
# lands in them. The repository you point at is only read: the new objects are written into
# the output repository, which borrows the old ones until the end and then keeps its own copy.
#
# Exit codes: 0 done; 1 a post-condition failed (the half-made output is removed);
# 2 usage or a refused precondition.

set -euo pipefail

PROOF_BRANCHES=(proof-readiness-fail proof-window-fail proof-5xx)
PROOF_AUTHOR_NAME='cd-proof'
PROOF_AUTHOR_EMAIL='cd-proof@example.invalid'
PROOF_DATE='1767225600 +0000'

die() { printf 'make-proof-commits: %s\n' "$2" >&2; exit "$1"; }

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2; }

# A caller's own git environment must not redirect any call below.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sha_arg=''
repo=''
out=''
patches="${here}/patches"

while (($#)); do
    case "$1" in
        -h | --help) usage; exit 0 ;;
        --repo) [[ $# -ge 2 ]] || die 2 "--repo needs a directory"; repo="$2"; shift 2 ;;
        --out) [[ $# -ge 2 ]] || die 2 "--out needs a directory"; out="$2"; shift 2 ;;
        --patches) [[ $# -ge 2 ]] || die 2 "--patches needs a directory"; patches="$2"; shift 2 ;;
        -*) usage; die 2 "unknown option: $1" ;;
        *)
            [[ -z "$sha_arg" ]] || die 2 "one main sha only"
            sha_arg="$1"
            shift
            ;;
    esac
done

[[ -n "$sha_arg" ]] || { usage; die 2 "the main sha is required"; }
[[ "$sha_arg" =~ ^[0-9a-f]{7,40}$ ]] || die 2 "the main sha must be 7 to 40 lower-case hex characters"
if [[ -z "$repo" ]]; then
    repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)" || die 2 "this script is not inside a repository: pass --repo"
fi
[[ -d "$repo" ]] || die 2 "--repo is not a directory"
repo="$(cd "$repo" && pwd)"
base="$(git -C "$repo" rev-parse --verify --quiet "${sha_arg}^{commit}" 2>/dev/null)" || die 2 "the repository has no commit ${sha_arg}"
[[ -d "$patches" ]] || die 2 "--patches is not a directory"
patches="$(cd "$patches" && pwd)"
if [[ -z "$out" ]]; then
    out="${TMPDIR:-/tmp}/cd-proof-${base:0:12}.git"
fi
[[ ! -e "$out" ]] || die 2 "the output path exists already (remove it or pass another --out)"
# A drive-letter path (C:/dir, as Git Bash on a Windows workstation takes it) is absolute too:
# putting the working folder in front of it would make a path git cannot use.
case "$out" in
    /* | [A-Za-z]:/* | [A-Za-z]:\\*) ;;
    *) out="${PWD}/${out}" ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/cd-proof-work.XXXXXX")"
made=0
ok=0
cleanup() {
    rm -rf "$work"
    if [[ "$made" -eq 1 && "$ok" -ne 1 ]]; then
        rm -rf "$out"
    fi
}
trap cleanup EXIT

# check_patch FILE NAME -- the guards of the plan, read from what `git apply` itself would do.
# `git apply` runs in the empty work folder, outside every repository, so the answer does
# not depend on which repository the caller stands in (or whose it is).
check_patch() {
    local f="$1" name="$2" line path n=0 summary
    [[ -f "$f" ]] || die 2 "the patch ${name}.patch is missing"
    summary="$(git -C "$work" apply --summary "$f" 2>&1)" || die 2 "${name}.patch is not a patch git can read"
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        case "$line" in
            " create mode "*) ;;
            *) die 2 "${name}.patch does more than create or modify a file: ${line}" ;;
        esac
    done <<<"$summary"
    while IFS=$'\t' read -r _ _ path; do
        [[ -n "$path" ]] || continue
        n=$((n + 1))
        case "$path" in
            gremion-ui/*) ;;
            *) die 2 "${name}.patch touches a file outside gremion-ui/: ${path}" ;;
        esac
        case "/${path}/" in
            */../* | */./*) die 2 "${name}.patch names a path with a dot segment: ${path}" ;;
        esac
        # a .sql file, or any path part (folder or file name) that starts with "migrat"
        # (migrations/, migration/, migrate/, migrations-control/, migration-list.json, ...)
        if [[ "$path" == *.sql || "/${path}" == */migrat* ]]; then
            die 2 "${name}.patch touches a migration: ${path}"
        fi
    done < <(git -C "$work" apply --numstat "$f")
    [[ "$n" -ge 1 ]] || die 2 "${name}.patch changes no file"
}

for b in "${PROOF_BRANCHES[@]}"; do
    check_patch "${patches}/${b}.patch" "$b"
done

objects="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/objects"
[[ -d "$objects" ]] || die 2 "the repository has no object directory"

git init --bare -q "$out"
made=1
printf '%s\n' "$objects" >"${out}/objects/info/alternates"

declare -A tip=()
for b in "${PROOF_BRANCHES[@]}"; do
    idx="${work}/index.${b}"
    GIT_INDEX_FILE="$idx" git -C "$out" read-tree "$base"
    GIT_INDEX_FILE="$idx" git -C "$out" apply --cached "${patches}/${b}.patch" \
        || die 2 "${b}.patch does not apply to ${base:0:12}; the patch must be remade for this commit"
    tree="$(GIT_INDEX_FILE="$idx" git -C "$out" write-tree)"
    tip[$b]="$(
        GIT_AUTHOR_NAME="$PROOF_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$PROOF_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$PROOF_DATE" \
            GIT_COMMITTER_NAME="$PROOF_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$PROOF_AUTHOR_EMAIL" GIT_COMMITTER_DATE="$PROOF_DATE" \
            git -c commit.gpgsign=false -C "$out" commit-tree "$tree" -p "$base" \
            -m "${b}: CD proof commit, never merge" </dev/null
    )"
    git -C "$out" update-ref "refs/heads/${b}" "${tip[$b]}"
done

# The output keeps its own copy of the history from here on (nothing may depend on the
# source repository staying where it is).
git -C "$out" repack -a -d -q
rm -f "${out}/objects/info/alternates"
git -C "$out" fsck --connectivity-only --no-dangling >/dev/null 2>&1 \
    || { printf 'make-proof-commits: the output repository is not self-contained\n' >&2; exit 1; }

# Post-conditions, read from the bare repository itself.
heads="$(git -C "$out" for-each-ref --format='%(refname:short)' refs/heads | sort | tr '\n' ' ')"
want="$(printf '%s\n' "${PROOF_BRANCHES[@]}" | sort | tr '\n' ' ')"
[[ "$heads" == "$want" ]] || { printf 'make-proof-commits: the branches are not the three expected ones\n' >&2; exit 1; }
for b in "${PROOF_BRANCHES[@]}"; do
    n="$(git -C "$out" rev-list --count "${base}..refs/heads/${b}")"
    parent="$(git -C "$out" rev-parse "refs/heads/${b}^")"
    [[ "$n" == 1 && "$parent" == "$base" ]] || { printf 'make-proof-commits: %s is not one commit on the main commit\n' "$b" >&2; exit 1; }
    while IFS= read -r path; do
        case "$path" in
            gremion-ui/*) ;;
            *) printf 'make-proof-commits: %s changes a file outside gremion-ui/\n' "$b" >&2; exit 1 ;;
        esac
    done < <(git -C "$out" diff-tree --no-commit-id --name-only -r "$base" "refs/heads/${b}")
done

ok=1
for b in "${PROOF_BRANCHES[@]}"; do
    printf '%s %s\n' "$b" "${tip[$b]}"
done
printf 'CD_PROOF_REPO=%s\n' "$out"
