// TASK-045 (brief S6 item 6): check-record.mjs tests. checkRecord() takes an
// injected readRecordFn/requiredSuites so these never touch the real
// scripts/verify/out/ directory or this repo's real required-suites.txt.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

// Round 2 LOW: main() had no try/catch. A record with no `suites` field (a
// truncated write, a hand-edited file) made `s in record.suites` throw a raw
// TypeError instead of a formatted [check-record] FAIL -- fail-closed (the
// process still exits non-zero), but the CLI's own contract (a formatted
// reason, per its header comment) was broken.
test('a record with no "suites" field at all fails with a formatted reason, not a raw TypeError', () => {
  const record = { sha: 'deadbeef', partial: false }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /malformed.*"suites"/)
})

test('a record whose "suites" field is not an object fails the same formatted way', () => {
  const record = { sha: 'deadbeef', partial: false, suites: 'not-an-object' }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, false)
  assert.match(r.reason, /malformed.*"suites"/)
})

test('a complete, all-green, non-partial record passes', () => {
  const record = { sha: 'deadbeef', partial: false, suites: allGreenSuites() }
  const r = checkRecord('deadbeef', { readRecordFn: () => record, requiredSuites: REQUIRED })
  assert.equal(r.ok, true)
})

test('the CLI entrypoint actually runs (and exits non-zero) from a checkout path containing a space', () => {
  // Reproduces the real defect: both check-record.mjs and verify.mjs decided
  // whether to run main() by hand-building a `file://` string and comparing
  // it to import.meta.url. For a path containing a space (URL-encoded as
  // %20 in import.meta.url but not in the hand-built string), the comparison
  // was always false, so main() never ran and the process exited 0 with no
  // output at all -- a merge block would have passed on nothing. Any
  // Windows user profile with a space in it (e.g. "PixelLite Test") is
  // affected, not just this synthetic case. Only scripts/verify/ itself
  // needs copying: every import inside it is relative, and this call passes
  // an explicit sha so headSha()/REPO_ROOT are never consulted.
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'verify-space-test-'))
  const spacedVerifyDir = path.join(scratchRoot, 'sp ace', 'verify')
  cpSync(path.join(import.meta.dirname), spacedVerifyDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}out${path.sep}`) && !src.endsWith(`${path.sep}out`),
  })
  try {
    const copiedCheckRecord = path.join(spacedVerifyDir, 'check-record.mjs')
    const res = spawnSync(process.execPath, [copiedCheckRecord, 'deadbeef-does-not-exist'], { encoding: 'utf8' })
    assert.notEqual(res.status, 0, `expected a non-zero exit naming the missing record, got ${res.status} with stdout=${res.stdout} stderr=${res.stderr}`)
    assert.match(res.stdout + res.stderr, /no result record/)
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
})
