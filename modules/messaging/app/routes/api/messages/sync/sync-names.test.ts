import { beforeEach, describe, expect, it, vi } from 'vitest'

// The live sync stream carried the Matrix id as the sender's display name. Every snapshot it
// writes now has the names resolved (once per sender), so the page never has to show an id.

const m = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  sync: vi.fn(),
  listUsers: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({ getMatrixToken: m.getMatrixToken, sync: m.sync }),
  }),
}))
vi.mock('$lib/server/tenant/context', () => ({ currentTenantId: () => 'tenant-a' }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({ listUsers: m.listUsers }),
}))

const ERIKA = '@erika_40example.org:matrix.test'
const MAX = '@max.mustermann_40example.org:matrix.test'
const user = { id: 'u', email: 'u@example.org', name: 'u' }
const locals = { user, auth: async () => ({ user, accessToken: 'kc-jwt' }) }

function ev(id: string, from: string) {
  return { eventId: id, sender: from, senderDisplayName: from, type: 'm.text', body: id, ts: 1 }
}

beforeEach(async () => {
  m.getMatrixToken.mockReset().mockResolvedValue('mx')
  // one snapshot, then a failure so the stream ends and can be read to the end
  m.sync.mockReset()
    .mockResolvedValueOnce({
      nextBatch: 'b1',
      rooms: [
        { roomId: '!a:matrix.test', unreadCount: 1, events: [ev('$1', ERIKA), ev('$2', MAX)] },
        { roomId: '!b:matrix.test', unreadCount: 0, events: [ev('$3', ERIKA)] },
      ],
    })
    .mockRejectedValue(new Error('stop'))
  m.listUsers.mockReset().mockImplementation(async ({ username }: { username: string }) =>
    username === 'erika_40example.org'
      ? [{ id: 'k1', username, email: 'erika@example.org', firstName: 'Erika', lastName: 'Muster' }]
      : [],
  )
  ;(await import('$lib/server/messages/sender-names')).__resetSenderNamesForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/messages/sync', () => {
  it('writes snapshots whose senders carry display names', async () => {
    const { GET } = await import('./+server')
    const res = await GET({
      locals,
      request: new Request('http://localhost/api/messages/sync'),
      url: new URL('http://localhost/api/messages/sync'),
    } as never)
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    expect(line).toBeTruthy()
    const snap = JSON.parse(line!.slice('data: '.length)) as {
      nextBatch: string
      rooms: Array<{ roomId: string; unreadCount: number; events: Array<{ senderDisplayName: string; sender: string }> }>
    }
    expect(snap.nextBatch).toBe('b1')
    expect(snap.rooms[0]!.unreadCount).toBe(1)
    expect(snap.rooms[0]!.events.map((e) => e.senderDisplayName)).toEqual(['Erika Muster', 'Max Mustermann'])
    expect(snap.rooms[1]!.events[0]!.senderDisplayName).toBe('Erika Muster')
    expect(snap.rooms[0]!.events[0]!.sender).toBe(ERIKA)
    // one lookup per distinct sender across the whole snapshot
    expect(m.listUsers).toHaveBeenCalledTimes(2)
  })
})
