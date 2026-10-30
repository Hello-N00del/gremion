// gremion-ui/tests/leaf-shred/leaf-shred.pg.test.ts
//
// The newsletter + calendar leaf shred executors
// (src/lib/server/tenant/provisioner/leaf-shred.ts) against a REAL Postgres
// (LEAF_SHRED_TEST_PG_URL: a throwaway container on loopback, a non-5432 port,
// GREMION_PRODUCTION_STACK=none; the destructive-harness guard
// assertNonProductionDbUrl refuses anything else before the first connection).
// Run ONLY through vitest.leaf-shred.config.ts (node environment, this file only,
// no setupFiles). It lives outside src/ so the jsdom unit project never collects it.
//
// Each leaf is provisioned the leaf's way (a copy of the ensureControlDb /
// ensureTenantDb SQL in modules/{publishing,calendar}/src/tenant-store.ts):
// <prefix>control.tenant_catalog holds the tenant's row and <prefix><slug> is its
// database. A pooled connection to the tenant database is held OPEN, as the
// running leaf holds one. The executor must drop the database anyway
// (WITH (FORCE)) and delete the row IN <prefix>control, not on the admin
// database, where no tenant_catalog exists.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import postgres from 'postgres'
import { assertNonProductionDbUrl } from '../integration/assert-safe-test-db-url'
import {
  makeNewsletterLeafShredExecutor,
  makeCalendarLeafShredExecutor,
} from '../../src/lib/server/tenant/provisioner/leaf-shred'

// ── fail-closed guard ──────────────────────────────────────────────────────────
function requireScratchPgUrl(): string {
  const url = process.env.LEAF_SHRED_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[leaf-shred-test] LEAF_SHRED_TEST_PG_URL is REQUIRED: a throwaway Postgres on a NON-5432 loopback port. ' +
        'Refusing to default to localhost:5432.',
    )
  }
  assertNonProductionDbUrl(url, 'LEAF_SHRED_TEST_PG_URL')
  const u = new URL(url)
  if (u.port === '' || u.port === '5432') throw new Error('[leaf-shred-test] SAFETY VIOLATION: port 5432 is a live Postgres port')
  return url
}

const ADMIN_URL = requireScratchPgUrl()

/** One leaf under test, behind a uniform drop / delete surface. */
interface LeafCase {
  name: string
  prefix: 'newsletter_test_' | 'calendar_test_'
  make(): { drop(slug: string): Promise<void>; deleteRow(tenantId: string): Promise<void> }
}

const quiet = (): void => undefined

const LEAVES: LeafCase[] = [
  {
    name: 'newsletter',
    prefix: 'newsletter_test_',
    make() {
      const e = makeNewsletterLeafShredExecutor({ adminUrl: ADMIN_URL, dbPrefix: 'newsletter_test_', log: quiet })
      return { drop: (s) => e.dropNewsletterDb(s), deleteRow: (id) => e.deleteCatalogRow(id) }
    },
  },
  {
    name: 'calendar',
    prefix: 'calendar_test_',
    make() {
      const e = makeCalendarLeafShredExecutor({ adminUrl: ADMIN_URL, dbPrefix: 'calendar_test_', log: quiet })
      return { drop: (s) => e.dropCalendarDb(s), deleteRow: (id) => e.deleteCatalogRow(id) }
    },
  },
]

for (const leaf of LEAVES) {
  if (!leaf.prefix.endsWith('_test_')) throw new Error('[leaf-shred-test] the prefix must be a _test_ namespace')
}

const TENANT = { id: 'a2900000-0000-4000-8000-0000000000a1', slug: 'shred-t' }
const OTHER = { id: 'a2900000-0000-4000-8000-0000000000a2', slug: 'shred-other' }

function dbUrl(db: string): string {
  const u = new URL(ADMIN_URL)
  u.pathname = '/' + db
  return u.toString()
}

let admin: postgres.Sql<{}>

async function dbExists(db: string): Promise<boolean> {
  return (await admin`SELECT 1 FROM pg_database WHERE datname = ${db}`).length === 1
}

async function catalogIds(controlDb: string): Promise<string[]> {
  const ctrl = postgres(dbUrl(controlDb), { max: 1, onnotice: () => {} })
  try {
    return (await ctrl<{ tenant_id: string }[]>`SELECT tenant_id::text AS tenant_id FROM tenant_catalog ORDER BY tenant_id`).map((r) => r.tenant_id)
  } finally {
    await ctrl.end({ timeout: 5 })
  }
}

/** Provision a tenant the leaf's way: the control DB + catalog table, the catalog row, the tenant DB. */
async function provisionLikeTheLeaf(prefix: string, tenant: { id: string; slug: string }): Promise<void> {
  const controlDb = prefix + 'control'
  if (!(await dbExists(controlDb))) await admin.unsafe(`CREATE DATABASE "${controlDb}"`)
  const ctrl = postgres(dbUrl(controlDb), { max: 1, onnotice: () => {} })
  try {
    await ctrl.unsafe(`
      CREATE TABLE IF NOT EXISTS tenant_catalog (
        tenant_id  UUID PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE,
        db_name    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await ctrl`INSERT INTO tenant_catalog (tenant_id, slug, db_name) VALUES (${tenant.id}, ${tenant.slug}, ${prefix + tenant.slug}) ON CONFLICT DO NOTHING`
  } finally {
    await ctrl.end({ timeout: 5 })
  }
  if (!(await dbExists(prefix + tenant.slug))) await admin.unsafe(`CREATE DATABASE "${prefix + tenant.slug}"`)
}

async function cleanup(prefix: string): Promise<void> {
  for (const slug of [TENANT.slug, OTHER.slug, 'trail-']) await admin.unsafe(`DROP DATABASE IF EXISTS "${prefix + slug}" WITH (FORCE)`)
  await admin.unsafe(`DROP DATABASE IF EXISTS "${prefix}control" WITH (FORCE)`)
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  if (admin) {
    for (const leaf of LEAVES) await cleanup(leaf.prefix)
    await admin.end({ timeout: 5 })
  }
})

describe.each(LEAVES)('$name leaf shred executor: real Postgres', (leaf) => {
  const controlDb = leaf.prefix + 'control'
  const tenantDb = leaf.prefix + TENANT.slug
  const otherDb = leaf.prefix + OTHER.slug

  beforeEach(async () => {
    await cleanup(leaf.prefix)
    await provisionLikeTheLeaf(leaf.prefix, TENANT)
    await provisionLikeTheLeaf(leaf.prefix, OTHER)
  })

  it('drops <prefix><slug> while the leaf still holds a pooled connection to it, then deletes the row in <prefix>control', async () => {
    const held = postgres(dbUrl(tenantDb), { max: 2, idle_timeout: 20, onnotice: () => {} })
    await held`SELECT 1`
    try {
      const exec = leaf.make()
      await exec.drop(TENANT.slug)
      await exec.deleteRow(TENANT.id)
    } finally {
      await held.end({ timeout: 1 }).catch(() => undefined)
    }
    expect(await dbExists(tenantDb)).toBe(false)
    expect(await catalogIds(controlDb)).toEqual([OTHER.id])
    // the other tenant is untouched
    expect(await dbExists(otherDb)).toBe(true)
  })

  it('deletes the catalog row in <prefix>control, not on the admin database (no held connection)', async () => {
    const exec = leaf.make()
    await exec.drop(TENANT.slug)
    await exec.deleteRow(TENANT.id)
    expect(await dbExists(tenantDb)).toBe(false)
    expect(await catalogIds(controlDb)).toEqual([OTHER.id])
  })

  it('is idempotent: a re-run on an already-shredded tenant is a no-op', async () => {
    const first = leaf.make()
    await first.drop(TENANT.slug)
    await first.deleteRow(TENANT.id)
    const again = leaf.make()
    await again.drop(TENANT.slug)
    await again.deleteRow(TENANT.id)
    expect(await dbExists(tenantDb)).toBe(false)
    expect(await catalogIds(controlDb)).toEqual([OTHER.id])
  })

  it('treats a missing <prefix>control as "no catalog row" (the leaf never saw a tenant)', async () => {
    await cleanup(leaf.prefix)
    const exec = leaf.make()
    await exec.drop(TENANT.slug)
    await exec.deleteRow(TENANT.id)
    expect(await dbExists(controlDb)).toBe(false)
  })

  it('refuses a slug outside the kernel grammar, and the reserved control, before interpolating it', async () => {
    for (const bad of ['bad"slug', 'UPPER', 'a b', '', 'a'.repeat(31), 'control', 'postgres']) {
      await expect(leaf.make().drop(bad), JSON.stringify(bad)).rejects.toThrow(/invalid tenant slug/)
    }
    expect(await dbExists(controlDb)).toBe(true)
    expect(await dbExists(tenantDb)).toBe(true)
    expect(await catalogIds(controlDb)).toEqual([TENANT.id, OTHER.id].sort())
  })

  it('accepts every slug deleteTenant accepts: a kernel-valid edge slug the leaf grammar rejects does not abort the delete', async () => {
    // `trail-` passes the kernel's validateSlug but not the leaf tenant-store
    // grammar, so the leaf never created a database for it: the drop is an
    // IF EXISTS no-op, not a throw that would leave the tenant in 'deleting'.
    const edge = leaf.make()
    await edge.drop('trail-')
    // and if such a database exists, it is the one dropped (quoted identifier)
    await admin.unsafe(`CREATE DATABASE "${leaf.prefix}trail-"`)
    await leaf.make().drop('trail-')
    expect(await dbExists(leaf.prefix + 'trail-')).toBe(false)
    expect(await dbExists(tenantDb)).toBe(true)
  })

  it('refuses a tenant id that is not a canonical lowercase uuid', async () => {
    await expect(leaf.make().deleteRow('not-a-uuid')).rejects.toThrow(/canonical lowercase uuid/)
    expect(await catalogIds(controlDb)).toEqual([TENANT.id, OTHER.id].sort())
  })
})
