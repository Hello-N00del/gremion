// TASK-045 (brief S6 item 6): check-record.mjs tests. checkRecord() takes an
// injected readRecordFn/requiredSuites so these never touch the real
// scripts/verify/out/ directory or this repo's real required-suites.txt.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRecord } from './check-record.mjs'

const REQUIRED = ['typecheck', 'unit', 'integration', 'migration-hash', 'carve-lint']

function allGreenSuites() {
  return Object.fromEntries(REQUIRED.map((s) => [s, { status: 'pass', collected: 1, passed: 1, failed: 0, skipped: 0 }]))
}

test('a missing record fails, naming where it looked', () => {
  const r = checkRecord('deadbeef', { readRecordFn: () => null, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no result record for deadbeef/)
})

test('a record keyed to a different sha fails (stale/corrupt) rather than being trusted', () => {
  const record = { sha: 'other-sha', partial: false, suites: allGreenSuites() }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /keyed other-sha, not deadbeef/)
})

test('a partial (--only) record never satisfies check-record', () => {
  const record = { sha: 'deadbeef', partial: true, only: 'unit', suites: { unit: { status: 'pass' } } }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /partial/)
})

test('a record missing a required suite entirely fails, naming it', () => {
  const suites = allGreenSuites()
  delete suites['carve-lint']
  const record = { sha: 'deadbeef', partial: false, suites }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /missing required suite\(s\): carve-lint/)
})

test('a record where one required suite failed fails, naming the reason', () => {
  const suites = allGreenSuites()
  suites.unit = { status: 'fail', reason: 'collected 0 tests' }
  const record = { sha: 'deadbeef', partial: false, suites }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /unit \(fail: collected 0 tests\)/)
})

test('a hand-edited ok:true is never trusted -- pass/fail is recomputed from suites', () => {
  const suites = allGreenSuites()
  suites.integration = { status: 'fail', reason: 'missing tool: docker' }
  const record = { sha: 'deadbeef', partial: false, ok: true, suites }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
})

test('a complete, all-green, non-partial record passes', () => {
  const record = { sha: 'deadbeef', partial: false, suites: allGreenSuites() }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, true)
})
