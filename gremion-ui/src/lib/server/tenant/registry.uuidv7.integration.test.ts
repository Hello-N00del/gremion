// TASK-019 (L3-04, CAP-PG18): the ids the control registry hands across a
// service boundary are RFC 9562 version-7 UUIDs, minted by the database.
//
// control migration 006 sets DEFAULT uuidv7() on tenant.id and
// tenant_migration_run.id; uuidv7() exists from PostgreSQL 18 on, so this
// suite is also a reading of the major the control database really runs.
// packages/tenant-store (TASK-020) re-asserts the same property through its
// own API; until then registerTenant() is the boundary the id crosses.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { registerTenant, startTenantMigrationRun, type TenantInput } from './registry'

const SLUG = 'uuidv7-probe'

// RFC 9562 §5.7: version nibble 7 (the 13th hex digit), variant bits 10
// (the 17th hex digit is 8, 9, a or b).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 48-bit big-endian Unix-epoch millisecond timestamp of a v7 UUID. */
function unixMsOf(uuid: string): number {
  return parseInt(uuid.replace(/-/g, '').slice(0, 12), 16)
}

function inputFor(slug: string): TenantInput {
  return {
    slug,
    status: 'active',
    dbConnRef: 'env:DATABASE_URL',
    realmName: slug,
    issuer: `https://${slug}.example/auth/realms/${slug}`,
    kcInternal: `http://keycloak:8080/auth/realms/${slug}`,
    kcClientId: 'gremion-admin',
    kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
    authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
    ncTarget: {},
    matrixSpace: {},
    domainProfile: {},
    brandRef: `config:${slug}`,
    blueprintRef: 'STURA_BLUEPRINT@1',
    connProfile: { perTenantMax: 2, prepare: true },
    backupKeyRef: 'env:AUTH_KEYCLOAK_SECRET',
    audiences: ['gremion-ui'],
  }
}

beforeAll(async () => {
  await runControlMigrations()
  await getControlDb()`DELETE FROM tenant WHERE slug = ${SLUG}`
})
afterEach(async () => {
  await getControlDb()`DELETE FROM tenant WHERE slug = ${SLUG}`
})

describe('control-registry boundary ids (RFC 9562)', () => {
  it('tenant id returned by the registry parses as an RFC 9562 version-7 UUID', async () => {
    const before = Date.now()
    const t = await registerTenant(inputFor(SLUG))
    const after = Date.now()

    expect(t.id).toMatch(UUID_V7)
    // the version the SERVER reads off the same value, not only our regex
    const [{ v }] = await getControlDb()<{ v: number }[]>`SELECT uuid_extract_version(${t.id}::uuid) AS v`
    expect(Number(v)).toBe(7)
    // a v7 id carries its creation instant: it must be THIS insert's, within
    // clock skew between this process and the database container
    const ms = unixMsOf(t.id)
    expect(ms).toBeGreaterThanOrEqual(before - 60_000)
    expect(ms).toBeLessThanOrEqual(after + 60_000)
  })

  it('a fleet-run ledger id is minted as version 7 too', async () => {
    const t = await registerTenant(inputFor(SLUG))
    const runId = await startTenantMigrationRun(t.id)
    expect(runId).toMatch(UUID_V7)
  })

  it('both control-plane id columns default to uuidv7() in the catalog', async () => {
    const rows = await getControlDb()<{ table_name: string; column_default: string }[]>`
      SELECT table_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'
        AND table_name IN ('tenant', 'tenant_migration_run')
      ORDER BY table_name`
    expect(rows).toEqual([
      { table_name: 'tenant', column_default: 'uuidv7()' },
      { table_name: 'tenant_migration_run', column_default: 'uuidv7()' },
    ])
  })
})
