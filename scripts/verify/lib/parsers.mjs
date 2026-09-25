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
 * `test(` declarations across one or more node:test source files, at the
 * start of a line and preceded only by whitespace -- so a `test(` nested
 * inside a `describe(` block (scripts/port-back/check-do-not-overwrite.test.mjs's
 * own style: every one of its 31 real tests is indented two spaces under a
 * `describe`) is counted exactly like a column-0 one. The Makefile's own
 * lint-extraction-source / lint-toolchain targets use a stricter `^test(`
 * (column 0 only) because THEIR suites never nest under `describe` -- their
 * own comments say so explicitly ("if the suite is ever restructured so its
 * tests no longer start at column 0, this fails loudly"). suites/unit.mjs's
 * node-test subcheck runs over every "scripts, any depth, *.test.mjs" file
 * indiscriminately, including ones that do nest, so anchoring on indentation
 * alone (not "no indentation") is what keeps a real, fully-tested file like
 * check-do-not-overwrite.test.mjs from being misread as declaring zero tests
 * -- caught by running this suite for real, not assumed (see the TASK-045
 * commit message for the exact mismatch it produced before this fix).
 *
 * `node --test` reports a file with ZERO of these as ONE synthetic passing
 * test (the file itself), which inflates `# tests`/`# pass` without a single
 * real assertion having run. Comparing this declared count against
 * parseNodeTapSummary(...).collected is what catches that -- a file with 0
 * declared tests can never equal the >=1 collected the synthetic entry
 * produces, so the mismatch itself is the vacuity signal (see
 * suites/unit.mjs).
 */
export function countDeclaredNodeTests(sourceTexts) {
  let n = 0
  for (const text of sourceTexts) {
    const matches = text.match(/^[ \t]*test\(/gm)
    if (matches) n += matches.length
  }
  return n
}

/**
 * bats' own TAP output: a `1..N` plan, `ok`/`not ok` result lines, and a
 * `# skip` comment on a skipped line (bats' skip form is
 * `ok N description # skip[ reason]`, never `not ok`).
 *
 * A truncated run (the file's test runner crashes or is killed partway
 * through, e.g. by a timeout) prints fewer `ok`/`not ok` lines than its own
 * declared plan, WITHOUT ever emitting a `not ok` for the tests it never got
 * to -- bats has no line at all for a test that never ran. Reproduced with a
 * real 4-test file whose 2nd test kills the runner: `1..4`, `ok 1`, `ok 2`,
 * then a bats warning, docker exit 1. Comparing the plan against what was
 * actually reported is what catches that: a mismatch is unparseable (a FAIL
 * via lib/guard.mjs), never a partial pass.
 */
export function parseBatsTap(text) {
  const planMatch = text.match(/^1\.\.(\d+)\s*$/m)
  if (!planMatch) return null
  const collected = Number(planMatch[1])
  const okLines = text.match(/^ok \d+/gm) ?? []
  const notOkLines = text.match(/^not ok \d+/gm) ?? []
  const skipLines = text.match(/^ok \d+[^\n]*#\s*skip/gim) ?? []
  if (okLines.length + notOkLines.length !== collected) {
    return null
  }
  const failed = notOkLines.length
  const skipped = skipLines.length
  const passed = okLines.length - skipped
  return { collected, passed, failed, skipped }
}

/**
 * `vitest run --reporter=json --outputFile=<path>`'s top-level Jest-shaped
 * summary. `numPendingTests` covers `it.skip`/`it.todo`, but NOT a test file
 * that throws at collection time (a syntax error, a bad import, a top-level
 * throw) -- that file drops out of `numTotalTests` entirely instead of
 * counting as pending, so the per-test counts alone can look like a clean
 * pass while a whole file silently never ran (reproduced empirically: one
 * passing file plus one file that throws at import gave vitest exit=1 and
 * `{success:false, numTotalTests:1, numPassedTests:1, numFailedTests:0,
 * numFailedTestSuites:1}` -- every per-test count is internally consistent,
 * only `success`/`numFailedTestSuites` say anything went wrong). `success` is
 * ALSO not trusted alone for the opposite reason -- vitest reports
 * `success: true` for a file whose only test is `it.skip` (proved empirically
 * while building this suite), the exact all-skipped-passes-anyway shape this
 * guard exists to catch. So both signals are used: the per-test counts decide
 * skip-vacuity, and `numFailedTestSuites`/`success` catch a file that never
 * contributed a count at all -- matching the release-1 gate's
 * `grep '[0-9]+ failed'` on "Test Files N failed", which this JSON parser
 * replaces.
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
  const rawFailed = data.numFailedTests
  const pending = data.numPendingTests ?? 0
  const todo = data.numTodoTests ?? 0
  const failedSuites = data.numFailedTestSuites ?? 0
  if (
    typeof collected !== 'number' ||
    typeof passed !== 'number' ||
    typeof rawFailed !== 'number' ||
    typeof pending !== 'number' ||
    typeof todo !== 'number' ||
    typeof failedSuites !== 'number'
  ) {
    return null
  }
  const skipped = pending + todo
  // The per-test counts are trustworthy only when every test vitest
  // attempted actually contributed to one of these buckets. A mismatch means
  // the reporter's shape does not mean what this parser assumes it means, so
  // it is unparseable, not a best-effort pass.
  if (collected !== passed + rawFailed + skipped) {
    return null
  }
  // Fold in whole files that threw at collection time and never contributed
  // ANY count above: each is a real failure this parser must not lose.
  const droppedSuites = data.success === false ? Math.max(failedSuites, 1) : failedSuites
  return {
    collected: collected + droppedSuites,
    passed,
    failed: rawFailed + droppedSuites,
    skipped,
  }
}

/**
 * Names + first failure line for every failed test in a vitest JSON report,
 * so a red `verify` run can say WHICH tests failed, not only the count.
 * Found needed by actually running the integration suite for real: without
 * this, "5 of 155 failed" gave no lead at all on which 5. Returns `[]` (never
 * throws) for a missing/malformed file -- this is a diagnostics add-on, never
 * itself a vacuity signal, so it must not turn a real failure into an
 * unparseable one just because the report shape changed.
 */
export function summarizeVitestFailures(outputFilePath, limit = 10) {
  let data
  try {
    data = JSON.parse(readFileSync(outputFilePath, 'utf8'))
  } catch {
    return []
  }
  const out = []
  for (const tr of data.testResults ?? []) {
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status !== 'failed') continue
      const firstLine = (ar.failureMessages ?? [])[0]?.split('\n')[0] ?? '(no message)'
      out.push(`${ar.fullName ?? ar.title ?? '(unnamed test)'}: ${firstLine}`)
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * Per-file skip counts from a vitest JSON report (Q3): `pending`/`todo`
 * assertions, grouped by the file (`testResults[].name`, the ABSOLUTE path
 * vitest itself reports) they belong to. scripts/verify/allowed-skips.json's
 * `file` field is a per-file budget, not a per-suite one -- summing every
 * entry's maxCount into one suite-wide total (the old lib/skips.mjs
 * behavior) let a skip anywhere in the suite spend another file's
 * allowance. Callers normalize the returned absolute paths against
 * REPO_ROOT (posix separators) to match allowed-skips.json's repo-relative
 * `file` field. Never throws: a missing/malformed file returns `{}`, same
 * as `summarizeVitestFailures` -- this is a second read of a report already
 * validated by `parseVitestJsonFile`, not itself a vacuity signal.
 */
export function skipsByFileFromVitestJson(outputFilePath) {
  let data
  try {
    data = JSON.parse(readFileSync(outputFilePath, 'utf8'))
  } catch {
    return {}
  }
  const out = {}
  for (const tr of data.testResults ?? []) {
    if (!tr.name) continue
    let n = 0
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status === 'pending' || ar.status === 'todo') n++
    }
    if (n > 0) out[tr.name] = (out[tr.name] ?? 0) + n
  }
  return out
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
