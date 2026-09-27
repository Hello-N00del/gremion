// TASK-045 round 2: lib/guard.mjs#combineParts and evaluateSuite's
// emptyParts rule. Every multi-tool suite (unit, integration, typecheck,
// migration-hash, contracts) used to SUM its sub-checks' counts and judge the
// total, so one sub-check that collected nothing hid behind another's
// non-zero total -- the exact shape of round 1's empty migrations-control
// finding (31 + 0 = 31 > 0, PASS), just general: a ports vitest run that
// finds no files, or a svelte-check over 0 files, is masked the same way.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { combineParts, evaluateSuite } from './lib/guard.mjs'

test('an empty sub-check is named in emptyParts even when the summed total is non-zero', () => {
  const c = combineParts([
    { label: 'gremion-ui vitest', collected: 1900, passed: 1900, failed: 0, skipped: 0 },
    { label: 'ports vitest', collected: 0, passed: 0, failed: 0, skipped: 0 },
  ])
  assert.equal(c.collected, 1900)
  assert.deepEqual(c.emptyParts, ['ports vitest'])
})

test('evaluateSuite fails a suite with an empty sub-check as "collected 0 tests in: <part>", whatever the total', () => {
  const r = evaluateSuite({ collected: 1900, passed: 1900, failed: 0, skipped: 0, emptyParts: ['ports vitest'] })
  assert.equal(r.status, 'fail')
  assert.match(r.reason, /collected 0 tests in: ports vitest/)
})

test('combineParts sums counts, keeps the first missing tool and any unparseable part', () => {
  const c = combineParts([
    { label: 'a', collected: 3, passed: 2, failed: 1, skipped: 0 },
    { label: 'b', toolMissing: 'docker' },
    { label: 'c', unparseable: true, detail: 'no COMPLETED line' },
    { label: 'd', toolMissing: 'bats' },
  ])
  assert.equal(c.toolMissing, 'docker')
  assert.equal(c.unparseable, true)
  assert.equal(c.collected, 3)
  assert.equal(c.failed, 1)
  // A part that never ran (missing tool / unparseable) is judged by those
  // rules, not double-reported as empty.
  assert.deepEqual(c.emptyParts, [])
  assert.match(c.detail, /c: no COMPLETED line/)
})

test('combineParts with no parts at all is unparseable, never an empty pass', () => {
  const c = combineParts([])
  assert.equal(c.unparseable, true)
  assert.equal(evaluateSuite(c).status, 'fail')
})

test('combineParts merges per-file skips and books a part\'s unattributed skips under its own label', () => {
  const c = combineParts([
    { label: 'ports vitest', collected: 184, passed: 164, failed: 0, skipped: 20, skipsByFile: { 'packages/ports/src/x.test.ts': 20 } },
    { label: 'bats', collected: 10, passed: 9, failed: 0, skipped: 1 },
  ])
  assert.deepEqual(c.skipsByFile, { 'packages/ports/src/x.test.ts': 20, 'bats: (skip not attributable to a file)': 1 })
  assert.equal(c.skipped, 21)
})

test('a non-finite count in a part is treated as unparseable, not as 0', () => {
  const c = combineParts([{ label: 'x', collected: Number.NaN, passed: 0, failed: 0, skipped: 0 }])
  assert.equal(c.unparseable, true)
})
