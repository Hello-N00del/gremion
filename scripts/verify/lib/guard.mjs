// TASK-045 (TRD-444): the fail-closed vacuity guard.
//
// A suite's own tool exit code is never trusted alone -- vitest exits 0 on a
// fully-skipped file (packages/ports/scripts/nats-test.sh's header names the
// same defect), `node --test` exits 0 on a file with no test() at all
// (Makefile lint-extraction-source's comment proves it -- the file itself
// becomes a synthetic passing test), and the release-1 gate's svelte-check
// step passed whenever its error count was unparseable (gate-ceba66c.json:
// `errors=?` treated as green). This function is the ONE place a suite's raw
// {collected, passed, failed, skipped} numbers become verify's pass/fail, so
// every suite -- five different tools -- is judged by the same rules.
//
// Guard-efficacy proof (brief S7): each `if` below is independently
// load-bearing. Commenting one out in a scratch copy and re-running the
// suite's own seeded fixture must turn a FAIL back into a silent PASS -- that
// is what "watched the guard fail" means for this file. See the commit
// message for the dated RED/GREEN transcript of that proof.

/**
 * @param {object} input
 * @param {string|null} [input.toolMissing] name of a required binary that was
 *   not found on PATH (docker, bats, shellcheck, psql, ...). Takes priority
 *   over every other signal: a suite that never ran cannot have "passed".
 * @param {boolean} [input.unparseable] the suite's own report could not be
 *   parsed into counts at all (a missing COMPLETED line, a truncated JSON
 *   file, no TAP plan). Unparseable is a FAIL, never a fallback pass.
 * @param {number} input.collected total tests/checks the tool says it ran
 *   (vitest numTotalTests, a TAP plan, svelte-check FILES, bats' `1..N`).
 * @param {number} [input.passed] tests reported as passed.
 * @param {number} [input.failed] tests reported as failed/errored.
 * @param {number} [input.skipped] tests reported as skipped/pending/todo.
 * @param {number} [input.allowedSkips] the max skip count this suite may
 *   carry per scripts/verify/allowed-skips.json (Q3), summed across every
 *   entry for the suite. Defaults to 0: any skip fails unless explicitly
 *   allow-listed. Superseded, when `skipFileViolations` is non-empty, by the
 *   more precise per-file check below -- kept as a fallback for a suite that
 *   cannot yet attribute a skip to one file.
 * @param {string[]} [input.skipFileViolations] pre-computed per-file
 *   allow-list violations (lib/skips.mjs#checkSkipsByFile) -- a skip
 *   attributed to a file with no entry, or beyond that file's own maxCount.
 *   Non-empty fails the suite regardless of what the suite-wide
 *   `allowedSkips` total would otherwise permit (Q3's actual rule: the
 *   allow-list's `file` field is a per-file budget, not a suite-wide one).
 * @returns {{status: 'pass'|'fail', reason: string|null}}
 */
export function evaluateSuite({
  toolMissing = null,
  unparseable = false,
  collected = 0,
  passed = 0,
  failed = 0,
  skipped = 0,
  allowedSkips = 0,
  skipFileViolations = [],
} = {}) {
  // 1. Missing tool. Checked first: a suite that could not even start has no
  // counts worth trusting, and "missing tool" must never be mistaken for a
  // skip (Q3's allow-list is for a knowingly-absent stack, not an unmet
  // prerequisite).
  if (toolMissing) {
    return { status: 'fail', reason: `missing tool: ${toolMissing}` }
  }

  // 2. Unparseable output. A report this function cannot read is exactly the
  // release-1 gate's `errors=?` defect -- treat it as a FAIL, never as "no
  // news is good news".
  if (unparseable) {
    return { status: 'fail', reason: 'unparseable output -- cannot confirm the suite ran' }
  }

  // 3. Zero collected. The single most-repeated shape in this repo's own
  // guard comments (lint-extraction-source, lint-toolchain, nats-test.sh):
  // an exit code of 0 proves nothing about what ran.
  if (!Number.isFinite(collected) || collected <= 0) {
    return { status: 'fail', reason: 'collected 0 tests' }
  }

  // 4. Any reported failure fails the suite outright, regardless of the
  // skip/allow-list bookkeeping below.
  if (failed > 0) {
    return { status: 'fail', reason: `${failed} of ${collected} failed` }
  }

  // 5. Every collected test skipped is indistinguishable from "did not run".
  if (skipped >= collected) {
    return { status: 'fail', reason: `all ${collected} collected test(s) were skipped` }
  }

  // 6. A skip attributed to a file with no allow-list entry, or beyond that
  // file's own maxCount, fails -- checked file by file, never as one
  // suite-wide sum (see checkSkipsByFile's own doc comment for the exact
  // defect this closes).
  if (skipFileViolations.length > 0) {
    return { status: 'fail', reason: `unaccounted skip(s): ${skipFileViolations.join('; ')}` }
  }

  // 7. Fallback for a suite that cannot yet attribute a skip to one file: a
  // skip beyond the declared allowance (Q3) fails -- an un-allow-listed skip
  // is exactly as unaccounted for as one nobody looked at.
  if (skipped > allowedSkips) {
    return {
      status: 'fail',
      reason: `${skipped} test(s) skipped, exceeds the allowed ${allowedSkips} (see scripts/verify/allowed-skips.json)`,
    }
  }

  return { status: 'pass', reason: null }
}
