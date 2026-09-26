// TASK-045 (Q3): lib/skips.mjs tests. checkSkipsByFile is the per-file
// enforcement the allow-list's own `file` field promises; allowedSkipsForSuite
// (the old suite-wide sum) is kept only as a fallback and tested for its own
// documented behavior, not as if it were the real rule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedSkipsForSuite, checkSkipsByFile, loadAllowedSkips } from './lib/skips.mjs'

const DATA = {
  entries: [
    { suite: 'unit', file: 'packages/ports/src/nats-broker.integration.test.ts', reason: 'r1', maxCount: 20 },
    { suite: 'unit', file: 'gremion-ui/scripts/install-git-hooks.test.ts', reason: 'r2', maxCount: 1 },
    { suite: 'integration', file: 'gremion-ui/tests/integration/municipal-acceptance.integration.test.ts', reason: 'r3', maxCount: 1 },
  ],
}

test('allowedSkipsForSuite sums every entry for the suite (documented, suite-wide fallback behavior)', () => {
  assert.equal(allowedSkipsForSuite('unit', DATA), 21)
})

test('checkSkipsByFile passes when every file stays within its OWN budget', () => {
  const v = checkSkipsByFile(
    'unit',
    { 'packages/ports/src/nats-broker.integration.test.ts': 20, 'gremion-ui/scripts/install-git-hooks.test.ts': 1 },
    DATA,
  )
  assert.deepEqual(v, [])
})

test('checkSkipsByFile fails a file that exceeds its own budget, even though the suite-wide sum would still pass', () => {
  // The real defect: 21 skips all in install-git-hooks.test.ts (allowed: 1)
  // summed to <= allowedSkipsForSuite('unit') = 21 and would have passed
  // under the old suite-wide check alone.
  const v = checkSkipsByFile('unit', { 'gremion-ui/scripts/install-git-hooks.test.ts': 21 }, DATA)
  assert.equal(v.length, 1)
  assert.match(v[0], /install-git-hooks\.test\.ts/)
  assert.match(v[0], /21 skip\(s\), exceeds the allowed 1/)
})

test('checkSkipsByFile fails a skip in a file with NO entry at all (zero budget)', () => {
  const v = checkSkipsByFile('unit', { 'gremion-ui/some-other-file.test.ts': 1 }, DATA)
  assert.equal(v.length, 1)
  assert.match(v[0], /some-other-file\.test\.ts/)
  assert.match(v[0], /exceeds the allowed 0/)
})

test('checkSkipsByFile fails a skip attributed to the wrong SUITE for an otherwise-listed file', () => {
  // municipal-acceptance is only allow-listed under "integration", not "unit".
  const v = checkSkipsByFile('unit', { 'gremion-ui/tests/integration/municipal-acceptance.integration.test.ts': 1 }, DATA)
  assert.equal(v.length, 1)
})

test('checkSkipsByFile ignores files with a zero or absent skip count', () => {
  const v = checkSkipsByFile('unit', { 'gremion-ui/scripts/install-git-hooks.test.ts': 0 }, DATA)
  assert.deepEqual(v, [])
})

// Round 2 MEDIUM: on Windows, packages/storage/src/local.test.ts's
// it.skipIf(!canSymlinkFiles) case and gremion-ui's
// src/lib/server/boundary/contracts-gate-staged.test.ts's
// it.skipIf(win32) case fail with "unaccounted skip(s)" -- the allow-list was
// never updated after the ccd5727 sync, so the gate fails closed but can
// never go green on this host. local.test.ts is collected both via
// gremion-ui's vite include (suite "unit") AND via the isolation suite's own
// @gremion/storage `test` run (suite "isolation"), so it needs an entry for
// EACH suite that can observe it.
test('the real allowed-skips.json accounts for the Windows-only skips this host actually hits', () => {
  const data = loadAllowedSkips()
  const need = [
    { suite: 'unit', file: 'packages/storage/src/local.test.ts' },
    { suite: 'isolation', file: 'packages/storage/src/local.test.ts' },
    { suite: 'unit', file: 'gremion-ui/src/lib/server/boundary/contracts-gate-staged.test.ts' },
  ]
  for (const { suite, file } of need) {
    const entry = data.entries.find((e) => e.suite === suite && e.file === file)
    assert.ok(entry, `allowed-skips.json has no entry for suite="${suite}" file="${file}"`)
    assert.ok(entry.maxCount >= 1, `entry for ${file} (suite ${suite}) has maxCount < 1`)
  }
})
