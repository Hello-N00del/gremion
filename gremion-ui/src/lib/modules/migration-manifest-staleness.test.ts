import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// build-migration-manifest.mjs regenerates manifest.json at `pnpm prebuild`, so a
// stale committed manifest is invisible until db.ts:189 refuses a migration at
// boot with an integrity error. This test is that gap closed at unit-test speed.
function assertManifestFresh(dirName: string, expectedCount: number) {
  const dir = join(UI, dirName)
  const committed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as Record<string, string>
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  expect(files.length, `${dirName} file count`).toBe(expectedCount)
  expect(Object.keys(committed).sort()).toEqual(files)
  for (const f of files) {
    const want = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
    expect(committed[f], `${dirName}/${f} hash is stale`).toBe(want)
  }
}

/** Executable SQL only: the dropped seed's rationale comment survives above it. */
const executableOf = (abs: string) =>
  readFileSync(abs, 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')

describe('committed migration manifests are not stale', () => {
  it('migrations/manifest.json covers all 31 data-plane files', () => {
    assertManifestFresh('migrations', 31)
  })

  it('migrations-control/manifest.json covers all 5 control files', () => {
    assertManifestFresh('migrations-control', 5)
  })

  it('control 004_tenant_domain.sql creates the tenant_domain table and its unique index', () => {
    const body = readFileSync(join(UI, 'migrations-control', '004_tenant_domain.sql'), 'utf-8')
    expect(body).toMatch(/CREATE TABLE tenant_domain \(/)
    expect(body).toMatch(/host\s+text PRIMARY KEY/)
    expect(body).toMatch(/CREATE UNIQUE INDEX tenant_domain_one_primary ON tenant_domain \(tenant_id\) WHERE is_primary;/)
  })

  // Spec B §T.1: the issuer-derived seed is DROPPED on port. Assert the
  // EXECUTABLE body, not the whole file — the rationale comment above the
  // deleted statement still names AUTH_KEYCLOAK_ISSUER (measured: source
  // :102 is a comment, the statement itself is :104-119).
  it('control 004 carries no issuer-derived seed', () => {
    const sql = executableOf(join(UI, 'migrations-control', '004_tenant_domain.sql'))
    expect(sql).not.toMatch(/INSERT INTO tenant_domain/)
    expect(sql).not.toMatch(/t\.issuer/)
    expect(sql).not.toMatch(/AUTH_KEYCLOAK_ISSUER/)
  })
})
