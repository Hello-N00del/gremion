// gremion-ui/src/lib/server/messages/backend/route-parity.test.ts
// TDD seam test (mirrors calendar/content/files backend/route-parity intent for
// the messages+video subsystem). With MESSAGES_BACKEND unset the factory returns
// the INPROCESS client and every messages+video op delegates to the existing
// kernel matrix / synapse / livekit / matrix-creds paths UNCHANGED (byte-identical
// to the pre-seam routes). It also pins the fail-closed factory contract
// (unset→inprocess, 'service'→leaf, 'bogus'→throws).
//
// This is the RED test: it fails until port + inprocess-client + service-client +
// index exist. It pins the delegation contract so the flag-OFF default can never
// drift away from byte-identical monolith behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The inprocess client wraps the kernel clients — mock all four so we can observe
// pass-through delegation of every messages+video op through the seam.
const { matrixClient, synapseClient, mintToken, roomNameFromMatrixId, dmRoomName, resolveMatrixCreds } =
  vi.hoisted(() => {
    const matrixClient = {
      getMatrixToken: vi.fn(),
      sync: vi.fn(),
      getJoinedRooms: vi.fn(),
      unreadMessageCountsByRoom: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      setReadMarker: vi.fn(),
      sendTyping: vi.fn(),
      uploadMedia: vi.fn(),
      downloadMedia: vi.fn(),
      createRoom: vi.fn(),
      inviteUser: vi.fn(),
      joinRoom: vi.fn(),
    }
    const synapseClient = { forceJoinRoom: vi.fn(), deleteDevice: vi.fn(), listAllRoomIds: vi.fn() }
    return {
      matrixClient,
      synapseClient,
      mintToken: vi.fn(),
      roomNameFromMatrixId: vi.fn(),
      dmRoomName: vi.fn(),
      resolveMatrixCreds: vi.fn(),
    }
  })

vi.mock('$lib/server/messages/matrix-client', () => ({
  getMatrixClient: vi.fn(() => matrixClient),
  evictMatrixClient: vi.fn(),
}))
vi.mock('$lib/server/messages/synapse-admin', () => ({
  getSynapseAdmin: vi.fn(() => synapseClient),
  evictSynapseAdmin: vi.fn(),
}))
vi.mock('$lib/server/messages/livekit-client', () => ({
  mintToken,
  roomNameFromMatrixId,
  dmRoomName,
  evictLivekitSettings: vi.fn(),
}))
vi.mock('$lib/server/messages/matrix-creds', () => ({
  resolveMatrixCreds,
  getKeycloakJwt: vi.fn(),
}))

beforeEach(() => {
  delete process.env.MESSAGES_BACKEND
  vi.clearAllMocks()
})

// ── Fail-closed factory contract ──────────────────────────────────────────────

describe('getMessagesBackend — MESSAGES_BACKEND fail-closed selection', () => {
  it('unset → inprocess', async () => {
    delete process.env.MESSAGES_BACKEND
    const { getMessagesBackend } = await import('./index')
    expect(getMessagesBackend().kind).toBe('inprocess')
  })

  it("'inprocess' → inprocess", async () => {
    process.env.MESSAGES_BACKEND = 'inprocess'
    const { getMessagesBackend } = await import('./index')
    expect(getMessagesBackend().kind).toBe('inprocess')
  })

  it("'service' → leaf (service)", async () => {
    process.env.MESSAGES_BACKEND = 'service'
    const { getMessagesBackend } = await import('./index')
    expect(getMessagesBackend().kind).toBe('service')
  })

  it("'bogus' → throws (fail-closed)", async () => {
    process.env.MESSAGES_BACKEND = 'bogus-value'
    const { getMessagesBackend } = await import('./index')
    expect(() => getMessagesBackend()).toThrow(/MESSAGES_BACKEND/)
  })

  it('resolveMessagesBackendOr503() returns the inprocess client (not a Response) when flag OFF', async () => {
    delete process.env.MESSAGES_BACKEND
    const { resolveMessagesBackendOr503 } = await import('./resolve')
    const resolved = resolveMessagesBackendOr503()
    expect(resolved).not.toBeInstanceOf(Response)
    expect((resolved as { kind: string }).kind).toBe('inprocess')
  })

  it('resolveMessagesBackendOr503() returns a 503 Response on a bogus flag', async () => {
    process.env.MESSAGES_BACKEND = 'bogus-value'
    const { resolveMessagesBackendOr503 } = await import('./resolve')
    const resolved = resolveMessagesBackendOr503()
    expect(resolved).toBeInstanceOf(Response)
    expect((resolved as Response).status).toBe(503)
  })
})

// ── Flag-OFF (inprocess) byte-identical delegation ────────────────────────────

describe('messages backend seam — MESSAGES_BACKEND unset → inprocess delegation', () => {
  it('matrix() returns the kernel getMatrixClient() unchanged (delegation)', async () => {
    const { getMessagesBackend } = await import('./index')
    expect(getMessagesBackend().matrix()).toBe(matrixClient)
  })

  it('synapse() returns the kernel getSynapseAdmin() unchanged (delegation)', async () => {
    const { getMessagesBackend } = await import('./index')
    expect(getMessagesBackend().synapse()).toBe(synapseClient)
  })

  it('livekit() exposes the kernel mintToken/roomNameFromMatrixId/dmRoomName bindings', async () => {
    const { getMessagesBackend } = await import('./index')
    const lk = getMessagesBackend().livekit()
    expect(lk.mintToken).toBe(mintToken)
    expect(lk.roomNameFromMatrixId).toBe(roomNameFromMatrixId)
    expect(lk.dmRoomName).toBe(dmRoomName)
  })

  it('resolveMatrixCreds() delegates to the kernel matrix-creds helper', async () => {
    resolveMatrixCreds.mockResolvedValue({ userId: '@u:s', accessToken: 'mx' })
    const { getMessagesBackend } = await import('./index')
    const event = {} as unknown as import('@sveltejs/kit').RequestEvent
    const out = await getMessagesBackend().resolveMatrixCreds(event)
    expect(resolveMatrixCreds).toHaveBeenCalledWith(event)
    expect(out).toEqual({ userId: '@u:s', accessToken: 'mx' })
  })

  // Every kernel messages+video client ACCESSOR the routes drive through the seam
  // resolves through getMessagesBackend() and lands on its delegated kernel method.
  // These rows are a SUPERSET of the leaf's 14 route-parity ops
  // (services/messages/src/operations.ts): several ops fan out to multiple
  // accessors — messages.rooms → getJoinedRooms + unreadMessageCountsByRoom,
  // video.meeting-room → createRoom + inviteUser + joinRoom (+ synapse.forceJoinRoom),
  // auth.matrix-device → synapse.deleteDevice — so the accessor count (16) exceeds
  // the op count (14). The remaining route-level ops (video.openid-token /
  // video.widget-action) are covered by their own route tests, not here.
  const OP_DELEGATION: ReadonlyArray<{ op: string; run: (b: import('./index').MessagesBackendPort) => unknown; spy: () => ReturnType<typeof vi.fn> }> = [
    { op: 'messages.sync', run: (b) => b.matrix().sync('t', 's'), spy: () => matrixClient.sync },
    { op: 'messages.rooms', run: (b) => b.matrix().getJoinedRooms('t'), spy: () => matrixClient.getJoinedRooms },
    { op: 'messages.rooms(unread)', run: (b) => b.matrix().unreadMessageCountsByRoom('t'), spy: () => matrixClient.unreadMessageCountsByRoom },
    { op: 'messages.rooms(forceJoin)', run: (b) => b.synapse().forceJoinRoom('!r', '@u'), spy: () => synapseClient.forceJoinRoom },
    { op: 'messages.list', run: (b) => b.matrix().getMessages('t', '!r'), spy: () => matrixClient.getMessages },
    { op: 'messages.send', run: (b) => b.matrix().sendMessage('t', '!r', { msgtype: 'm.text', body: 'hi' }), spy: () => matrixClient.sendMessage },
    { op: 'messages.read', run: (b) => b.matrix().setReadMarker('t', '!r', '$e'), spy: () => matrixClient.setReadMarker },
    { op: 'messages.typing', run: (b) => b.matrix().sendTyping('t', '!r', '@u', true), spy: () => matrixClient.sendTyping },
    { op: 'messages.media.upload', run: (b) => b.matrix().uploadMedia('t', new ArrayBuffer(1), 'image/png', 'f'), spy: () => matrixClient.uploadMedia },
    { op: 'messages.media.download', run: (b) => b.matrix().downloadMedia('mxc://s/x'), spy: () => matrixClient.downloadMedia },
    { op: 'auth.matrix-token', run: (b) => b.matrix().getMatrixToken('jwt'), spy: () => matrixClient.getMatrixToken },
    { op: 'video.meeting-room(create)', run: (b) => b.matrix().createRoom('n', 't'), spy: () => matrixClient.createRoom },
    { op: 'video.meeting-room(invite)', run: (b) => b.matrix().inviteUser('!r', '@u'), spy: () => matrixClient.inviteUser },
    { op: 'video.meeting-room(join)', run: (b) => b.matrix().joinRoom('t', '!r'), spy: () => matrixClient.joinRoom },
    { op: 'video.token(mint)', run: (b) => b.livekit().mintToken({ roomName: 'r', identity: 'i', displayName: 'd', canPublish: true }), spy: () => mintToken },
    { op: 'auth.matrix-device(deleteDevice)', run: (b) => b.synapse().deleteDevice('localpart', 'dev-1'), spy: () => synapseClient.deleteDevice },
    // #370: the admin all-rooms list folded into the port (auto-join source).
    { op: 'video.meeting-room(listRooms)', run: (b) => b.synapse().listAllRoomIds(), spy: () => synapseClient.listAllRoomIds },
  ]

  it('every op reaches its delegated kernel method through getMessagesBackend()', async () => {
    const { getMessagesBackend } = await import('./index')
    for (const { op, run, spy } of OP_DELEGATION) {
      const s = spy()
      s.mockClear()
      run(getMessagesBackend())
      expect(s, `op ${op} did not delegate to its kernel method`).toHaveBeenCalledTimes(1)
    }
  })
})
