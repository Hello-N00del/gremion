// R25-2: `make lint-js` is a RATCHET over `vp lint` (Oxlint) errors until the
// baseline reaches zero: it fails when the error count rises above the
// recorded baseline, and asks for the baseline to be lowered when it falls.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countErrors, judge } from './check-lint-js.mjs'

test('countErrors counts only error-severity diagnostics', () => {
  const report = { diagnostics: [{ severity: 'error' }, { severity: 'warning' }, { severity: 'error' }] }
  assert.equal(countErrors(report), 2)
})

test('countErrors refuses a report without a diagnostics array (never a vacuous 0)', () => {
  assert.throws(() => countErrors({}), /diagnostics/)
  assert.throws(() => countErrors(null), /diagnostics/)
})

test('judge fails when errors rise above the baseline', () => {
  const r = judge({ errors: 245, baseline: 244 })
  assert.equal(r.ok, false)
  assert.match(r.message, /245 errors.*baseline 244/)
})

test('judge passes at the baseline', () => {
  assert.equal(judge({ errors: 244, baseline: 244 }).ok, true)
})

test('judge passes below the baseline and asks for it to be lowered', () => {
  const r = judge({ errors: 200, baseline: 244 })
  assert.equal(r.ok, true)
  assert.match(r.message, /lower .*baseline.* to 200/)
})

test('judge refuses a missing or negative baseline', () => {
  assert.throws(() => judge({ errors: 1, baseline: undefined }), /baseline/)
  assert.throws(() => judge({ errors: 1, baseline: -1 }), /baseline/)
})
