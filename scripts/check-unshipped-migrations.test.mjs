import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-unshipped-migrations.mjs')
const run = (tree) => spawnSync(process.execPath, [SCRIPT, '--tree', tree], { encoding: 'utf8' })

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'unshipped-'))
  mkdirSync(join(root, 'gremion-ui', 'migrations'), { recursive: true })
  for (const f of files) writeFileSync(join(root, 'gremion-ui', 'migrations', f), '-- x\n')
  return root
}

test('a clean tree passes', () => {
  const root = tree(['001_governance_schema.sql', '058_public_reader_grants.sql'])
  const r = run(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  rmSync(root, { recursive: true, force: true })
})

test('a planted handover migration fails and is named', () => {
  const root = tree(['001_governance_schema.sql', '050_handover_schema.sql'])
  const r = run(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /UNSHIPPED MIGRATION: .*050_handover_schema\.sql/)
  assert.match(r.stderr, /handover does not ship in release 1 \(D-01\)/)
  rmSync(root, { recursive: true, force: true })
})

test('a renumbered handover migration still fails', () => {
  const root = tree(['1900_handover_event.sql'])
  const r = run(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /1900_handover_event\.sql/)
  rmSync(root, { recursive: true, force: true })
})

test('a tree with no migrations at all fails as vacuous, not green', () => {
  const root = mkdtempSync(join(tmpdir(), 'unshipped-empty-'))
  const r = run(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /scanned zero migration files/)
  rmSync(root, { recursive: true, force: true })
})
