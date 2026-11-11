import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  tenantId: 'tenant-a' as string | null,
  listUsers: vi.fn(),
}))

vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => {
    if (m.tenantId === null) throw new Error('No tenant context')
    return m.tenantId
  },
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({ listUsers: m.listUsers }),
}))

import {
  __resetSenderNamesForTests,
  createSenderNameResolver,
  getSenderNameResolver,
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
