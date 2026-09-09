import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve db.ts's own source for the env-read guard. We use
// fileURLToPath(import.meta.url) (not `new URL(..., import.meta.url)` passed
// straight to readFileSync) because the jsdom unit-test env can expose
// import.meta.url as a non-file URL — the established repo idiom (see
// finance/repositories/*.imports.test.ts) round-trips through path.resolve.
const DB_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'db.ts')

const { requireTenantSpy, createDbSpy } = vi.hoisted(() => ({
  requireTenantSpy: vi.fn(),
  createDbSpy: vi.fn(() => ({ end: vi.fn(() => Promise.resolve()) })),
}))
vi.mock('$lib/server/tenant/context', () => ({ requireTenant: requireTenantSpy }))
vi.mock('@gremion/db', () => ({ createDb: createDbSpy }))

const ctx = (id: string) => ({ id, dbUrl: `postgres://${id}`, dbMax: 3, dbPrepare: true })

describe('getDb — per-tenant, fail-closed', () => {
  beforeEach(async () => {
    requireTenantSpy.mockReset(); createDbSpy.mockClear()
    const { _resetPoolRegistryForTests } = await import('./db/pool-registry')
    _resetPoolRegistryForTests()
  })
  it('THROWS when no tenant is in scope (empty ALS, fail-closed §1.7)', async () => {
    requireTenantSpy.mockImplementation(() => { throw new Error('no tenant in scope') })
    const { getDb } = await import('./db')
    expect(() => getDb()).toThrow(/no tenant in scope/)
  })
  it('returns the same pool across calls within the same tenant', async () => {
    requireTenantSpy.mockReturnValue(ctx('default'))
    const { getDb } = await import('./db')
    expect(getDb()).toBe(getDb())
    expect(createDbSpy).toHaveBeenCalledTimes(1)
  })
  it('returns distinct pools for distinct tenants', async () => {
    const { getDb } = await import('./db')
    requireTenantSpy.mockReturnValueOnce(ctx('default')); const a = getDb()
    requireTenantSpy.mockReturnValueOnce(ctx('t2')); const b = getDb()
    expect(a).not.toBe(b)
    expect(createDbSpy).toHaveBeenCalledTimes(2)
  })
  it('never reads env.DATABASE_URL directly (registry-only resolution)', async () => {
    const src = readFileSync(DB_FILE, 'utf-8')
    expect(src).not.toMatch(/env\.DATABASE_URL/)
  })
})
