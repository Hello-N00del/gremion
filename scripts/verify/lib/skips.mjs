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

/** Total allowed-skip budget for one suite name, summed across its entries. */
export function allowedSkipsForSuite(suiteName, data = loadAllowedSkips()) {
  return data.entries.filter((e) => e.suite === suiteName).reduce((sum, e) => sum + e.maxCount, 0)
}
