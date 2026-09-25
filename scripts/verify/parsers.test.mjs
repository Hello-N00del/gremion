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
} from './lib/parsers.mjs'

test('parseNodeTapSummary reads the four summary lines node --test always prints', () => {
  const tap = '# tests 4\n# pass 3\n# fail 0\n# skipped 1\n'
  assert.deepEqual(parseNodeTapSummary(tap), { collected: 4, passed: 3, failed: 0, skipped: 1 })
})

test('parseNodeTapSummary returns null when any summary line is missing', () => {
  assert.equal(parseNodeTapSummary('# tests 4\n# pass 3\n'), null)
  assert.equal(parseNodeTapSummary(''), null)
})

test('countDeclaredNodeTests counts only top-level test( at column 0', () => {
  const src = "test('a', () => {})\ntest('b', () => {})\n  test('nested, not counted', () => {})\n"
  assert.equal(countDeclaredNodeTests([src]), 2)
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

test('parseSvelteCheckMachine reads a COMPLETED line and derives passed from files - errors', () => {
  const text = '1700000000000 COMPLETED 12 FILES 2 ERRORS 3 WARNINGS 4 FILES_WITH_PROBLEMS'
  assert.deepEqual(parseSvelteCheckMachine(text), { collected: 12, passed: 10, failed: 2, skipped: 0 })
})

test('parseSvelteCheckMachine returns null (not a passing guess) with no COMPLETED line -- the gate-ceba66c defect', () => {
  assert.equal(parseSvelteCheckMachine('some unrelated svelte-check output\n'), null)
  assert.equal(parseSvelteCheckMachine(''), null)
})
