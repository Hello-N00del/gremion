/**
 * calendar leaf: the (tenant id, slug) binding of storeFor (audit #534).
 *
 * The slug names the customer's catalogue row and CalDAV collection; the customer database itself is the
 * lifecycle's t_<hex32>__calendar, from the id alone. A store that trusts the (id, slug) pair it is handed
 * would follow a changed slug and rewrite the catalog binding (the old blind upsert), or hand one slug's
 * collection to another tenant. storeFor must refuse any pair the catalog does not hold - on a warm tenant
 * and on a cold miss - before the customer database is opened or a catalog row is written.
 *
 * PG-free: `postgres` and the package store are the in-memory stand-ins of support/fake-lifecycle-store.ts,
 * whose catalog keeps the real table's constraints (tenant_id PRIMARY KEY, slug UNIQUE). The real-Postgres
 * twin is tenant-store.identity-binding.integration.test.ts.
 *
 * Also the call-site guard: storeFor is reached only from the process wiring (src/index.ts); the http layer
 * gets it injected, so the one mapping of the refusal to a 409 (see identity-mismatch-http.test.ts) cannot
 * be bypassed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('postgres', async () => ({ default: (await import('./support/fake-lifecycle-store.ts')).fakePostgres }))
vi.mock('@gremion/tenant-store', async (importOriginal) =>
  (await import('./support/fake-lifecycle-store.ts')).fakeTenantStorePackage(await importOriginal<object>()),
)
import { fake as h, resetFake } from './support/fake-lifecycle-store.ts'

// Imported AFTER vi.mock so the stand-in driver is in place.
const { storeFor, InvalidTenantIdError, InvalidTenantSlugError, _resetTenantStoreForTests } = await import('../src/tenant-store.ts')
const { tenantModuleDbName } = await import('@gremion/tenant-store')

const PREFIX = 'calendar_test_'
const CONTROL_DB = PREFIX + 'control'
const OPTS = {
  // Never port 5432 - that is the LIVE Postgres on the staging host. The driver
  // is mocked anyway, so nothing is dialled.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: PREFIX,
  moduleUrl: 'postgres://m_calendar_app:p@127.0.0.1:59999/postgres',
} as const

const A = { id: '01920000-0000-7000-8000-0000000000a1', slug: 'bind-a' }
const B = { id: '01920000-0000-7000-8000-0000000000b1', slug: 'bind-b' }
const C = { id: '01920000-0000-7000-8000-0000000000c1', slug: 'bind-c' }

const MISMATCH = { code: 'TENANT_IDENTITY_MISMATCH', name: 'TenantIdentityMismatchError' }

/** A control database that already holds these tenants, each with its own database. */
function catalogued(...tenants: { id: string; slug: string }[]): void {
  h.databases.add(CONTROL_DB)
  for (const t of tenants) {
    h.catalog.push({ tenant_id: t.id, slug: t.slug, db_name: tenantModuleDbName(t.id, 'calendar') })
  }
}

/** The customer databases the package store was asked to open. */
const tenantPoolsOpened = (): [string, string][] => h.storeOpens

beforeEach(async () => {
  await _resetTenantStoreForTests()
  resetFake()
})

describe('storeFor refuses a pair the catalog does not bind (cold miss)', () => {
  it('a catalogued id under a CHANGED slug: no catalog write, no tenant pool', async () => {
    catalogued(A)
    await expect(storeFor({ id: A.id, slug: 'bind-a-renamed' }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(h.writes).toEqual([])
    expect(h.catalog).toEqual([{ tenant_id: A.id, slug: 'bind-a', db_name: tenantModuleDbName(A.id, 'calendar') }])
    expect(tenantPoolsOpened()).toEqual([])
  })

  it("another tenant's slug, for a catalogued id and for an unknown id: refused, nothing written", async () => {
    catalogued(A, B)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: C.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(h.writes).toEqual([])
    expect(h.catalog.map((r) => [r.tenant_id, r.slug])).toEqual([
      [A.id, A.slug],
      [B.id, B.slug],
    ])
    expect(tenantPoolsOpened()).toEqual([])
  })

  it('a catalogued pair is served and costs no catalog write', async () => {
    catalogued(A)
    const pool = await storeFor(A, OPTS)
    expect(pool).toBeDefined()
    expect(h.writes).toEqual([])
    expect(await storeFor(A, OPTS)).toBe(pool)
  })

  it('first contact claims the pair with an insert-if-absent, never an overwrite', async () => {
    h.databases.add(CONTROL_DB)
    const pool = await storeFor(A, OPTS)
    expect(pool).toBeDefined()
    expect(h.catalog).toEqual([{ tenant_id: A.id, slug: A.slug, db_name: tenantModuleDbName(A.id, 'calendar') }])
    const claims = h.writes.filter((w) => w.startsWith('INSERT INTO tenant_catalog'))
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatch(/ON CONFLICT DO NOTHING/)
    expect(claims[0]).not.toMatch(/DO UPDATE/)
  })

  it('the catalogue is claimed only after the customer database was opened: a tenant that is not provisioned leaves no row', async () => {
    h.databases.add(CONTROL_DB)
    h.verdict = { ok: false, reason: 'unavailable', retryAfterSeconds: 30 }
    h.probeError = { code: '3D000' }
    await expect(storeFor(A, OPTS)).rejects.toMatchObject({ code: 'TENANT_NOT_PROVISIONED' })
    expect(h.writes).toEqual([])
    expect(h.catalog).toEqual([])
  })

  it('a non-canonical tenant id is refused before the driver is touched', async () => {
    await expect(storeFor({ id: A.id.toUpperCase(), slug: A.slug }, OPTS)).rejects.toThrow(/canonical lowercase UUIDv7/)
    await expect(storeFor({ id: 'not-a-uuid', slug: A.slug }, OPTS)).rejects.toThrow(/canonical lowercase UUIDv7/)
    expect(h.opened).toEqual([])
  })

  it('a non-canonical tenant id is the typed InvalidTenantIdError (TENANT_ID_INVALID) and its message names no id', async () => {
    for (const id of [A.id.toUpperCase(), 'not-a-uuid', '', ` ${A.id}`, `${A.id}\n`, 'x'.repeat(200)]) {
      const err = await storeFor({ id, slug: A.slug }, OPTS).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(InvalidTenantIdError)
      expect(err).toMatchObject({ code: 'TENANT_ID_INVALID', name: 'InvalidTenantIdError' })
      expect((err as Error).message).not.toContain(id.trim() === '' ? 'never-present' : id.trim())
    }
    expect(h.opened).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('a slug off the grammar is the typed InvalidTenantSlugError (INVALID_TENANT_SLUG), before the driver is touched', async () => {
    for (const slug of ['Bad Slug', '-lead', 'trail-', '', 'a'.repeat(31), 'a_b']) {
      const err = await storeFor({ id: A.id, slug }, OPTS).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(InvalidTenantSlugError)
      expect(err).toMatchObject({ code: 'INVALID_TENANT_SLUG', name: 'InvalidTenantSlugError' })
    }
    expect(h.opened).toEqual([])
    expect(h.writes).toEqual([])
  })
})

describe('storeFor refuses a pair the catalog does not bind (warm pool)', () => {
  it('a pool bound to one slug is never handed out for another, and the true pair still gets it', async () => {
    catalogued(A, B)
    const poolA = await storeFor(A, OPTS)
    await storeFor(B, OPTS)
    const writes = [...h.writes]
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    await expect(storeFor({ id: A.id, slug: 'bind-a-renamed' }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(h.writes).toEqual(writes)
    expect(await storeFor(A, OPTS)).toBe(poolA)
  })

  it('a tenant bound in this process is refused under another slug without opening the customer database again', async () => {
    catalogued(A)
    await storeFor(A, OPTS)
    const opens = tenantPoolsOpened().length
    const driverOpens = h.opened.length
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(tenantPoolsOpened()).toHaveLength(opens)
    expect(h.opened).toHaveLength(driverOpens)
  })
})

describe('storeFor refuses a slug that is not bindable (B2b), before any database work', () => {
  const nothingTouched = (): void => {
    expect(h.opened).toEqual([])
    expect(h.storeOpens).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.databases.size).toBe(0)
    expect(h.catalog).toEqual([])
  }

  it('the reserved slug "control" is refused: <prefix>control is the catalog database', async () => {
    const err = await storeFor({ id: A.id, slug: 'control' }, OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidTenantSlugError)
    expect(err).toMatchObject({ code: 'INVALID_TENANT_SLUG', name: 'InvalidTenantSlugError' })
    expect((err as Error).message).toMatch(/reserved/)
    nothingTouched()
  })

  it('a slug that merely contains control is a tenant like any other', async () => {
    h.databases.add(CONTROL_DB)
    await expect(storeFor({ id: A.id, slug: 'control-room' }, OPTS)).resolves.toBeDefined()
    expect(h.catalog.map((r) => r.slug)).toEqual(['control-room'])
  })

  it('a slug named like a cluster database is only a label: no database of that name is looked at or made', async () => {
    h.databases.add(CONTROL_DB)
    for (const [i, slug] of ['postgres', 'template0', 'template1'].entries()) {
      await expect(storeFor({ id: `01920000-0000-7000-8000-00000000f0${i}0`, slug }, { ...OPTS, dbPrefix: PREFIX })).resolves.toBeDefined()
    }
    expect(h.databases.size).toBe(1)
    expect(h.opened.filter((u) => /\/(postgres|template0|template1)$/.test(u) && !u.endsWith('/postgres'))).toEqual([])
  })
})

// ── source guard: the binding cannot be removed or bypassed unnoticed ──────────
const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '..', 'src')

/** Blanks // and block comments (a // preceded by ':' or a quote, as in a url, is kept). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && e.name.endsWith('.ts')) yield p
  }
}

const sources = [...walk(SRC)].map((abs) => ({
  rel: path.relative(SRC, abs).split(path.sep).join('/'),
  code: stripComments(fs.readFileSync(abs, 'utf-8')),
}))

describe('storeFor call sites and the catalog statements (source guard)', () => {
  const store = sources.find((s) => s.rel === 'tenant-store.ts')

  it('scans a non-empty source tree', () => {
    expect(store, 'src/tenant-store.ts is missing').toBeDefined()
    expect(sources.length).toBeGreaterThanOrEqual(5)
  })

  it('tenant-store.ts never rewrites a catalog binding: no DO UPDATE, and the claim is insert-if-absent', () => {
    expect(store!.code).not.toMatch(/DO\s+UPDATE/i)
    expect(store!.code).toMatch(/INSERT INTO tenant_catalog[\s\S]*?ON CONFLICT DO NOTHING/)
  })

  it('storeFor checks the warm slug, and the cold path checks the binding, opens the customer database, then claims the catalog', () => {
    const body = store!.code.slice(store!.code.indexOf('export async function storeFor'))
    expect(body).toMatch(/bound\s*!==\s*tenant\.slug/)
    expect(body).toMatch(/throw new TenantIdentityMismatchError\(/)
    const cold = body.slice(body.indexOf('async function openFirstContact'))
    const check = cold.indexOf('assertCatalogBinding(')
    const open = cold.indexOf('openLifecycleDb(')
    const claim = cold.indexOf('claimCatalog(')
    expect(check).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(check)
    expect(claim).toBeGreaterThan(open)
  })

  it('tenant-store.ts creates no database but the catalogue one, and runs no migration', () => {
    const creates = [...store!.code.matchAll(/CREATE DATABASE[^\n]*/g)].map((m) => m[0])
    expect(creates).toEqual(['CREATE DATABASE "${dbName}"`)'])
    expect(store!.code).not.toMatch(/runMigrations|readdir|manifest\.json|ensureTenantDb/)
  })

  it('enumerates the storeFor call sites: only the process wiring (src/index.ts) calls it', () => {
    const callers = sources
      .filter((s) => s.rel !== 'tenant-store.ts' && /\bstoreFor\s*\(/.test(s.code))
      .map((s) => s.rel)
      .sort()
    expect(callers).toEqual(['index.ts'])
  })

  it('the http layer never imports or calls storeFor: it receives the function injected', () => {
    const offenders = sources
      .filter((s) => s.rel.startsWith('http/') && /\bstoreFor\b/.test(s.code))
      .map((s) => s.rel)
    expect(offenders).toEqual([])
  })
})
