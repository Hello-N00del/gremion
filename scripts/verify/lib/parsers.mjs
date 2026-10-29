// TASK-045: output -> counts parsers, one per tool the suites shell out to.
// Every parser returns `null` (not a thrown error, not a best-effort guess)
// when it cannot make sense of its input -- callers turn a `null` into
// `unparseable: true` for lib/guard.mjs, which is a FAIL, never a pass.
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * `node --test --test-reporter=tap` summary lines, e.g. (node 26.1):
 *   # tests 6
 *   # suites 0
 *   # pass 3
 *   # fail 0
 *   # cancelled 1
 *   # skipped 1
 *   # todo 1
 * Present at the end of every run node --test produces, pass or fail.
 *
 * `cancelled` is a FAILURE: node reports a test that hit its own `timeout`
 * (or whose parent failed first) as cancelled and leaves `# fail` at 0.
 * Probed 2026-09-25: a file whose only failing test timed out printed
 * `# fail 0 / # cancelled 1`; reading only `fail` made that a pass. `todo`
 * folds into `skipped`, matching vitest's numTodoTests handling below.
 * The five buckets must add up to `# tests`; if they do not, the summary
 * means something this parser does not understand, so it is `null`.
 */
export function parseNodeTapSummary(text) {
  const get = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)\\s*$`, 'm'))
    return m ? Number(m[1]) : null
  }
  const collected = get('tests')
  const pass = get('pass')
  const fail = get('fail')
  const cancelled = get('cancelled')
  const skipped = get('skipped')
  const todo = get('todo')
  if ([collected, pass, fail, cancelled, skipped, todo].some((n) => n === null)) {
    return null
  }
  if (pass + fail + cancelled + skipped + todo !== collected) {
    return null
  }
  return { collected, passed: pass, failed: fail + cancelled, skipped: skipped + todo }
}

/**
 * `test(` declarations across one or more node:test source files, at the
 * start of a line and preceded only by whitespace -- so a `test(` nested
 * inside a `describe(` block (scripts/port-back/check-do-not-overwrite.test.mjs's
 * own style: every one of its 31 real tests is indented two spaces under a
 * `describe`) is counted exactly like a column-0 one. `test.skip(`,
 * `test.only(` and `test.todo(` are declarations too: node counts each of
 * them in `# tests` (as skipped / todo / a normal test), so leaving them out
 * made a file that legitimately uses one read as "declares fewer tests than
 * node collected" -- a false unparseable (round-1 review, MEDIUM).
 *
 * The Makefile's own lint-extraction-source / lint-toolchain targets use a
 * stricter `^test(` (column 0 only) because THEIR suites never nest under
 * `describe`. suites/unit.mjs's node-test subcheck runs over every
 * "scripts, any depth, *.test.mjs" file, including ones that do nest.
 *
 * Not counted, deliberately: `t.test(` subtests and `it(`. node counts a
 * subtest in `# tests`, so a file using them reads as declared < collected
 * and fails as unparseable -- fail-closed, and the message names the file.
 *
 * `node --test` reports a file with ZERO declarations as ONE synthetic
 * passing test (the file itself), which inflates `# tests`/`# pass` without
 * a single real assertion having run. Comparing this declared count against
 * parseNodeTapSummary(...).collected is what catches that (see
 * suites/unit.mjs#nodeTestSubcheck).
 */
export function countDeclaredNodeTests(sourceTexts) {
  let n = 0
  for (const text of sourceTexts) {
    const matches = text.match(/^[ \t]*test(?:\.(?:skip|only|todo))?\(/gm)
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
 * Every failing test of a TAP stream (bats's and node's alike): each `not ok` line with the diagnostic
 * lines under it, in order. A failure's detail used to be the last few hundred characters of the stream,
 * which on a long run is a tail of `ok` lines (CI run 4: 1 of 1668 failed and no log line named it).
 *
 * The lines belonging to a `not ok` are those after it that are indented deeper than it (node's YAML
 * block, a nested subtest) or start with `#` in column 0 (bats's `# (in test file ...)` and output
 * lines), up to the next result line, the next subtest header or node's closing `# tests N` summary. Each
 * block is cut at `maxBlockLines`, and the whole listing at `maxChars`, with a note of what was left out.
 * `''` when there is no `not ok` line.
 */
export function tapFailureBlocks(text, { maxBlockLines = 40, maxChars = 8000 } = {}) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)not ok \d+/)
    if (!m) continue
    const block = [lines[i]]
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (/^\s*(not )?ok \d+/.test(l) || /^\s*# Subtest:/.test(l) || /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(l)) break
      const deeper = l.length - l.trimStart().length > m[1].length
      if (!deeper && !l.startsWith('#')) break
      block.push(l)
    }
    i = j - 1
    blocks.push(block.length > maxBlockLines + 1 ? [...block.slice(0, maxBlockLines + 1), `... (${block.length - maxBlockLines - 1} more line(s) of this failure not shown)`] : block)
  }
  let out = ''
  for (let k = 0; k < blocks.length; k++) {
    const next = blocks[k].join('\n')
    if (out.length + next.length > maxChars && k > 0) return `${out}\n... (${blocks.length - k} more failing test(s) not shown)`
    out += (k > 0 ? '\n' : '') + next
  }
  return out
}

/**
 * `vitest run --reporter=json --outputFile=<path>`'s top-level Jest-shaped
 * summary. `numPendingTests` covers `it.skip`, `numTodoTests` `it.todo`, but
 * NEITHER covers a test file that throws at collection time (a syntax error,
 * a bad import, a top-level throw) -- that file drops out of `numTotalTests`
 * entirely, so the per-test counts alone can look like a clean pass while a
 * whole file silently never ran (reproduced: one passing file plus one file
 * that throws at import gave vitest exit=1 and `{success:false,
 * numTotalTests:1, numPassedTests:1, numFailedTests:0,
 * numFailedTestSuites:1}`). `success` is ALSO not trusted alone for the
 * opposite reason -- vitest reports `success: true` for a file whose only
 * test is `it.skip`, the exact all-skipped-passes-anyway shape this guard
 * exists to catch.
 *
 * So: the per-test counts decide skip-vacuity, and every file in
 * `testResults` that FAILED WITHOUT a failing assertion (a collection error)
 * is added as one collected-and-failed entry. A file that failed only
 * because one of its tests failed is already in numFailedTests and is not
 * counted twice. If vitest says `success:false` and nothing above explains
 * it (an unhandled error outside any test, or a report without
 * `testResults`), one failure is added anyway: vitest's own verdict of
 * "unsuccessful" is never turned into a pass.
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
  let droppedFiles
  if (Array.isArray(data.testResults)) {
    droppedFiles = data.testResults.filter(
      (tr) => tr?.status === 'failed' && !(tr.assertionResults ?? []).some((a) => a?.status === 'failed'),
    ).length
  } else {
    // No per-file detail: every failed suite not already explained by a
    // failing test is a dropped file.
    droppedFiles = rawFailed === 0 ? failedSuites : 0
  }
  if (data.success === false && rawFailed === 0 && droppedFiles === 0) {
    droppedFiles = 1
  }
  return {
    collected: collected + droppedFiles,
    passed,
    failed: rawFailed + droppedFiles,
    skipped,
  }
}

/**
 * Names + first failure line for every failed test in a vitest JSON report,
 * so a red `verify` run can say WHICH tests failed, not only the count.
 * Also names every file that failed with no failing test (a collection
 * error), with vitest's own `message` for it. Returns `[]` (never throws)
 * for a missing/malformed file -- this is a diagnostics add-on, never itself
 * a vacuity signal.
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
    const assertions = tr.assertionResults ?? []
    if (tr.status === 'failed' && !assertions.some((a) => a.status === 'failed')) {
      out.push(`${tr.name ?? '(unnamed file)'}: file failed without a failing test: ${String(tr.message ?? '(no message)').split('\n')[0]}`)
      if (out.length >= limit) return out
    }
    for (const ar of assertions) {
      if (ar.status !== 'failed') continue
      const firstLine = (ar.failureMessages ?? [])[0]?.split('\n')[0] ?? '(no message)'
      out.push(`${ar.fullName ?? ar.title ?? '(unnamed test)'}: ${firstLine}`)
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * Per-file skip counts from a vitest JSON report (Q3): `pending`/`todo`/
 * `skipped` assertions, grouped by the file they belong to.
 * scripts/verify/allowed-skips.json's `file` field is a per-file budget, not
 * a per-suite one. vitest reports `testResults[].name` as an ABSOLUTE path;
 * with `root` given, each key is made repo-relative with posix separators so
 * it compares equal to the allow-list's `file` field. Never throws: a
 * missing/malformed file returns `{}` -- the caller books every skip it
 * cannot attribute here under a zero-budget key (lib/guard.mjs#combineParts),
 * so a lost attribution can only fail a suite, never pass one.
 */
export function skipsByFileFromVitestJson(outputFilePath, { root } = {}) {
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
      if (ar.status === 'pending' || ar.status === 'todo' || ar.status === 'skipped') n++
    }
    if (n === 0) continue
    const key = root ? path.relative(root, path.resolve(tr.name)).split(path.sep).join('/') : tr.name
    out[key] = (out[key] ?? 0) + n
  }
  return out
}

/**
 * Repo-relative (posix separators) names of every test FILE a vitest JSON
 * report attempted at all, whatever its outcome (pass, fail, or every one of
 * its assertions skipped) -- unlike skipsByFileFromVitestJson above, which
 * only names files with a skip to attribute. Used to pin that one SPECIFIC
 * file (e.g. an isolation/security-critical spec) was actually collected,
 * not just that some N tests ran somewhere: a vite `include` glob edit that
 * silently stops matching a file drops it from `testResults` entirely, with
 * no failure and no skip either -- collected/passed counts alone cannot see
 * that. Never throws: a missing/malformed file returns `[]` (the caller's own
 * vacuity checks -- unparseable report, zero collected -- already fail that
 * case; this is a name-level addition, not a substitute for them).
 */
export function collectedFileNamesFromVitestJson(outputFilePath, { root } = {}) {
  let data
  try {
    data = JSON.parse(readFileSync(outputFilePath, 'utf8'))
  } catch {
    return []
  }
  const names = []
  for (const tr of data.testResults ?? []) {
    if (!tr.name) continue
    const key = root ? path.relative(root, path.resolve(tr.name)).split(path.sep).join('/') : tr.name
    names.push(key)
  }
  return names
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
