import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  createDisplayNameResolver,
  displayNameOf,
  getDisplayNameResolver,
  evictDisplayNameResolver,
  __resetDisplayNameRegistryForTests,
  type UserLookup,
} from './display-names'
import { runWithTenant } from '$lib/server/tenant/context'

const USERS: Record<string, { id: string; username: string; firstName: string; lastName: string }> = {
  'uuid-1': { id: 'uuid-1', username: 'a.muster', firstName: 'Anna', lastName: 'Muster' },
  'uuid-2': { id: 'uuid-2', username: 'nodisplay', firstName: '', lastName: '' },
  'uuid-3': { id: 'uuid-3', username: '', firstName: '', lastName: '' },
}

function lookupFrom(impl: (id: string) => unknown): UserLookup {
  return { getUser: vi.fn(async (id: string) => impl(id) as never) }
}

describe('displayNameOf', () => {
  test('prefers full name', () => {
    expect(displayNameOf({ username: 'a.muster', firstName: 'Anna', lastName: 'Muster' })).toBe('Anna Muster')
  })
  test('falls back to username when no name', () => {
    expect(displayNameOf({ username: 'a.muster', firstName: '', lastName: '' })).toBe('a.muster')
  })
  test('empty when nothing usable', () => {
    expect(displayNameOf({ username: '', firstName: '', lastName: '' })).toBe('')
  })
})

describe('createDisplayNameResolver', () => {
  test('resolves a UUID to its full name', async () => {
    const r = createDisplayNameResolver(lookupFrom((id) => USERS[id]))
    expect(await r.resolve('uuid-1')).toBe('Anna Muster')
  })

  test('falls back to the username when first/last are empty', async () => {
    const r = createDisplayNameResolver(lookupFrom((id) => USERS[id]))
    expect(await r.resolve('uuid-2')).toBe('nodisplay')
  })

  test('falls back to the raw id when the user has no usable name at all', async () => {
    const r = createDisplayNameResolver(lookupFrom((id) => USERS[id]))
    expect(await r.resolve('uuid-3')).toBe('uuid-3')
  })

  test('falls back to the raw id (never throws) when lookup fails', async () => {
    const r = createDisplayNameResolver(lookupFrom(() => { throw new Error('404 not found') }))
    expect(await r.resolve('ghost')).toBe('ghost')
  })

  test('caches hits — second resolve does not call Keycloak again', async () => {
    const getUser = vi.fn(async (id: string) => USERS[id] as never)
    const r = createDisplayNameResolver({ getUser })
    await r.resolve('uuid-1')
    await r.resolve('uuid-1')
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  test('TTL expiry triggers a fresh lookup', async () => {
    let clock = 1000
    const getUser = vi.fn(async (id: string) => USERS[id] as never)
    const r = createDisplayNameResolver({ getUser }, { ttlMs: 100, now: () => clock })
    await r.resolve('uuid-1')
    clock += 200 // past TTL
    await r.resolve('uuid-1')
    expect(getUser).toHaveBeenCalledTimes(2)
  })

  test('resolveMany dedupes ids and returns a full map', async () => {
    const getUser = vi.fn(async (id: string) => USERS[id] as never)
    const r = createDisplayNameResolver({ getUser })
    const map = await r.resolveMany(['uuid-1', 'uuid-1', 'uuid-3', 'ghost'])
    expect(map.get('uuid-1')).toBe('Anna Muster')
    expect(map.get('uuid-3')).toBe('uuid-3')
    expect(map.get('ghost')).toBe('ghost')
    // 'uuid-1' fetched once despite appearing twice; 3 unique ids total.
    expect(getUser).toHaveBeenCalledTimes(3)
  })
})

const DIR_A: Record<string, { id: string; username: string; firstName: string; lastName: string }> = {
  'uuid-x': { id: 'uuid-x', username: 'a', firstName: 'Anna', lastName: 'Alpha' },
}
const DIR_B: Record<string, { id: string; username: string; firstName: string; lastName: string }> = {
  'uuid-x': { id: 'uuid-x', username: 'b', firstName: 'Bert', lastName: 'Beta' },
}

describe('getDisplayNameResolver tenant isolation', () => {
  beforeEach(() => __resetDisplayNameRegistryForTests())

  test('serves tenant A names to A and tenant B names to B for the same uuid', async () => {
    const lookupA: UserLookup = { getUser: vi.fn(async (id: string) => DIR_A[id] as never) }
    const lookupB: UserLookup = { getUser: vi.fn(async (id: string) => DIR_B[id] as never) }
    const lookupFor = (t: string): UserLookup => (t === 'a' ? lookupA : lookupB)
    const nameA = await runWithTenant(fakeTenantCtx('a'), () => getDisplayNameResolver(lookupFor).resolve('uuid-x'))
    const nameB = await runWithTenant(fakeTenantCtx('b'), () => getDisplayNameResolver(lookupFor).resolve('uuid-x'))
    expect(nameA).toBe('Anna Alpha')
    expect(nameB).toBe('Bert Beta')
  })

  test('throws fail-closed when no tenant is in ALS', () => {
    expect(() => getDisplayNameResolver(() => ({ getUser: vi.fn() }))).toThrow()
  })

  test('T8: evictDisplayNameResolver(tenantId) drops ONLY that tenant resolver (cache drained)', async () => {
    const calls = new Map<string, number>()
    const lookupFor = (t: string): UserLookup => ({
      getUser: vi.fn(async (id: string) => {
        calls.set(t, (calls.get(t) ?? 0) + 1)
        return { id, username: t, firstName: t.toUpperCase(), lastName: 'X' } as never
      }),
    })
    await runWithTenant(fakeTenantCtx('a'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    await runWithTenant(fakeTenantCtx('b'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    evictDisplayNameResolver('a')
    await runWithTenant(fakeTenantCtx('a'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    await runWithTenant(fakeTenantCtx('b'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    expect(calls.get('a')).toBe(2) // evicted → resolver + name cache rebuilt
    expect(calls.get('b')).toBe(1) // untouched tenant keeps its cached name
  })

  test('evicting a tenant drains its internal cache (no stale names on re-add)', async () => {
    const calls = new Map<string, number>()
    const lookupFor = (t: string): UserLookup => ({
      getUser: vi.fn(async (id: string) => {
        calls.set(t, (calls.get(t) ?? 0) + 1)
        return { id, username: t, firstName: t.toUpperCase(), lastName: 'X' } as never
      }),
    })
    await runWithTenant(fakeTenantCtx('a'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    for (let i = 0; i < 40; i++) {
      await runWithTenant(fakeTenantCtx(`pad-${i}`), () => getDisplayNameResolver(lookupFor).resolve('u'))
    }
    await runWithTenant(fakeTenantCtx('a'), () => getDisplayNameResolver(lookupFor).resolve('u'))
    expect(calls.get('a')).toBe(2)
  })
})

// Minimal TenantContext for ALS — only .id is read by getDisplayNameResolver.
function fakeTenantCtx(id: string) {
  return { id } as unknown as import('$lib/server/tenant/context').TenantContext
}
