// TASK-045: output -> counts parsers, one per tool the five suites shell out
// to. Every parser returns `null` (not a thrown error, not a best-effort
// guess) when it cannot make sense of its input -- callers turn a `null` into
// `unparseable: true` for lib/guard.mjs, which is a FAIL, never a pass.
import { readFileSync } from 'node:fs'

/**
 * `node --test --test-reporter=tap` summary lines, e.g.:
 *   # tests 4
 *   # pass 3
 *   # fail 0
 *   # skipped 1
 * Present at the end of every run node --test produces, pass or fail.
 */
export function parseNodeTapSummary(text) {
  const get = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'))
    return m ? Number(m[1]) : null
  }
  const collected = get('tests')
  const passed = get('pass')
  const failed = get('fail')
  const skipped = get('skipped')
  if (collected === null || passed === null || failed === null || skipped === null) {
    return null
  }
  return { collected, passed, failed, skipped }
}

/**
 * Top-level `test(` declarations across one or more node:test source files --
 * the same idiom the Makefile's lint-extraction-source / lint-toolchain
 * targets already use. `node --test` reports a file with ZERO of these as ONE
 * synthetic passing test (the file itself), which inflates `# tests`/`# pass`
 * without a single real assertion having run. Comparing this declared count
 * against parseNodeTapSummary(...).collected is what catches that -- a file
 * with 0 declared tests can never equal the >=1 collected the synthetic entry
 * produces, so the mismatch itself is the vacuity signal (see
 * suites/unit.mjs).
 */
export function countDeclaredNodeTests(sourceTexts) {
  let n = 0
  for (const text of sourceTexts) {
    const matches = text.match(/^test\(/gm)
    if (matches) n += matches.length
  }
  return n
}

/**
 * bats' own TAP output: a `1..N` plan, `ok`/`not ok` result lines, and a
 * `# skip` comment on a skipped line (bats' skip form is
 * `ok N description # skip[ reason]`, never `not ok`).
 */
export function parseBatsTap(text) {
  const planMatch = text.match(/^1\.\.(\d+)\s*$/m)
  if (!planMatch) return null
  const collected = Number(planMatch[1])
  const okLines = text.match(/^ok \d+/gm) ?? []
  const notOkLines = text.match(/^not ok \d+/gm) ?? []
  const skipLines = text.match(/^ok \d+[^\n]*#\s*skip/gim) ?? []
  const failed = notOkLines.length
  const skipped = skipLines.length
  const passed = okLines.length - skipped
  return { collected, passed, failed, skipped }
}

/**
 * `vitest run --reporter=json --outputFile=<path>`'s top-level Jest-shaped
 * summary. `numPendingTests` covers both `it.skip` and a test that never ran
 * because its file threw at collection time; vitest's own `success` flag is
 * NOT used here on purpose -- vitest reports `success: true` for a file whose
 * only test is `it.skip` (proved empirically while building this suite), the
 * exact all-skipped-passes-anyway shape this guard exists to catch.
 */
export function parseVitestJsonFile(outputFilePath) {
  let text
  try {
    text = readFileSync(outputFilePath, 'utf8')
  } catch {
    return null
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const collected = data.numTotalTests
  const passed = data.numPassedTests
  const failed = data.numFailedTests
  const skipped = (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0)
  if (
    typeof collected !== 'number' ||
    typeof passed !== 'number' ||
    typeof failed !== 'number' ||
    typeof skipped !== 'number'
  ) {
    return null
  }
  return { collected, passed, failed, skipped }
}

/**
 * `svelte-check --output machine`'s final summary line:
 *   <ts> COMPLETED <n> FILES <n> ERRORS <n> WARNINGS <n> FILES_WITH_PROBLEMS
 * The release-1 gate (integration-gate.sh) parsed this with a tail `grep -oE`
 * that silently defaulted to `errors=?` and then treated `?` as passing --
 * exactly the defect this parser exists to close. Returning `null` (not a
 * best-effort partial match) on a missing/malformed COMPLETED line is the
 * fix: the caller reports `unparseable`, which lib/guard.mjs fails, not
 * passes.
 */
export function parseSvelteCheckMachine(text) {
  const m = text.match(/COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS/)
  if (!m) return null
  const files = Number(m[1])
  const errors = Number(m[2])
  return {
    collected: files,
    passed: files - errors,
    failed: errors,
    skipped: 0,
  }
}
