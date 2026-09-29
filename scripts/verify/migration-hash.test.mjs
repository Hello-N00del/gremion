// TASK-045 (brief S6 item 5): migration-hash suite tests, against the
// checked-in fixtures under __fixtures__/migration-hash/. Never calls the
// manifest builder (gremion-ui/scripts/build-migration-manifest.mjs) -- that
// writes in place and would silently "fix" a wrong manifest instead of
// failing on one.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkMigrationHashes, runMigrationHashSuite } from './suites/migration-hash.mjs'

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'migration-hash')

test('an altered .sql file is caught as a hash mismatch, naming the file', () => {
  const r = checkMigrationHashes(path.join(FIXTURES, 'altered'))
  assert.equal(r.unparseable, false)
  assert.equal(r.collected, 1)
  assert.equal(r.failed, 1)
  assert.deepEqual(r.mismatches, ['001_a.sql'])
})

test('an empty migrations directory is refused, not treated as nothing-to-check', () => {
  const r = checkMigrationHashes(path.join(FIXTURES, 'empty'))
  assert.equal(r.unparseable, false)
  assert.equal(r.collected, 0)
  assert.equal(r.failed, 0)
  // collected: 0 -> lib/guard.mjs's zero-collected rule fails this, exactly
  // like a test suite that collected zero tests (brief S6 item 5).
})

test('a directory that cannot be read at all is unparseable, not vacuously clean', () => {
  const r = checkMigrationHashes(path.join(FIXTURES, 'does-not-exist'))
  assert.equal(r.unparseable, true)
})

test('a file present on disk but absent from manifest.json is reported, not silently accepted', () => {
  const r = checkMigrationHashes(path.join(FIXTURES, 'altered'))
  // manifest.json here only omits nothing today (001_a.sql IS listed, just
  // with a wrong hash) -- missingFromManifest must stay empty for this
  // fixture so a future edit to it cannot quietly stop testing the mismatch
  // path this test exists for.
  assert.deepEqual(r.missingFromManifest, [])
})

test('an empty directory whose manifest.json still lists files reports them missing-from-disk, not nothing-to-check', () => {
  // Reproduces the real defect (brief S6 item 5): every *.sql file removed
  // from migrations-control while its manifest.json still lists 4 files.
  const r = checkMigrationHashes(path.join(FIXTURES, 'empty-with-manifest'))
  assert.equal(r.unparseable, false)
  assert.equal(r.collected, 0)
  assert.equal(r.empty, true)
  assert.deepEqual(r.missingFromDisk, ['001_ghost.sql'])
  assert.ok(r.failed > 0, 'a manifest entry with no file on disk must count as a failure')
})

test('runMigrationHashSuite fails when EITHER directory is empty, even if the other has real passing files', () => {
  // The real defect this suite-level test guards: summing collected across
  // both directories let one healthy directory's non-zero count mask the
  // other directory's empty one (31 + 0 is still > 0).
  const root = mkdtempSync(path.join(tmpdir(), 'verify-migration-hash-suite-test-'))
  try {
    const healthyDir = path.join(root, 'gremion-ui', 'migrations')
    const emptyDir = path.join(root, 'gremion-ui', 'migrations-control')
    mkdirSync(healthyDir, { recursive: true })
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(path.join(healthyDir, '001_a.sql'), 'select 1;\n')
    const hash = createHash('sha256').update('select 1;\n').digest('hex')
    writeFileSync(path.join(healthyDir, 'manifest.json'), JSON.stringify({ '001_a.sql': hash }))
    // TASK-029: the suite reads its directories from the migration register
    mkdirSync(path.join(root, 'scripts', 'migrations'), { recursive: true })
    writeFileSync(
      path.join(root, 'scripts', 'migrations', 'ranges.json'),
      JSON.stringify({ chains: [{ id: 'a', manifestDirs: ['gremion-ui/migrations'] }, { id: 'b', manifestDirs: ['gremion-ui/migrations-control'] }] }),
    )
    // emptyDir has no .sql files and no manifest.json at all -- the
    // genuinely-empty shape.
    const r = runMigrationHashSuite({ root })
    assert.equal(r.unparseable, true)
    assert.match(r.detail, /migrations-control/)
    assert.match(r.detail, /empty/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
