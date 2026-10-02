// TASK-012-FU2: two manifest fields that keep suites.json honest as the tree
// grows without a hand-maintained file list.
//
//   excludeGlobs  files a suite's glob reaches but its command does NOT run
//                 (a vitest `exclude`). Without it a unit suite whose glob is
//                 the directory-level `test/**/*.test.ts` would also claim the
//                 module's `*.integration.test.ts`, so a NEW integration file
//                 would be "claimed" by a runner that never executes it: the
//                 exact silent gap the unclaimed check exists to close.
//   unrunnable    a suite whose files are real and claimed, but for which no
//                 runner exists in this tree. It is a FAIL with the stated
//                 reason on every reading (never skipped), so the gap stays
//                 visible without being mislabelled as an unclaimed file.

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSuite, findUnclaimed } from './snapshot-core.mjs'
import { validateManifest } from './manifest.mjs'

function opts(onRun) {
  return {
    joinRepo: (p) => `/repo/${p}`,
    runFn: () => {
      onRun?.()
      return { exitCode: 0, output: '      Tests  3 passed (3)\n', timedOut: false, spawnError: null }
    },
  }
}

const unit = {
  id: 'k-unit',
  repo: 'kernel',
  category: 'unit',
  cwd: 'm',
  kind: 'vitest',
  command: 'pnpm run test',
  testGlobs: ['m/test/**/*.test.ts'],
  excludeGlobs: ['m/test/**/*.integration.test.ts'],
}

test('findUnclaimed: a file matched only by a suite\'s excludeGlobs is NOT claimed by that suite', () => {
  const files = ['m/test/a.test.ts', 'm/test/db.integration.test.ts']
  assert.deepEqual(findUnclaimed(files, [unit]), ['m/test/db.integration.test.ts'])
})

test('findUnclaimed: an integration suite that names the excluded file claims it', () => {
  const integ = { ...unit, id: 'k-int', testGlobs: ['m/test/**/*.integration.test.ts'], excludeGlobs: undefined }
  const files = ['m/test/a.test.ts', 'm/test/db.integration.test.ts']
  assert.deepEqual(findUnclaimed(files, [unit, integ]), [])
})

test('evaluateSuite: a suite whose only matching files are excluded is "files absent", not a pass', () => {
  let ran = false
  const row = evaluateSuite(unit, ['m/test/db.integration.test.ts'], opts(() => (ran = true)))
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /manifest suite files absent/)
  assert.equal(ran, false)
  assert.deepEqual(row.matchedFiles, [])
})

test('evaluateSuite: matchedFiles leaves out the excluded files', () => {
  const row = evaluateSuite(unit, ['m/test/a.test.ts', 'm/test/db.integration.test.ts'], opts())
  assert.deepEqual(row.matchedFiles, ['m/test/a.test.ts'])
  assert.equal(row.status, 'PASS')
})

test('evaluateSuite: an unrunnable suite is a FAIL naming its reason, and never runs the command', () => {
  let ran = false
  const suite = { ...unit, id: 'k-overlay', unrunnable: 'no runner: overlay not wired into a gremion-ui tree', excludeGlobs: undefined }
  const row = evaluateSuite(suite, ['m/test/a.test.ts'], opts(() => (ran = true)))
  assert.equal(row.status, 'FAIL')
  assert.match(row.reason, /could not run: no runner: overlay not wired/)
  assert.equal(ran, false)
  assert.deepEqual(row.matchedFiles, ['m/test/a.test.ts'])
})

test('evaluateSuite: an unrunnable suite whose files vanished still reports "files absent" first', () => {
  const suite = { ...unit, id: 'k-overlay', unrunnable: 'no runner', excludeGlobs: undefined }
  const row = evaluateSuite(suite, ['elsewhere/a.test.ts'], opts())
  assert.match(row.reason, /manifest suite files absent/)
})

function manifestWith(extra) {
  const suite = (id, category, repo) => ({ id, category, repo, cwd: '.', kind: 'guard', command: 'true', testGlobs: ['x.test.mjs'] })
  const cats = ['unit', 'integration', 'e2e', 'shell', 'tree-guard']
  const m = { kernel: cats.map((c) => suite(`k-${c}`, c, 'kernel')), vertical: cats.map((c) => suite(`v-${c}`, c, 'vertical')) }
  Object.assign(m.kernel[0], extra)
  return m
}

test('validateManifest: excludeGlobs must be an array of strings and unrunnable a non-empty string', () => {
  assert.deepEqual(validateManifest(manifestWith({ excludeGlobs: ['a/**/*.test.ts'] })), [])
  assert.deepEqual(validateManifest(manifestWith({ unrunnable: 'because' })), [])
  assert.equal(validateManifest(manifestWith({ excludeGlobs: 'a/**/*.test.ts' })).filter((p) => /excludeGlobs/.test(p)).length, 1)
  assert.equal(validateManifest(manifestWith({ excludeGlobs: [3] })).filter((p) => /excludeGlobs/.test(p)).length, 1)
  assert.equal(validateManifest(manifestWith({ unrunnable: '' })).filter((p) => /unrunnable/.test(p)).length, 1)
  assert.equal(validateManifest(manifestWith({ unrunnable: true })).filter((p) => /unrunnable/.test(p)).length, 1)
})
