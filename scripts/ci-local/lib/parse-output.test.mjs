import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNodeTest,
  parseVitest,
  parsePlaywright,
  parseBats,
  parseFlutter,
  parseGuard,
  parseCounts,
} from './parse-output.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { run } from './run.mjs'

function pnpmMissing() {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore', shell: true })
    return false
  } catch {
    return 'pnpm not on PATH'
  }
}

test('parsers record skipped tests (only when > 0), so an all-skipped suite is distinguishable from a pass', () => {
  assert.deepEqual(parseVitest('      Tests  12 skipped (12)\n'), { collected: 12, passed: 0, failed: 0, skipped: 12 })
  assert.deepEqual(parsePlaywright('  3 skipped\n'), { collected: 3, passed: 0, failed: 0, skipped: 3 })
  assert.deepEqual(parseNodeTest('# tests 4\n# pass 0\n# fail 0\n# skipped 3\n# todo 1\n'), { collected: 4, passed: 0, failed: 0, skipped: 4 })
  assert.deepEqual(parseBats('1..2\nok 1 a # skip not on windows\nok 2 b\n'), { collected: 2, passed: 1, failed: 0, skipped: 1 })
  assert.deepEqual(parseFlutter('00:05 +40 ~2 -1: Some tests failed.\n'), { collected: 43, passed: 40, failed: 1, skipped: 2 })
  assert.deepEqual(parseFlutter('00:04 +42: All tests passed!\n'), { collected: 42, passed: 42, failed: 0 })
})

test('parseNodeTest reads the TAP summary comment lines', () => {
  const out = `TAP version 13\n1..38\n# tests 38\n# suites 0\n# pass 37\n# fail 1\n# duration_ms 12`
  assert.deepEqual(parseNodeTest(out), { collected: 38, passed: 37, failed: 1 })
})

test('parseNodeTest is RED (0 collected, with a reason) on output with no TAP summary', () => {
  const r = parseNodeTest('node: command not found\n')
  assert.equal(r.collected, 0)
  assert.ok(r.reason)
})

test('parseVitest reads the all-passed summary', () => {
  const out = ` RUN  v4.1.11\n\n Test Files  6 passed (6)\n      Tests  117 passed (117)\n`
  assert.deepEqual(parseVitest(out), { collected: 117, passed: 117, failed: 0 })
})

test('parseVitest reads a mixed pass/fail summary', () => {
  const out = `      Tests  10 passed | 2 failed (12)\n`
  assert.deepEqual(parseVitest(out), { collected: 12, passed: 10, failed: 2 })
})

test('parseVitest is RED (0 collected, with a reason) when vitest never printed a Tests line', () => {
  const r = parseVitest('sh: vitest: command not found\n')
  assert.equal(r.collected, 0)
  assert.ok(r.reason)
})

test('parsePlaywright reads the all-passed summary', () => {
  assert.deepEqual(parsePlaywright('  20 passed (25s)\n'), { collected: 20, passed: 20, failed: 0 })
})

test('parsePlaywright reads a mixed summary across lines', () => {
  const out = '  18 passed (9s)\n  2 failed\n'
  assert.deepEqual(parsePlaywright(out), { collected: 20, passed: 18, failed: 2 })
})

test('parsePlaywright is RED with a reason when nothing matches', () => {
  const r = parsePlaywright('Error: browserType.launch: Executable doesn\'t exist')
  assert.equal(r.collected, 0)
  assert.ok(r.reason)
})

test('parseBats reads a clean TAP run', () => {
  const out = '1..3\nok 1 first\nok 2 second\nok 3 third\n'
  assert.deepEqual(parseBats(out), { collected: 3, passed: 3, failed: 0 })
})

test('parseBats reports the Windows bats-gather-tests failure as 1 collected, 1 failed (never 0 collected)', () => {
  const out = '1..1\nnot ok 1 bats-gather-tests\n'
  assert.deepEqual(parseBats(out), { collected: 1, passed: 0, failed: 1 })
})

test('parseBats is RED with a reason when there is no TAP plan at all', () => {
  const r = parseBats('bash: bats: command not found\n')
  assert.equal(r.collected, 0)
  assert.ok(r.reason)
})

test('parseFlutter reads an all-passed summary', () => {
  assert.deepEqual(parseFlutter('00:04 +42: All tests passed!\n'), { collected: 42, passed: 42, failed: 0 })
})

test('parseFlutter reads a mixed summary', () => {
  assert.deepEqual(parseFlutter('00:09 +40 -2: Some tests failed.\n'), { collected: 42, passed: 40, failed: 2 })
})

test('parseGuard treats a zero exit as one passed arm and non-zero as one failed arm', () => {
  assert.deepEqual(parseGuard('ok', 0), { collected: 1, passed: 1, failed: 0, reason: undefined })
  assert.deepEqual(parseGuard('boom', 1), { collected: 1, passed: 0, failed: 1, reason: 'guard script exited 1' })
})

test('parseCounts("guard", ...) composes the suite\'s own TAP summary with the guard step exit code', () => {
  const out = '1..5\n# tests 5\n# pass 5\n# fail 0\nGUARD-OK\n'
  assert.deepEqual(parseCounts('guard', out, 0), { collected: 6, passed: 6, failed: 0, reason: undefined })
})

test('parseCounts("guard", ...) does not add a phantom pass when the guard step itself fails', () => {
  const out = '1..5\n# tests 5\n# pass 5\n# fail 0\nGUARD FAILED\n'
  assert.deepEqual(parseCounts('guard', out, 1), { collected: 6, passed: 5, failed: 1, reason: 'guard script exited 1' })
})

test('LOW fix: parseCounts("guard", ...) names the guard script\'s exit code in `reason` when the guard step itself fails (it used to be undefined — an empty reason on the FAIL row)', () => {
  const out = '1..5\n# tests 5\n# pass 5\n# fail 0\nGUARD FAILED\n'
  const counts = parseCounts('guard', out, 1)
  assert.equal(counts.reason, 'guard script exited 1')
})

test('parseCounts("guard", ...) never runs the guard step when the suite\'s own test failed (&& short-circuit)', () => {
  const out = '1..5\n# tests 5\n# pass 4\n# fail 1\n'
  // exitCode is non-zero here too (node --test itself failed), but the count
  // must reflect only the test phase - the guard script never executed.
  assert.deepEqual(parseCounts('guard', out, 1), { collected: 5, passed: 4, failed: 1 })
})

test('parseCounts("guard", ...) falls back to a bare pass/fail arm when there is no TAP summary at all', () => {
  assert.deepEqual(parseCounts('guard', 'no test framework output', 0), { collected: 1, passed: 1, failed: 0, reason: undefined })
})

test('parseCounts dispatches by kind', () => {
  assert.deepEqual(parseCounts('node-test', '1..1\n# tests 1\n# pass 1\n# fail 0\n', 0), {
    collected: 1,
    passed: 1,
    failed: 0,
  })
})

test('parseCounts is RED with a reason for an unknown kind', () => {
  const r = parseCounts('not-a-real-kind', '', 0)
  assert.equal(r.collected, 0)
  assert.ok(r.reason)
})

// --- TASK-012-FU finding 4 (MEDIUM): node --test run THROUGH pnpm ----------
// On Node 26 a non-TTY `node --test` with no --test-reporter prints the spec
// reporter, whose summary is `ℹ tests N` — not TAP's `# tests N`. Suites of
// kind node-test that suites.json runs as `pnpm run test:carve` therefore
// read as 0 collected (a false RED) although every test passed.

// Verbatim from `pnpm run test:carve` (a scratch package: node --test on two
// files, one skipped test), stdout piped. Only the pnpm header's absolute
// path is shortened.
const PNPM_WRAPPED_SPEC_GREEN = [
  '',
  '> pnpmwrap@ test:carve <scratch>/pnpmwrap',
  '> node --test a.test.mjs b.test.mjs',
  '',
  '\u2714 a one (0.4274ms)',
  '\u2714 a two (0.0661ms)',
  '\uFE63 a skipped (0.0468ms) # not here',
  '\u2714 b one (0.3867ms)',
  '\u2139 tests 4',
  '\u2139 suites 0',
  '\u2139 pass 3',
  '\u2139 fail 0',
  '\u2139 cancelled 0',
  '\u2139 skipped 1',
  '\u2139 todo 0',
  '\u2139 duration_ms 192.8596',
  '',
].join('\n')

test('FU-4: parseNodeTest reads the spec-reporter summary that pnpm-wrapped node --test prints (ℹ tests / pass / fail / skipped)', () => {
  assert.deepEqual(parseNodeTest(PNPM_WRAPPED_SPEC_GREEN), { collected: 4, passed: 3, failed: 0, skipped: 1 })
  assert.deepEqual(parseCounts('node-test', PNPM_WRAPPED_SPEC_GREEN, 0), { collected: 4, passed: 3, failed: 0, skipped: 1 })
})

test('FU-4: parseNodeTest reads a failing spec summary, and tolerates CRLF line ends and ANSI colour codes (FORCE_COLOR)', () => {
  const red = '\u2716 c fails (0.73ms)\r\n\x1b[34m\u2139 tests 4\x1b[39m\r\n\x1b[34m\u2139 pass 2\x1b[39m\r\n\x1b[34m\u2139 fail 1\x1b[39m\r\n\x1b[34m\u2139 skipped 1\x1b[39m\r\n'
  assert.deepEqual(parseNodeTest(red), { collected: 4, passed: 2, failed: 1, skipped: 1 })
})

test('FU-4: the guard composite also reads a spec summary (its own node --test phase run without --test-reporter=tap)', () => {
  assert.deepEqual(parseCounts('guard', '\u2139 tests 5\n\u2139 pass 5\n\u2139 fail 0\nGUARD-OK\n', 0), { collected: 6, passed: 6, failed: 0, reason: undefined })
})

test('FU-4: REAL pnpm-wrapped node --test output, captured through lib/run.mjs exactly as snapshot.mjs runs a suite, parses to the true counts', { skip: pnpmMissing() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-pnpm-wrapped-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pnpm-wrapped-fixture', private: true, scripts: { 'test:carve': 'node --test a.test.mjs b.test.mjs' } }))
    writeFileSync(join(dir, 'a.test.mjs'), "import test from 'node:test'\ntest('a one', () => {})\ntest('a two', () => {})\n")
    writeFileSync(join(dir, 'b.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert'\ntest('b fails', () => { assert.equal(1, 2) })\n")
    const r = run('pnpm run test:carve', dir, { timeoutMs: 120_000 })
    assert.notEqual(r.exitCode, 0)
    assert.deepEqual(parseCounts('node-test', r.output, r.exitCode), { collected: 3, passed: 2, failed: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
