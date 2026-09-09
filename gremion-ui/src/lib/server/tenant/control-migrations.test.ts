// src/lib/server/tenant/control-migrations.test.ts
// P2.1b T1 — control-plane migration manifest smoke (G-012 parity with the
// data-plane check in db.test.ts): the committed migrations-control/manifest.json
// must cover every *.sql file with matching hashes, the committed key order must
// be the sorted apply order, and the fleet-run ledger migration (002, D-FLEET)
// must be part of the set, applying after 001.
import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

describe('control migration manifest on disk (G-012 smoke)', () => {
  // process.cwd() during `pnpm test:unit` is the gremion-ui package root — the
  // same anchor runControlMigrations uses (`join(process.cwd(), 'migrations-control')`).
  const dir = join(process.cwd(), 'migrations-control')
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const manifest = JSON.parse(
    readFileSync(join(dir, 'manifest.json'), 'utf-8'),
  ) as Record<string, string>

  it('manifest covers every *.sql file in migrations-control/ and every hash matches', () => {
    expect(Object.keys(manifest).sort()).toEqual(sqlFiles)
    for (const file of sqlFiles) {
      const bytes = readFileSync(join(dir, file))
      const actual = createHash('sha256').update(bytes).digest('hex')
      expect(manifest[file]).toBe(actual)
    }
  })

  it('manifest keys are committed in sorted (apply) order', () => {
    // build-migration-manifest.mjs writes sorted keys, so the committed file's
    // key order IS the runner's apply order. Pin that invariant.
    expect(Object.keys(manifest)).toEqual(sqlFiles)
  })

  it('002 fleet-run ledger migration exists and applies after 001 (T1, D-FLEET)', () => {
    expect(sqlFiles).toContain('002_tenant_migration_runs.sql')
    expect(sqlFiles.indexOf('001_tenant_registry.sql')).toBeGreaterThanOrEqual(0)
    expect(sqlFiles.indexOf('001_tenant_registry.sql')).toBeLessThan(
      sqlFiles.indexOf('002_tenant_migration_runs.sql'),
    )
  })
})
