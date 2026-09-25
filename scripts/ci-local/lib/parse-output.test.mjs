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
  assert.deepEqual(parseGuard('ok', 0), { collected: 1, passed: 1, failed: 0 })
  assert.deepEqual(parseGuard('boom', 1), { collected: 1, passed: 0, failed: 1 })
})

test('parseCounts("guard", ...) composes the suite\'s own TAP summary with the guard step exit code', () => {
  const out = '1..5\n# tests 5\n# pass 5\n# fail 0\nGUARD-OK\n'
  assert.deepEqual(parseCounts('guard', out, 0), { collected: 6, passed: 6, failed: 0 })
})

test('parseCounts("guard", ...) does not add a phantom pass when the guard step itself fails', () => {
  const out = '1..5\n# tests 5\n# pass 5\n# fail 0\nGUARD FAILED\n'
  assert.deepEqual(parseCounts('guard', out, 1), { collected: 6, passed: 5, failed: 1 })
})

test('parseCounts("guard", ...) never runs the guard step when the suite\'s own test failed (&& short-circuit)', () => {
  const out = '1..5\n# tests 5\n# pass 4\n# fail 1\n'
  // exitCode is non-zero here too (node --test itself failed), but the count
  // must reflect only the test phase - the guard script never executed.
  assert.deepEqual(parseCounts('guard', out, 1), { collected: 5, passed: 4, failed: 1 })
})

test('parseCounts("guard", ...) falls back to a bare pass/fail arm when there is no TAP summary at all', () => {
  assert.deepEqual(parseCounts('guard', 'no test framework output', 0), { collected: 1, passed: 1, failed: 0 })
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
