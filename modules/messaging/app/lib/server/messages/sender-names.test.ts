import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  tenantId: 'tenant-a' as string | null,
  listUsers: vi.fn(),
  clientBuilds: 0,
  clientError: null as Error | null,
}))

vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => {
    if (m.tenantId === null) throw new Error('No tenant context')
    return m.tenantId
  },
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => {
    m.clientBuilds++
    if (m.clientError) throw m.clientError
    return { listUsers: m.listUsers }
  },
}))

import {
  __resetSenderNamesForTests,
  createSenderNameResolver,
  evictSenderNameResolver,
  getSenderNameResolver,
  tryGetSenderNameResolver,
  nameSyncResponse,
  withSenderNames,
} from './sender-names'

const ERIKA = '@erika_40example.org:matrix.example.org'
const MAX = '@max.mustermann_40example.org:matrix.example.org'

function msg(sender: string, id = sender) {
  return { eventId: id, sender, senderDisplayName: sender, type: 'm.text', body: 'hi', ts: 1 }
}

beforeEach(() => {
  m.tenantId = 'tenant-a'
  m.clientBuilds = 0
  m.clientError = null
  m.listUsers.mockReset().mockImplementation(async ({ username }: { username: string }) => {
    if (username === 'erika_40example.org') {
      return [{ id: 'u1', username, email: 'erika@example.org', firstName: 'Erika', lastName: 'Muster' }]
    }
    return []
  })
  __resetSenderNamesForTests()
})

describe('createSenderNameResolver', () => {
  it('resolves a member by the Keycloak username in the Matrix localpart', async () => {
    const r = createSenderNameResolver(async (username) => {
      expect(username).toBe('erika_40example.org')
      return { firstName: 'Erika', lastName: 'Muster' }
    })
    expect((await r.resolveMany([ERIKA])).get(ERIKA)).toBe('Erika Muster')
  })

  it('resolves once per sender, not once per message or per call', async () => {
    const lookup = vi.fn(async () => ({ firstName: 'Erika', lastName: 'Muster' }))
    const r = createSenderNameResolver(lookup)
    await r.resolveMany([ERIKA, ERIKA, ERIKA])
    await r.resolveMany([ERIKA])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight lookup between concurrent callers', async () => {
    let release: (v: { firstName: string; lastName: string }) => void = () => {}
    const lookup = vi.fn(() => new Promise<{ firstName: string; lastName: string }>((res) => { release = res }))
    const r = createSenderNameResolver(lookup)
    const a = r.resolveMany([ERIKA])
    const b = r.resolveMany([ERIKA])
    release({ firstName: 'Erika', lastName: 'Muster' })
    await Promise.all([a, b])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('falls back to a readable name when the member is unknown or the lookup fails', async () => {
    const r = createSenderNameResolver(async (u) => {
      if (u.startsWith('max')) throw new Error('keycloak down')
      return null
    })
    const names = await r.resolveMany([ERIKA, MAX])
    expect(names.get(ERIKA)).toBe('Erika')
    expect(names.get(MAX)).toBe('Max Mustermann')
  })

  it('never uses an address, not even one stored as the name', async () => {
    const r = createSenderNameResolver(async () => ({ firstName: 'erika@example.org', lastName: '' }))
    expect((await r.resolveMany([ERIKA])).get(ERIKA)).toBe('Erika')
  })

  it('retries a failed lookup sooner than a hit expires', async () => {
    let now = 0
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ firstName: 'Erika', lastName: 'Muster' })
    const r = createSenderNameResolver(lookup, { now: () => now, negativeTtlMs: 1_000, ttlMs: 60_000 })
    expect((await r.resolveMany([ERIKA])).get(ERIKA)).toBe('Erika')
    now = 2_000
    expect((await r.resolveMany([ERIKA])).get(ERIKA)).toBe('Erika Muster')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})

describe('getSenderNameResolver', () => {
  it('is one resolver per tenant', () => {
    const a1 = getSenderNameResolver()
    expect(getSenderNameResolver()).toBe(a1)
    m.tenantId = 'tenant-b'
    expect(getSenderNameResolver()).not.toBe(a1)
  })

  it('looks the member up in the tenant realm by exact username', async () => {
    const names = await getSenderNameResolver().resolveMany([ERIKA])
    expect(names.get(ERIKA)).toBe('Erika Muster')
    expect(m.listUsers).toHaveBeenCalledWith({ username: 'erika_40example.org', exact: true, max: 1 })
  })
})

describe('evictSenderNameResolver', () => {
  it('drops the tenant resolver, so the next request builds a fresh admin client', () => {
    const first = getSenderNameResolver()
    expect(m.clientBuilds).toBe(1)
    evictSenderNameResolver('tenant-a')
    const second = getSenderNameResolver()
    expect(second).not.toBe(first)
    expect(m.clientBuilds).toBe(2)
  })

  it('leaves the other tenants alone', () => {
    const a = getSenderNameResolver()
    m.tenantId = 'tenant-b'
    const b = getSenderNameResolver()
    evictSenderNameResolver('tenant-a')
    expect(getSenderNameResolver()).toBe(b)
    m.tenantId = 'tenant-a'
    expect(getSenderNameResolver()).not.toBe(a)
  })

  it('forgets the cached names of the evicted resolver', async () => {
    const r = getSenderNameResolver()
    await r.resolveMany([ERIKA])
    evictSenderNameResolver('tenant-a')
    await getSenderNameResolver().resolveMany([ERIKA])
    expect(m.listUsers).toHaveBeenCalledTimes(2)
  })

  it('is a no-op for an unknown tenant', () => {
    expect(() => evictSenderNameResolver('nobody')).not.toThrow()
  })
})

describe('failures are logged, not silent', () => {
  it('warns once per failed lookup without naming the member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.listUsers.mockRejectedValue(Object.assign(new Error('403 for erika_40example.org'), { name: 'KeycloakError' }))
    const names = await getSenderNameResolver().resolveMany([ERIKA])
    expect(names.get(ERIKA)).toBe('Erika')
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls[0])
    expect(logged).toContain('tenant-a')
    expect(logged).toContain('KeycloakError')
    expect(logged).not.toContain('erika')
    warn.mockRestore()
  })

  it('does not log an unknown member (that is not a failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await getSenderNameResolver().resolveMany([MAX])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns null silently without a tenant context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.tenantId = null
    expect(tryGetSenderNameResolver()).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns when the resolver cannot be built for a tenant that exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.clientError = new Error('secret unreadable')
    expect(tryGetSenderNameResolver()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls[0])).toContain('tenant-a')
    warn.mockRestore()
  })
})

describe('time budget', () => {
  it('answers with fallbacks when the identity service hangs, and still fills the cache', async () => {
    let release: (v: { firstName: string; lastName: string }) => void = () => {}
    const lookup = vi.fn(() => new Promise<{ firstName: string; lastName: string }>((res) => { release = res }))
    const r = createSenderNameResolver(lookup, { budgetMs: 20 })
    const names = await r.resolveMany([ERIKA])
    expect(names.get(ERIKA)).toBe('Erika')
    release({ firstName: 'Erika', lastName: 'Muster' })
    await new Promise((res) => setTimeout(res, 5))
    expect((await r.resolveMany([ERIKA])).get(ERIKA)).toBe('Erika Muster')
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe('withSenderNames', () => {
  it('sets the display name of every message and keeps the rest', async () => {
    const out = await withSenderNames([msg(ERIKA, '$1'), msg(ERIKA, '$2'), msg(MAX, '$3')])
    expect(out.map((x) => x.senderDisplayName)).toEqual(['Erika Muster', 'Erika Muster', 'Max Mustermann'])
    expect(out.map((x) => x.sender)).toEqual([ERIKA, ERIKA, MAX])
    expect(out[0]!.body).toBe('hi')
    // once per sender
    expect(m.listUsers).toHaveBeenCalledTimes(2)
  })

  it('never throws and still labels readably when there is no tenant', async () => {
    m.tenantId = null
    const out = await withSenderNames([msg(MAX)])
    expect(out[0]!.senderDisplayName).toBe('Max Mustermann')
  })

  it('leaves a message without a sender alone', async () => {
    const odd = { eventId: '$e', body: 'x' }
    expect(await withSenderNames([odd])).toEqual([odd])
  })
})

describe('nameSyncResponse', () => {
  it('names the events of every room with one pass', async () => {
    const resp = {
      nextBatch: 'b',
      rooms: [
        { roomId: '!a', unreadCount: 0, events: [msg(ERIKA, '$1')] },
        { roomId: '!b', unreadCount: 2, events: [msg(ERIKA, '$2'), msg(MAX, '$3')] },
      ],
    }
    const out = await nameSyncResponse(resp)
    expect(out.rooms[0]!.events[0]!.senderDisplayName).toBe('Erika Muster')
    expect(out.rooms[1]!.events.map((e) => e.senderDisplayName)).toEqual(['Erika Muster', 'Max Mustermann'])
    expect(out.nextBatch).toBe('b')
    expect(out.rooms[1]!.unreadCount).toBe(2)
    expect(m.listUsers).toHaveBeenCalledTimes(2)
  })
})
