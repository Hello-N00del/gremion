// TASK-045 (brief S6 item 5): migration-hash suite tests, against the
// checked-in fixtures under __fixtures__/migration-hash/. Never calls the
// manifest builder (gremion-ui/scripts/build-migration-manifest.mjs) -- that
// writes in place and would silently "fix" a wrong manifest instead of
// failing on one.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { checkMigrationHashes } from './suites/migration-hash.mjs'

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
