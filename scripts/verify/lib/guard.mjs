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
 * @param {number} [input.collected] total tests/checks the tool says it ran (0 when absent)
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
 * @param {string[]} [input.emptyParts] labels of sub-checks that ran but
 *   collected 0 tests (combineParts fills this in). Non-empty fails the suite
 *   whatever the summed `collected` is.
 * @returns {{status: 'pass'|'fail', reason: string|null}}
 */
export function evaluateSuite({
  toolMissing = null,
  unparseable = false,
  collected = 0,
  passed: _passed = 0,
  failed = 0,
  skipped = 0,
  allowedSkips = 0,
  skipFileViolations = [],
  emptyParts = [],
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

  // 3a. A sub-check that collected nothing fails the suite by NAME, however
  // large the other sub-checks' total is. Summing sub-check counts and
  // judging only the sum let one empty part hide behind another's tests
  // (round 1: migrations 31 + migrations-control 0 = 31, PASS). See
  // combineParts below, which is what fills this in.
  if (emptyParts.length > 0) {
    return { status: 'fail', reason: `collected 0 tests in: ${emptyParts.join(', ')}` }
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

const UNATTRIBUTED_SKIP = '(skip not attributable to a file)'

/**
 * Combines a suite's sub-checks (one per tool run) into the single raw
 * result evaluateSuite judges, WITHOUT letting any one sub-check's vacuity
 * disappear into the sum:
 *   - a part that ran (no missing tool, parseable) but collected 0 is listed
 *     in `emptyParts`, which evaluateSuite fails by name;
 *   - a part with a missing tool or unparseable output makes the whole suite
 *     so (the first missing tool is the one named);
 *   - a part whose counts are not finite numbers is unparseable, never 0;
 *   - no parts at all is unparseable, never an empty pass;
 *   - per-file skips (`skipsByFile`, repo-relative posix paths) are merged,
 *     and any skip a part cannot attribute to a file is booked under
 *     "<label>: (skip not attributable to a file)", a key no allow-list entry
 *     matches, so it is judged with a zero budget (Q3), never uncounted.
 *
 * @param {Array<{label: string, toolMissing?: string|null, unparseable?: boolean,
 *   collected?: number, passed?: number, failed?: number, skipped?: number,
 *   detail?: string, skipsByFile?: Record<string, number>}>} parts
 */
export function combineParts(parts) {
  const out = {
    toolMissing: null,
    unparseable: false,
    collected: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    emptyParts: [],
    skipsByFile: {},
    detail: '',
  }
  const details = []
  if (parts.length === 0) {
    out.unparseable = true
    details.push('no sub-checks ran')
  }
  for (const p of parts) {
    if (p.detail) details.push(`${p.label}: ${p.detail}`)
    if (p.toolMissing) {
      out.toolMissing ??= p.toolMissing
      continue
    }
    if (p.unparseable) {
      out.unparseable = true
      continue
    }
    const counts = ['collected', 'passed', 'failed', 'skipped'].map((k) => p[k] ?? 0)
    if (!counts.every((n) => Number.isFinite(n) && n >= 0)) {
      out.unparseable = true
      details.push(`${p.label}: non-numeric counts ${JSON.stringify(counts)}`)
      continue
    }
    const [collected, passed, failed, skipped] = counts
    out.collected += collected
    out.passed += passed
    out.failed += failed
    out.skipped += skipped
    if (collected <= 0) out.emptyParts.push(p.label)
    let attributed = 0
    for (const [file, n] of Object.entries(p.skipsByFile ?? {})) {
      if (!(n > 0)) continue
      out.skipsByFile[file] = (out.skipsByFile[file] ?? 0) + n
      attributed += n
    }
    if (skipped > attributed) {
      const key = `${p.label}: ${UNATTRIBUTED_SKIP}`
      out.skipsByFile[key] = (out.skipsByFile[key] ?? 0) + (skipped - attributed)
    }
  }
  out.detail = details.join('\n')
  return out
}
