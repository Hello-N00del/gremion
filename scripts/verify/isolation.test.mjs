// TASK-045 (TASK-117 residual, R24-10): suites/isolation.mjs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'
import { ISOLATION_FILE, pinIsolationFilePart } from './suites/isolation.mjs'

test('pinIsolationFilePart passes when isolation.test.ts is among the collected files', () => {
  const p = pinIsolationFilePart({ collectedFiles: ['packages/storage/src/contract.test.ts', ISOLATION_FILE] })
  assert.equal(p.passed, 1)
  assert.equal(p.failed, 0)
})

// The exact defect this pin exists to catch: a vite/vitest `include` glob
// that stops matching isolation.test.ts drops it from `testResults` with NO
// failure and NO skip -- the suite's raw counts alone look perfectly healthy.
test('pinIsolationFilePart fails, by name, when isolation.test.ts silently drops out of the collected files', () => {
  const p = pinIsolationFilePart({ collectedFiles: ['packages/storage/src/contract.test.ts'] })
  assert.equal(p.passed, 0)
  assert.equal(p.failed, 1)
  assert.match(p.detail, /isolation\.test\.ts was not among the files vitest reported running/)
})

test('a healthy vitest part plus a passing pin combine to an overall PASS', () => {
  const vitestPart = { label: '@gremion/storage vitest (test)', collected: 12, passed: 12, failed: 0, skipped: 0, collectedFiles: [ISOLATION_FILE] }
  const verdict = evaluateSuite(combineParts([vitestPart, pinIsolationFilePart(vitestPart)]))
  assert.equal(verdict.status, 'pass')
})

// This is the real-world shape: vitest itself reports all-green (a glob edit
// dropped the file entirely, so nothing about it ever ran to fail or skip),
// yet the suite must still fail because the pin catches what the counts miss.
test('an all-green vitest part with the file missing still fails the suite overall', () => {
  const vitestPart = { label: '@gremion/storage vitest (test)', collected: 8, passed: 8, failed: 0, skipped: 0, collectedFiles: ['packages/storage/src/contract.test.ts'] }
  const verdict = evaluateSuite(combineParts([vitestPart, pinIsolationFilePart(vitestPart)]))
  assert.equal(verdict.status, 'fail')
  assert.match(verdict.reason, /1 of 9 failed/)
})
