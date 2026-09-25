#!/usr/bin/env bash
#
# lint-release.sh — the TASK-046 supply-chain suites, with their own test count
# asserted (the `make lint-extraction-source` idiom): a suite that collects
# nothing, or fewer tests than it declares, would still exit 0.
#
#   1. count the top-level `test(` declarations in scripts/release/*.test.mjs
#      and scripts/verify/sbom/*.test.mjs (must be > 0);
#   2. run `node --test` over both directories (live docker, pinned cosign);
#   3. require exit 0, zero failures, and collected == declared;
#   4. shellcheck every scripts/release/*.sh (shellcheck missing = FAIL).
#
# Intended target: `make lint-release` (the Makefile is TASK-045's; the
# one-line registration is a residual the orchestrator adds when merging).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

files=(scripts/release/*.test.mjs scripts/verify/sbom/*.test.mjs)
declared=0
for f in "${files[@]}"; do
    [[ -f "$f" ]] || continue
    c="$(grep -c '^test(' "$f" || true)"
    declared=$(( declared + c ))
done
if [[ "$declared" -eq 0 ]]; then
    echo "lint-release: no top-level test() declared — the suite collects nothing and would still exit 0." >&2
    exit 1
fi

status=0
out="$(node --test --test-reporter=tap scripts/release/ scripts/verify/sbom/ 2>&1)" || status=$?
printf '%s\n' "$out" | grep -E '^(not ok|# (tests|pass|fail|cancelled|skipped|todo))' >&2 || true
collected="$(printf '%s\n' "$out" | sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' | tail -1)"
failed="$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9][0-9]*\)$/\1/p' | tail -1)"
skipped="$(printf '%s\n' "$out" | sed -n 's/^# skipped \([0-9][0-9]*\)$/\1/p' | tail -1)"
if [[ "$status" -ne 0 || "${failed:-x}" != "0" ]]; then
    echo "lint-release: node --test failed (exit ${status}, fail ${failed:-?})." >&2
    exit 1
fi
if [[ "${skipped:-0}" != "0" ]]; then
    echo "lint-release: ${skipped} test(s) skipped — a supply-chain check that can skip is not a check." >&2
    exit 1
fi
if [[ "${collected:-}" != "$declared" ]]; then
    echo "lint-release: the suites declare ${declared} test(s) but node ran '${collected:-none}'." >&2
    echo "  Either tests stopped registering, or they no longer start at column 0." >&2
    exit 1
fi
echo "[release] suites: ${collected} of ${declared} declared test(s) ran, 0 failed"

command -v shellcheck >/dev/null 2>&1 || { echo "lint-release: shellcheck not on PATH" >&2; exit 1; }
shellcheck -x scripts/release/*.sh
echo "[release] shellcheck: OK"
