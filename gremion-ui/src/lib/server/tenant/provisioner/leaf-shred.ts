// src/lib/server/tenant/provisioner/leaf-shred.ts
//
// The live newsletter + calendar leaf shred executors for tenant delete. Each
// leaf keeps its tenants the tenant-store way
// (modules/{publishing,calendar}/src/tenant-store.ts): <prefix>control.tenant_catalog
// holds one row per tenant and <prefix><slug> is the tenant's database, both on
// the leaf's Postgres server.
//
// The inline executor these replace carried two defects (proven by
// tests/leaf-shred/leaf-shred.pg.test.ts, RED on the extracted original):
//   1. `DELETE FROM tenant_catalog` ran on the ADMIN url's database, but the
//      catalog lives in <prefix>control -> "relation tenant_catalog does not exist";
//   2. DROP DATABASE had no WITH (FORCE), so it failed while the running leaf
//      held a pooled connection -> "database ... is being accessed by other users".
// Either one made deleteTenant abort before the tombstone.
//
// Here: DROP DATABASE IF EXISTS "<prefix><slug>" WITH (FORCE) on the admin url
// (PG 13+), and the catalog DELETE on <prefix>control (a missing control
// database is a no-op: the leaf never saw a tenant). Each call opens its own
// single connection and closes it in a finally, so a re-run with a fresh
// executor is idempotent. The slug is validated with the kernel's validateSlug
// (../slug: ^[a-z0-9-]{1,30}$, reserved names incl. `control`) BEFORE it is
// interpolated into an identifier, and the tenant id must be a canonical
// lowercase uuid.
//
// The slug grammar is deliberately the kernel's, not the leaf tenant-store's
// (which is stricter: no leading or trailing hyphen). A kernel-valid slug such as
// `abc-` would otherwise make the executor throw and leave deleteTenant stuck in
// 'deleting', although the leaf could never have created a database for it.
// Accepting exactly the slugs deleteTenant accepts keeps the identifier
// injection-safe (the grammar has no quote) and turns such a slug into a
// harmless IF EXISTS no-op.
//
// KNOWN LIMIT: WITH (FORCE) terminates the leaf's pooled backends, but the
// running leaf keeps its per-tenant pool registered; a dropped tenant database
// under a live leaf pool answers an error until the leaf restarts. That is
// acceptable for a deleted (tombstoned) tenant, whose slug is never reused.
import postgres from 'postgres'
import type { LeafShredExecutor, CalendarLeafShredExecutor } from './lifecycle'
import { validateSlug } from '../slug'

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface LeafShredOptions<P extends string> {
  /** The leaf server's admin/maintenance url (NEWSLETTER_PG_URL / CALENDAR_PG_URL). */
  adminUrl: string
  /** The leaf's production prefix, or its `_test_` prefix for a scratch proof. */
  dbPrefix?: P
  log?: (line: string) => void
}

interface LeafDbShred {
  dropTenantDb(slug: string): Promise<void>
  deleteCatalogRow(tenantId: string): Promise<void>
}

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

function openSingle(url: string): postgres.Sql {
  return postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} })
}

/** The shared core: one leaf, one prefix from its allow-list. */
function makeLeafDbShred(
  leaf: string,
  allowedPrefixes: readonly string[],
  opts: LeafShredOptions<string>,
): LeafDbShred {
  const dbPrefix = opts.dbPrefix ?? allowedPrefixes[0]
  if (!allowedPrefixes.includes(dbPrefix)) {
    throw new Error(`[${leaf}-leaf-shred] dbPrefix must be one of ${JSON.stringify(allowedPrefixes)}, got ${JSON.stringify(dbPrefix)}`)
  }
  const log = opts.log ?? ((line: string) => console.error(`[tenant-create] ${line}`))
  const controlDb = dbPrefix + 'control'

  return {
    async dropTenantDb(slug: string): Promise<void> {
      const v = validateSlug(slug)
      if (!v.ok) {
        throw new Error(`[${leaf}-leaf-shred] invalid tenant slug ${JSON.stringify(slug)} (${v.reason}): refusing to build a database name from it`)
      }
      const dbName = dbPrefix + slug
      const admin = openSingle(opts.adminUrl)
      try {
        // DROP DATABASE cannot run in a transaction; the identifier is built from
        // the validated slug only. WITH (FORCE) terminates the leaf's pooled
        // backends (the running leaf holds them).
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
        log(`${leaf} leaf: dropped ${dbName} (IF EXISTS, WITH FORCE)`)
      } finally {
        await admin.end({ timeout: 5 }).catch(() => undefined)
      }
    },

    async deleteCatalogRow(tenantId: string): Promise<void> {
      if (!TENANT_ID_PATTERN.test(tenantId)) {
        throw new Error(`[${leaf}-leaf-shred] tenant id ${JSON.stringify(tenantId)} is not a canonical lowercase uuid`)
      }
      const admin = openSingle(opts.adminUrl)
      let controlExists: boolean
      try {
        controlExists = (await admin`SELECT 1 FROM pg_database WHERE datname = ${controlDb}`).length === 1
      } finally {
        await admin.end({ timeout: 5 }).catch(() => undefined)
      }
      if (!controlExists) {
        // No catalog database: the leaf never saw any tenant. Idempotent no-op.
        log(`${leaf} leaf: ${controlDb} does not exist, no catalog row to delete`)
        return
      }
      const ctrl = openSingle(dbUrlFor(opts.adminUrl, controlDb))
      try {
        const rows = await ctrl`DELETE FROM tenant_catalog WHERE tenant_id = ${tenantId}::uuid RETURNING tenant_id`
        log(`${leaf} leaf: deleted ${rows.length} ${controlDb}.tenant_catalog row(s) for ${tenantId}`)
      } finally {
        await ctrl.end({ timeout: 5 }).catch(() => undefined)
      }
    },
  }
}

/** A live LeafShredExecutor against the newsletter leaf PG (`newsletter_<slug>`). */
export function makeNewsletterLeafShredExecutor(
  opts: LeafShredOptions<'newsletter_' | 'newsletter_test_'>,
): LeafShredExecutor {
  const core = makeLeafDbShred('newsletter', ['newsletter_', 'newsletter_test_'], opts)
  return {
    dropNewsletterDb: (slug) => core.dropTenantDb(slug),
    deleteCatalogRow: (tenantId) => core.deleteCatalogRow(tenantId),
  }
}

/** A live CalendarLeafShredExecutor against the calendar leaf PG (`calendar_<slug>`). */
export function makeCalendarLeafShredExecutor(
  opts: LeafShredOptions<'calendar_' | 'calendar_test_'>,
): CalendarLeafShredExecutor {
  const core = makeLeafDbShred('calendar', ['calendar_', 'calendar_test_'], opts)
  return {
    dropCalendarDb: (slug) => core.dropTenantDb(slug),
    deleteCatalogRow: (tenantId) => core.deleteCatalogRow(tenantId),
  }
}
