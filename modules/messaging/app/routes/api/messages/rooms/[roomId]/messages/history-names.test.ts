import { beforeEach, describe, expect, it, vi } from 'vitest'

// The history route returned the Matrix id as the sender's display name. It now names every sender
// from the tenant's identity data, once per sender, and never shows an address.

const m = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  getJoinedRooms: vi.fn(),
  getMessages: vi.fn(),
  listUsers: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: m.getMatrixToken,
      getJoinedRooms: m.getJoinedRooms,
      getMessages: m.getMessages,
    }),
  }),
}))
vi.mock('$lib/server/tenant/context', () => ({ currentTenantId: () => 'tenant-a' }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: () => ({ listUsers: m.listUsers }),
}))

const ROOM = '!room1:matrix.test'
const ERIKA = '@erika_40example.org:matrix.test'
const MAX = '@max.mustermann_40example.org:matrix.test'
const user = { id: 'u', email: 'u@example.org', name: 'u' }
const locals = { user, auth: async () => ({ user, accessToken: 'kc-jwt' }) }

let history: (e: unknown) => Promise<Response>
let sender: typeof import('$lib/server/messages/sender-names')

function msg(id: string, from: string) {
  return { eventId: id, sender: from, senderDisplayName: from, type: 'm.text', body: id, ts: 1 }
}

async function get() {
  const res = await history({
    locals,
    params: { roomId: ROOM },
    request: new Request('http://localhost/x'),
    url: new URL('http://localhost/api/messages/rooms/r/messages'),
  })
  return (await res.json()) as { data: { messages: Array<{ sender: string; senderDisplayName: string }> } }
}

beforeEach(async () => {
  process.env.AUTH_SECRET = 'test-secret'
  m.getMatrixToken.mockReset().mockResolvedValue('mx')
  m.getJoinedRooms.mockReset().mockResolvedValue([ROOM])
  m.getMessages.mockReset().mockResolvedValue({
    messages: [msg('$1', ERIKA), msg('$2', MAX), msg('$3', ERIKA)],
    end: 'e',
  })
  m.listUsers.mockReset().mockImplementation(async ({ username }: { username: string }) =>
    username === 'erika_40example.org'
      ? [{ id: 'k1', username, email: 'erika@example.org', firstName: 'Erika', lastName: 'Muster' }]
      : [],
  )
  sender = await import('$lib/server/messages/sender-names')
  sender.__resetSenderNamesForTests()
  history = (await import('./+server')).GET as typeof history
})

describe('GET /api/messages/rooms/[roomId]/messages', () => {
  it('returns the member display name, with a readable fallback for an unknown sender', async () => {
    const { data } = await get()
    expect(data.messages.map((x) => x.senderDisplayName)).toEqual(['Erika Muster', 'Max Mustermann', 'Erika Muster'])
    expect(data.messages.map((x) => x.sender)).toEqual([ERIKA, MAX, ERIKA])
  })

  it('looks each sender up once, not once per message', async () => {
    await get()
    expect(m.listUsers).toHaveBeenCalledTimes(2)
    await get()
    expect(m.listUsers).toHaveBeenCalledTimes(2)
  })

  it('shows no address and no Matrix id as a name', async () => {
    const { data } = await get()
    for (const x of data.messages) {
      expect(x.senderDisplayName).not.toMatch(/[@:]/)
    }
  })

  it('still returns the messages when the identity service is down', async () => {
    m.listUsers.mockReset().mockRejectedValue(new Error('down'))
    const { data } = await get()
    expect(data.messages.map((x) => x.senderDisplayName)).toEqual(['Erika', 'Max Mustermann', 'Erika'])
  })
})
