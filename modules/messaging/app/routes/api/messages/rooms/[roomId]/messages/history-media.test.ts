import { beforeEach, describe, expect, it, vi } from 'vitest'

// The history route used to rewrite mxc:// to a media URL WITHOUT a signature, so every
// history link 400'd. It now signs with the same {mxc, roomId, exp} scheme the media route
// verifies. These tests drive a link emitted by history through the media GET.

const m = vi.hoisted(() => ({
  getMatrixToken: vi.fn(),
  getJoinedRooms: vi.fn(),
  getMessages: vi.fn(),
  downloadMedia: vi.fn(),
  resolveMatrixCreds: vi.fn(),
  isRoomMember: vi.fn(),
}))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({
      getMatrixToken: m.getMatrixToken,
      getJoinedRooms: m.getJoinedRooms,
      getMessages: m.getMessages,
      downloadMedia: m.downloadMedia,
    }),
    resolveMatrixCreds: m.resolveMatrixCreds,
    synapse: () => ({ isRoomMember: m.isRoomMember }),
  }),
}))

const ROOM = '!room1:matrix.test'
const user = { id: 'u', email: 'u@example.org', name: 'u' }
const locals = { user, auth: async () => ({ user, accessToken: 'kc-jwt' }) }

let history: (e: unknown) => Promise<Response>
let download: (e: unknown) => Promise<Response>

async function emittedUrl(): Promise<URL> {
  const res = await history({
    locals,
    params: { roomId: ROOM },
    request: new Request('http://localhost/x'),
    url: new URL('http://localhost/api/messages/rooms/r/messages'),
  })
  const body = (await res.json()) as { data: { messages: { url?: string }[] } }
  return new URL(body.data.messages[0]!.url!, 'http://localhost')
}

function dl(url: URL, roomId = ROOM) {
  return download({ locals, params: { roomId }, request: new Request(url), url })
}

async function status(p: Promise<Response>): Promise<number> {
  try {
    return (await p).status
  } catch (err) {
    return (err as { status: number }).status
  }
}

beforeEach(async () => {
  process.env.AUTH_SECRET = 'test-secret'
  m.getMatrixToken.mockReset().mockResolvedValue('mx')
  m.getJoinedRooms.mockReset().mockResolvedValue([ROOM])
  m.getMessages.mockReset().mockResolvedValue({
    messages: [{ id: '$e', url: 'mxc://matrix.test/abc123', body: 'pic.png' }],
    end: 'e',
  })
  m.downloadMedia.mockReset().mockResolvedValue({ data: new ArrayBuffer(3), contentType: 'image/png' })
  m.resolveMatrixCreds.mockReset().mockResolvedValue({ userId: '@u:matrix.test', accessToken: 'mx' })
  m.isRoomMember.mockReset().mockResolvedValue(true)
  history = (await import('./+server')).GET as typeof history
  download = (await import('../media/+server')).GET as typeof download
})

describe('history-emitted media links', () => {
  it('carry exp and sig and download for a room member', async () => {
    const url = await emittedUrl()
    expect(url.searchParams.get('sig')).toBeTruthy()
    expect(url.searchParams.get('exp')).toBeTruthy()
    expect(url.searchParams.get('mxc')).toBe('mxc://matrix.test/abc123')
    expect(await status(dl(url))).toBe(200)
  })

  it('are refused for a non-member', async () => {
    const url = await emittedUrl()
    m.isRoomMember.mockResolvedValue(false)
    expect(await status(dl(url))).toBe(403)
    expect(m.downloadMedia).not.toHaveBeenCalled()
  })

  it('are refused when replayed against another room', async () => {
    const url = await emittedUrl()
    expect(await status(dl(url, '!other:matrix.test'))).toBe(403)
  })
})
