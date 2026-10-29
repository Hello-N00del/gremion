// TASK-045: unit tests for lib/parsers.mjs. Every parser here must return
// `null` on malformed/missing input, never a best-effort guess -- callers
// turn `null` into `unparseable: true`, which lib/guard.mjs fails. This is
// the fix for the release-1 gate's `errors=?` defect (gate-ceba66c.json):
// the old integration-gate.sh grep defaulted an unparseable svelte-check
// count to `?` and then treated `?` as passing.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  countDeclaredNodeTests,
  parseBatsTap,
  parseNodeTapSummary,
  parseSvelteCheckMachine,
  parseVitestJsonFile,
  tapFailureBlocks,
} from './lib/parsers.mjs'

test('parseNodeTapSummary reads the summary lines node --test always prints', () => {
  const tap = '# tests 4\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'
  assert.deepEqual(parseNodeTapSummary(tap), { collected: 4, passed: 3, failed: 0, skipped: 1 })
})

test('parseNodeTapSummary returns null when any summary line is missing', () => {
  assert.equal(parseNodeTapSummary('# tests 4\n# pass 3\n'), null)
  assert.equal(parseNodeTapSummary(''), null)
})

test('countDeclaredNodeTests counts test( at column 0 AND indented under describe()', () => {
  const src = "test('a', () => {})\ntest('b', () => {})\n  test('nested under describe, still counted', () => {})\n"
  assert.equal(countDeclaredNodeTests([src]), 3)
})

test('countDeclaredNodeTests does not count test( that is not at the start of its line', () => {
  const src = "const wrapped = maybeTest(() => {})\nreturn test('a real one', () => {})\n"
  // "return test(..." has non-whitespace (the word "return") before test( on
  // the same line, so it is not counted -- this is the shape that keeps a
  // helper name ending in "test(" (like maybeTest() above) from being
  // mistaken for a declaration too.
  assert.equal(countDeclaredNodeTests([src]), 0)
})

test('countDeclaredNodeTests is 0 for a file with none -- the node-zero fixture shape', () => {
  assert.equal(countDeclaredNodeTests(['export const notATest = true\n']), 0)
})

test('parseBatsTap reads a plan, ok/not-ok and a bats-style skip comment', () => {
  const tap = '1..3\nok 1 first\nnot ok 2 second\nok 3 third # skip not applicable\n'
  assert.deepEqual(parseBatsTap(tap), { collected: 3, passed: 1, failed: 1, skipped: 1 })
})

test('parseBatsTap returns null with no 1..N plan line', () => {
  assert.equal(parseBatsTap('ok 1 first\n'), null)
})

test('parseBatsTap returns null for a truncated run whose ok/not-ok lines fall short of its own plan', () => {
  // Reproduces a real truncated bats run: a 4-test file whose 2nd test kills
  // the file runner prints "1..4", "ok 1", "ok 2" and a bats warning, with no
  // "not ok" for tests 3/4 at all -- the declared plan is the only signal a
  // truncation happened.
  const tap = '1..4\nok 1 first\nok 2 second\n# bats warning: Executed 2 instead of expected 4 tests\n'
  assert.equal(parseBatsTap(tap), null)
})

test('parseVitestJsonFile reads the jest-shaped summary and folds pending+todo into skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(
    file,
    JSON.stringify({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 1, numPendingTests: 1, numTodoTests: 0 }),
  )
  try {
    assert.deepEqual(parseVitestJsonFile(file), { collected: 5, passed: 3, failed: 1, skipped: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseVitestJsonFile returns null for a missing file, never throws', () => {
  assert.equal(parseVitestJsonFile(path.join(tmpdir(), 'definitely-does-not-exist-task045.json')), null)
})

test('parseVitestJsonFile returns null for malformed JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(file, '{not json')
  try {
    assert.equal(parseVitestJsonFile(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseVitestJsonFile returns null when a required numeric field is missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(file, JSON.stringify({ numTotalTests: 5, numPassedTests: 5 }))
  try {
    assert.equal(parseVitestJsonFile(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseVitestJsonFile returns null when the per-test counts do not sum to the total (untrustworthy shape)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(file, JSON.stringify({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 }))
  try {
    assert.equal(parseVitestJsonFile(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseVitestJsonFile folds a file that threw at collection time into failed, not a silent pass', () => {
  // Reproduces the exact shape vitest emits for one passing file plus one
  // file that throws at import: every per-test count is internally
  // consistent (1 = 1 passed + 0 failed + 0 skipped) -- only `success` and
  // `numFailedTestSuites` say the second file never ran at all.
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(
    file,
    JSON.stringify({
      success: false,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 1,
    }),
  )
  try {
    const r = parseVitestJsonFile(file)
    assert.ok(r, 'expected a parsed result, not null')
    assert.ok(r.failed > 0, `expected the dropped suite to count as a failure, got ${JSON.stringify(r)}`)
    assert.equal(r.collected, r.passed + r.failed + r.skipped, 'the returned counts must stay internally consistent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseVitestJsonFile is unaffected by numFailedTestSuites when success is true (no regression on the ordinary green case)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-parsers-test-'))
  const file = path.join(dir, 'result.json')
  writeFileSync(
    file,
    JSON.stringify({ success: true, numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0 }),
  )
  try {
    assert.deepEqual(parseVitestJsonFile(file), { collected: 5, passed: 5, failed: 0, skipped: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseSvelteCheckMachine reads a COMPLETED line and derives passed from files - errors', () => {
  const text = '1700000000000 COMPLETED 12 FILES 2 ERRORS 3 WARNINGS 4 FILES_WITH_PROBLEMS'
  assert.deepEqual(parseSvelteCheckMachine(text), { collected: 12, passed: 10, failed: 2, skipped: 0 })
})

test('parseSvelteCheckMachine returns null (not a passing guess) with no COMPLETED line -- the gate-ceba66c defect', () => {
  assert.equal(parseSvelteCheckMachine('some unrelated svelte-check output\n'), null)
  assert.equal(parseSvelteCheckMachine(''), null)
})

test('tapFailureBlocks is empty for a clean stream', () => {
  assert.equal(tapFailureBlocks('1..2\nok 1 a\nok 2 b\n'), '')
})

test('tapFailureBlocks keeps a node YAML block (blank-looking lines included) and stops before the summary', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: red',
    'not ok 1 - red',
    '  ---',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    ',
    "    + 'left'",
    '  ...',
    '# Subtest: green',
    'ok 2 - green',
    '1..2',
    '# tests 2',
    '# fail 1',
    '',
  ].join('\n')
  const out = tapFailureBlocks(tap)
  assert.match(out, /^not ok 1 - red\n {2}---\n/)
  assert.match(out, /\+ 'left'\n {2}\.\.\.$/)
  assert.doesNotMatch(out, /Subtest|green|# tests|# fail/)
})

test('tapFailureBlocks notes what the caps left out', () => {
  const many = Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} failing ${i}\n# ${'x'.repeat(400)}`).join('\n')
  const out = tapFailureBlocks(many, { maxChars: 2000 })
  assert.match(out, /not ok 1 failing 0/)
  assert.match(out, /\.\.\. \(\d+ more failing test\(s\) not shown\)$/)
  assert.ok(out.length < 2200, String(out.length))
})
