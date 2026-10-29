// The catalogue is written after migrate and at boot (brief s.5.2), not only by an operator's hand.
import { describe, expect, it, vi } from 'vitest'
import { bootSync, syncAfterMigrate } from '../../src/authz/after-migrate.ts'
import type { AuthzCliDeps } from '../../src/authz/cli.ts'

const A = '01970000-0000-7000-8000-00000000000a'
const B = '01970000-0000-7000-8000-00000000000b'
const lines = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}
function deps() {
  const synced: string[] = []
  const d: AuthzCliDeps = {
    listCustomerIds: async () => [A, B],
    lookup: async (id) => ({ customerId: id, slug: 's', status: 'active', realm: 'r', issuer: 'i', kcInternal: 'k', dbConnRef: 'x' }),
    db: async () => {
      throw new Error('stub')
    },
    moduleIds: async () => new Map(),
    enabledModules: async () => new Set(),
  }
  // the sync itself is the .int suites' business; here only WHICH customers it visits
  d.db = async (t) => {
    synced.push(t.customerId)
    throw new Error('stop after recording')
  }
  return { d, synced }
}

describe('syncAfterMigrate', () => {
  it('a successful migrate of one customer syncs exactly that customer', async () => {
    const t = lines()
    const { d, synced } = deps()
    await syncAfterMigrate(['migrate', '--customer', B], 0, t.io, () => d)
    expect(synced).toEqual([B])
  })
  it('a successful migrate of everyone syncs every active customer', async () => {
    const { d, synced } = deps()
    await syncAfterMigrate(['migrate'], 0, lines().io, () => d)
    expect(synced).toEqual([A, B])
  })
  it('a failed migrate syncs nothing and keeps its exit code', async () => {
    const { d, synced } = deps()
    expect(await syncAfterMigrate(['migrate'], 1, lines().io, () => d)).toBe(1)
    expect(synced).toEqual([])
  })
  it('a sync that fails makes the one-shot fail (exit 1), named', async () => {
    const t = lines()
    const { d } = deps()
    expect(await syncAfterMigrate(['migrate'], 0, t.io, () => d)).toBe(1)
    expect(t.err.some((l) => l.startsWith('AUTHZ-FAILED'))).toBe(true)
  })
  it('a customer list that cannot be read after a successful migrate is exit 1 with a named line, never a rejection', async () => {
    const t = lines()
    const { d } = deps()
    const code = await syncAfterMigrate(['migrate'], 0, t.io, () => ({ ...d, listCustomerIds: async () => { throw new Error('control db down') } }))
    expect(code).toBe(1)
    expect(t.err).toEqual(['AUTHZ-FAILED * sync: control db down'])
  })
  it('an environment that cannot wire the sync is a NAMED skip, not a failure of the migrate', async () => {
    const t = lines()
    expect(
      await syncAfterMigrate(['migrate'], 0, t.io, () => {
        throw new Error('KERNEL_API_PLATFORM_DB_URL not set')
      }),
    ).toBe(0)
    expect(t.err[0]).toMatch(/^AUTHZ-SYNC-SKIPPED/)
  })
})

describe('bootSync', () => {
  it('visits every active customer and never throws (a failure is a warning)', async () => {
    const { d, synced } = deps()
    const warn = vi.fn()
    await bootSync(d, warn)
    expect(synced).toEqual([A, B])
    expect(warn).toHaveBeenCalled()
    await expect(bootSync({ ...d, listCustomerIds: async () => { throw new Error('control down') } }, warn)).resolves.toBeUndefined()
  })
})
