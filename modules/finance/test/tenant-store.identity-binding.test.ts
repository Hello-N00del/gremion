/**
 * finance leaf: the (tenant id, slug) binding of storeFor (audit #534).
 *
 * The per-tenant database name is derived from the slug alone. A store that
 * trusts the (id, slug) pair it is handed therefore follows a changed slug to a
 * NEW, empty database and rewrites the catalog binding (the old blind upsert), or
 * opens a database the id was never bound to. storeFor must refuse any pair the
 * catalog does not hold - on a warm pool and on a cold miss - before a database
 * is created or a catalog row is written.
 *
 * PG-free: the `postgres` driver is replaced by an in-memory stand-in whose
 * catalog keeps the real table's constraints (tenant_id PRIMARY KEY, slug UNIQUE).
 * The real-Postgres twin is tenant-store.identity-binding.integration.test.ts.
 *
 * Also the call-site guard: storeFor is reached only from the process wiring
 * (src/index.ts); the http layer gets it injected, so the one mapping of the
 * refusal to a 409 (see identity-mismatch-http.test.ts) cannot be bypassed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── in-memory stand-in for the driver (hoisted so the vi.mock factory sees it) ─
const h = vi.hoisted(() => ({
  catalog: [] as { tenant_id: string; slug: string; db_name: string }[],
  databases: new Set<string>(),
  /** CREATE DATABASE and every catalog write, in order. */
  writes: [] as string[],
  /** Every url handed to the driver factory, in order. */
  opened: [] as string[],
}))

vi.mock('postgres', () => {
  const uniqueViolation = (): Error & { code: string } =>
    Object.assign(new Error('duplicate key value violates unique constraint "tenant_catalog_slug_key"'), {
      code: '23505',
    })

  const run = (text: string, params: readonly unknown[]): unknown[] => {
    if (/SELECT count\(\*\) AS count FROM pg_database/i.test(text)) {
      return [{ count: h.databases.has(String(params[0])) ? '1' : '0' }]
    }
    const create = /^\s*CREATE DATABASE "([^"]+)"/i.exec(text)
    if (create) {
      h.databases.add(create[1]!)
      h.writes.push(`CREATE DATABASE ${create[1]}`)
      return []
    }
    if (/SELECT tenant_id::text AS tenant_id, slug FROM tenant_catalog WHERE tenant_id = \$1 OR slug = \$2/i.test(text)) {
      return h.catalog
        .filter((r) => r.tenant_id === params[0] || r.slug === params[1])
        .map(({ tenant_id, slug }) => ({ tenant_id, slug }))
    }
    if (/INSERT INTO tenant_catalog/i.test(text)) {
      h.writes.push(text.replace(/\s+/g, ' ').trim())
      const [id, slug, dbName] = params as [string, string, string]
      const sameId = h.catalog.find((r) => r.tenant_id === id)
      const sameSlug = h.catalog.find((r) => r.slug === slug)
      if (/ON CONFLICT DO NOTHING/i.test(text)) {
        if (!sameId && !sameSlug) h.catalog.push({ tenant_id: id, slug, db_name: dbName })
        return []
      }
      if (/ON CONFLICT \(tenant_id\) DO UPDATE/i.test(text)) {
        if (sameId) {
          if (sameSlug !== undefined && sameSlug !== sameId) throw uniqueViolation()
          sameId.slug = slug
          sameId.db_name = dbName
        } else {
          if (sameSlug !== undefined) throw uniqueViolation()
          h.catalog.push({ tenant_id: id, slug, db_name: dbName })
        }
        return []
      }
      throw new Error(`unmodelled INSERT: ${text}`)
    }
    return [] // CREATE TABLE, the leaf migrations, SELECT 1 ...
  }

  const factory = (url: string, _opts?: unknown) => {
    h.opened.push(url)
    const guarded = (text: string, params: readonly unknown[]): Promise<unknown[]> => {
      try {
        return Promise.resolve(run(text, params))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    const sql = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
      const text = typeof strings === 'string' ? strings : strings.join(' ? ')
      return guarded(text, vals)
    }) as unknown as Record<string, unknown> & ((...a: unknown[]) => Promise<unknown[]>)
    sql.unsafe = (text: string, params?: unknown[]) => guarded(text, params ?? [])
    sql.end = () => Promise.resolve()
    sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)
    return sql
  }
  return { default: factory }
})

// Imported AFTER vi.mock so the stand-in driver is in place.
const { storeFor, InvalidTenantIdError, InvalidTenantSlugError, _poolRegistryForTests, _resetTenantStoreForTests } =
  await import('../src/tenant-store.ts')

const PREFIX = 'finance_test_'
const CONTROL_DB = PREFIX + 'control'
const OPTS = {
  // Never port 5432 - that is the LIVE Postgres on the staging host. The driver
  // is mocked anyway, so nothing is dialled.
  pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
  dbPrefix: PREFIX,
} as const

const A = { id: 'a1000000-0000-4000-8000-0000000000a1', slug: 'bind-a' }
const B = { id: 'b1000000-0000-4000-8000-0000000000b1', slug: 'bind-b' }
const C = { id: 'c1000000-0000-4000-8000-0000000000c1', slug: 'bind-c' }

const MISMATCH = { code: 'TENANT_IDENTITY_MISMATCH', name: 'TenantIdentityMismatchError' }

/** A control database that already holds these tenants, each with its own database. */
function catalogued(...tenants: { id: string; slug: string }[]): void {
  h.databases.add(CONTROL_DB)
  for (const t of tenants) {
    h.databases.add(PREFIX + t.slug)
    h.catalog.push({ tenant_id: t.id, slug: t.slug, db_name: PREFIX + t.slug })
  }
}

const tenantPoolsOpened = (): string[] => h.opened.filter((u) => !u.endsWith('/postgres') && !u.endsWith('/' + CONTROL_DB))

beforeEach(async () => {
  await _resetTenantStoreForTests()
  h.catalog.length = 0
  h.databases.clear()
  h.writes.length = 0
  h.opened.length = 0
})

describe('storeFor refuses a pair the catalog does not bind (cold miss)', () => {
  it('a catalogued id under a CHANGED slug: no database created, no catalog write, no tenant pool', async () => {
    catalogued(A)
    await expect(storeFor({ id: A.id, slug: 'bind-a-renamed' }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(h.writes).toEqual([])
    expect(h.databases.has(PREFIX + 'bind-a-renamed')).toBe(false)
    expect(h.catalog).toEqual([{ tenant_id: A.id, slug: 'bind-a', db_name: PREFIX + 'bind-a' }])
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
    expect(h.catalog).toEqual([{ tenant_id: A.id, slug: A.slug, db_name: PREFIX + A.slug }])
    const claims = h.writes.filter((w) => w.startsWith('INSERT INTO tenant_catalog'))
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatch(/ON CONFLICT DO NOTHING/)
    expect(claims[0]).not.toMatch(/DO UPDATE/)
  })

  it('the claim precedes CREATE DATABASE, so a refused pair leaves no database behind', async () => {
    h.databases.add(CONTROL_DB)
    await storeFor(A, OPTS)
    const claim = h.writes.findIndex((w) => w.startsWith('INSERT INTO tenant_catalog'))
    const create = h.writes.indexOf(`CREATE DATABASE ${PREFIX}${A.slug}`)
    expect(claim).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThan(claim)
  })

  it('a non-canonical tenant id is refused before the driver is touched', async () => {
    await expect(storeFor({ id: A.id.toUpperCase(), slug: A.slug }, OPTS)).rejects.toThrow(/canonical lowercase uuid/)
    await expect(storeFor({ id: 'not-a-uuid', slug: A.slug }, OPTS)).rejects.toThrow(/canonical lowercase uuid/)
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

  it('the registry entry records the slug it was bound under', () => {
    const stub = Object.assign(() => Promise.resolve([]), { end: () => Promise.resolve() })
    _poolRegistryForTests.set(A.id, stub as never, A.slug)
    expect(_poolRegistryForTests.slug(A.id)).toBe(A.slug)
    expect(_poolRegistryForTests.slug(B.id)).toBeUndefined()
  })

  it('a stand-in pool is refused under another slug without opening anything', async () => {
    const stub = Object.assign(() => Promise.resolve([]), { end: () => Promise.resolve() })
    _poolRegistryForTests.set(A.id, stub as never, A.slug)
    await expect(storeFor({ id: A.id, slug: B.slug }, OPTS)).rejects.toMatchObject(MISMATCH)
    expect(await storeFor(A, OPTS)).toBe(stub)
    expect(h.opened).toEqual([])
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

  it('storeFor checks the warm entry slug and claims the catalog before it creates a database', () => {
    const body = store!.code.slice(store!.code.indexOf('export async function storeFor'))
    const claim = body.indexOf('claimCatalog(')
    const create = body.indexOf('ensureTenantDb(')
    expect(body).toMatch(/existing\.slug\s*!==\s*tenant\.slug/)
    expect(body).toMatch(/throw new TenantIdentityMismatchError\(/)
    expect(claim).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(claim)
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
