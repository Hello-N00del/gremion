// TASK-045 Q3 (recommended default, applied): a skip inside an otherwise
// passing suite fails the suite UNLESS it is named here, with a reason and a
// max count. Anything else -- an un-listed skip, or a listed one that exceeds
// its max -- fails per lib/guard.mjs. An all-skipped suite always fails,
// allow-list or not (see evaluateSuite's rule 5).
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const ALLOWED_SKIPS_PATH = path.join(import.meta.dirname, '..', 'allowed-skips.json')

/**
 * @returns {{entries: Array<{suite: string, file: string, reason: string, maxCount: number}>}}
 */
export function loadAllowedSkips() {
  const text = readFileSync(ALLOWED_SKIPS_PATH, 'utf8')
  const data = JSON.parse(text)
  if (!Array.isArray(data.entries)) {
    throw new Error(`${ALLOWED_SKIPS_PATH}: expected {entries: [...]}`)
  }
  for (const e of data.entries) {
    if (!e.suite || !e.file || !e.reason || typeof e.maxCount !== 'number') {
      throw new Error(`${ALLOWED_SKIPS_PATH}: entry missing suite/file/reason/maxCount: ${JSON.stringify(e)}`)
    }
  }
  return data
}

/** Total allowed-skip budget for one suite name, summed across its entries.
 * Kept for suites that cannot yet attribute a skip to one file (see
 * checkSkipsByFile below for the per-file enforcement Q3 actually asks
 * for). */
export function allowedSkipsForSuite(suiteName, data = loadAllowedSkips()) {
  return data.entries.filter((e) => e.suite === suiteName).reduce((sum, e) => sum + e.maxCount, 0)
}

/**
 * Q3's actual rule, enforced file by file: a skip in a file with no entry at
 * all, or beyond that file's OWN maxCount, is a violation -- summing every
 * entry's maxCount into one suite-wide budget (allowedSkipsForSuite above)
 * let a skip anywhere in the suite spend another file's allowance. Reproduced:
 * with only allowedSkipsForSuite, 21 skips concentrated entirely in
 * install-git-hooks.test.ts (which is only ever allowed 1) still summed to
 * <= 21 and passed, because nats-broker.integration.test.ts's separate
 * 20-skip allowance was never actually spent by anything.
 *
 * @param {string} suiteName
 * @param {Record<string, number>} skipsByFile repo-relative (posix
 *   separators) file path -> skip count actually observed in this run. A
 *   caller that cannot attribute every skip to a real source file (bats,
 *   node --test) should fold the remainder into a synthetic key that matches
 *   no allow-list entry, so it is judged with a zero budget rather than
 *   silently uncounted.
 * @param {{entries: Array<{suite: string, file: string, reason: string, maxCount: number}>}} [data]
 * @returns {string[]} one message per file that exceeded its own budget;
 *   empty when every observed skip is within its file's allowance.
 */
export function checkSkipsByFile(suiteName, skipsByFile, data = loadAllowedSkips()) {
  const violations = []
  for (const [file, count] of Object.entries(skipsByFile)) {
    if (!(count > 0)) continue
    const allowed = data.entries
      .filter((e) => e.suite === suiteName && e.file === file)
      .reduce((sum, e) => sum + e.maxCount, 0)
    if (count > allowed) {
      violations.push(`${file}: ${count} skip(s), exceeds the allowed ${allowed} for this file (see scripts/verify/allowed-skips.json)`)
    }
  }
  return violations
}
