// FLOW-MSG-001 (TASK-009 lane B, rows-plan.md rows 10-13): T15-T17 for the
// admin-mutation routes (POST create, PATCH rename, POST archive, DELETE).
// room-admin's own create/rename/archive/delete logic is proven separately
// (room-admin.test.ts T6-T14, real DB in orchestrator-attach.integration.test);
// this suite is pure route-layer: auth/role gating, request validation, and
// the 404-vs-409 / cross-tenant-probe guard that rows-plan.md assigns to the
// route (not to room-admin.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  createRoom: vi.fn(),
  renameRoom: vi.fn(),
  archiveRoom: vi.fn(),
  deleteRoom: vi.fn(),
  getRoomArchiveMarker: vi.fn(),
}))

vi.mock('$lib/server/messages/admin/room-admin', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('$lib/server/messages/admin/room-admin')
  return {
    ...actual,
    createRoom: h.createRoom,
    renameRoom: h.renameRoom,
    archiveRoom: h.archiveRoom,
    deleteRoom: h.deleteRoom,
    getRoomArchiveMarker: h.getRoomArchiveMarker,
  }
})

const getResource = vi.fn()
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResource }))

vi.mock('$lib/server/messages/backend', () => ({
  getMessagesBackend: () => ({
    matrix: () => ({ getMatrixToken: vi.fn(), getJoinedRooms: vi.fn().mockResolvedValue([]) }),
    synapse: () => ({ listAllRoomIds: vi.fn().mockResolvedValue([]) }),
  }),
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
}))

const { RoomConflictError, RoomNotFoundError, MatrixUnavailableError } =
  (await vi.importActual('$lib/server/messages/admin/room-admin')) as {
    RoomConflictError: new (roomId: string) => Error
    RoomNotFoundError: new (message?: string) => Error
    MatrixUnavailableError: new (message: string) => Error
  }

const { POST: createPOST } = await import('./+server')
const { PATCH, DELETE } = await import('./[roomId]/+server')
const { POST: archivePOST } = await import('./[roomId]/archive/+server')

const COUNCIL_ADMIN = { id: 'ca-1', roles: [Role.CouncilAdmin], groups: [], email: 'ca@example.org', name: 'ca' }
const IT_ADMIN = { id: 'it-1', roles: [Role.ITAdmin], groups: [], email: 'it@example.org', name: 'it' }
const MEMBER = { id: 'm-1', roles: [Role.Member], groups: [], email: 'm@example.org', name: 'm' }

function req(body: unknown) {
  return new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function eventFor(opts: { user?: unknown; body?: unknown; roomId?: string; qs?: string }) {
  return {
    locals: { user: opts.user },
    params: { roomId: opts.roomId ?? '!r:matrix.test' },
    request: req(opts.body ?? {}),
    url: new URL(`http://localhost/x${opts.qs ?? ''}`),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('T15: POST /api/messages/rooms (create)', () => {
  it('401 unauthenticated', async () => {
    const res = await createPOST(eventFor({ user: undefined, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(401)
    expect(h.createRoom).not.toHaveBeenCalled()
  })

  it('403 Member', async () => {
    const res = await createPOST(eventFor({ user: MEMBER, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(403)
    expect(h.createRoom).not.toHaveBeenCalled()
  })

  it('201 CouncilAdmin', async () => {
    h.createRoom.mockResolvedValue({ roomId: '!new:matrix.test', report: { overall: 'ok' } })
    const res = await createPOST(eventFor({ user: COUNCIL_ADMIN, body: { orgUnitId: 'u1', name: 'Vorstand' } }))
    expect(res.status, await res.clone().text()).toBe(201)
    expect(h.createRoom).toHaveBeenCalledWith('u1', { name: 'Vorstand', userId: 'ca-1' })
  })

  it('201 ITAdmin (inherits CouncilAdmin)', async () => {
    h.createRoom.mockResolvedValue({ roomId: '!new:matrix.test', report: { overall: 'ok' } })
    const res = await createPOST(eventFor({ user: IT_ADMIN, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(201)
  })

  it('409 when room-admin throws RoomConflictError', async () => {
    h.createRoom.mockRejectedValue(new RoomConflictError('!existing:matrix.test'))
    const res = await createPOST(eventFor({ user: COUNCIL_ADMIN, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(409)
  })

  it('503 when room-admin throws MatrixUnavailableError', async () => {
    h.createRoom.mockRejectedValue(new MatrixUnavailableError('connect ECONNREFUSED'))
    const res = await createPOST(eventFor({ user: COUNCIL_ADMIN, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('MATRIX_UNAVAILABLE')
  })
})

describe('T15/T17: PATCH /api/messages/rooms/[roomId] (rename)', () => {
  it('401 unauthenticated', async () => {
    const res = await PATCH(eventFor({ user: undefined, body: { orgUnitId: 'u1', name: 'x' } }))
    expect(res.status).toBe(401)
  })

  it('403 Member', async () => {
    getResource.mockResolvedValue({ external_id: '!r:matrix.test' })
    const res = await PATCH(eventFor({ user: MEMBER, body: { orgUnitId: 'u1', name: 'x' } }))
    expect(res.status).toBe(403)
    expect(h.renameRoom).not.toHaveBeenCalled()
  })

  it('200 CouncilAdmin renaming its OWN active room', async () => {
    getResource.mockResolvedValue({ external_id: '!r:matrix.test' })
    const res = await PATCH(eventFor({
      user: COUNCIL_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1', name: 'Neu' },
    }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(h.renameRoom).toHaveBeenCalledWith('u1', { name: 'Neu', topic: undefined, userId: 'ca-1' })
  })

  it('200 ITAdmin (inherits)', async () => {
    getResource.mockResolvedValue({ external_id: '!r:matrix.test' })
    const res = await PATCH(eventFor({
      user: IT_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1', name: 'Neu' },
    }))
    expect(res.status).toBe(200)
  })

  it('T17: 404 when roomId does not match the unit\'s ledger room and no archive marker exists (cross-tenant-probe shape)', async () => {
    getResource.mockResolvedValue({ external_id: '!other:matrix.test' })
    h.getRoomArchiveMarker.mockResolvedValue(null)
    const res = await PATCH(eventFor({
      user: COUNCIL_ADMIN, roomId: '!foreign:matrix.test', body: { orgUnitId: 'u1', name: 'Neu' },
    }))
    expect(res.status).toBe(404)
    expect(h.renameRoom).not.toHaveBeenCalled()
  })

  it('409 when the roomId belongs to this unit but was archived (no active ledger row, marker matches)', async () => {
    getResource.mockResolvedValue(null)
    h.getRoomArchiveMarker.mockResolvedValue({ org_unit_id: 'u1', archived_at: '2026-09-01T00:00:00Z' })
    const res = await PATCH(eventFor({
      user: COUNCIL_ADMIN, roomId: '!archived:matrix.test', body: { orgUnitId: 'u1', name: 'Neu' },
    }))
    expect(res.status).toBe(409)
    expect(h.renameRoom).not.toHaveBeenCalled()
  })

  it('400 on an invalid body', async () => {
    const res = await PATCH(eventFor({ user: COUNCIL_ADMIN, body: { name: 'Neu' } })) // missing orgUnitId
    expect(res.status).toBe(400)
  })

  it('MEDIUM fix: a rejected getResource read maps through mapRoomError instead of an unhandled exception', async () => {
    getResource.mockRejectedValue(new Error('pool exhausted'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await PATCH(eventFor({
      user: COUNCIL_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1', name: 'Neu' },
    }))
    expect(res.status, await res.clone().text()).toBe(502)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(h.renameRoom).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ route: 'PATCH /api/messages/rooms/[roomId]', orgUnitId: 'u1', roomId: '!r:matrix.test' })
    )
    errSpy.mockRestore()
  })
})

describe('T15/T17: POST /api/messages/rooms/[roomId]/archive', () => {
  it('401 unauthenticated', async () => {
    const res = await archivePOST(eventFor({ user: undefined, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(401)
  })

  it('403 Member', async () => {
    const res = await archivePOST(eventFor({ user: MEMBER, body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(403)
  })

  it('200 CouncilAdmin archiving its OWN active room', async () => {
    getResource.mockResolvedValue({ external_id: '!r:matrix.test' })
    h.archiveRoom.mockResolvedValue('!r:matrix.test')
    const res = await archivePOST(eventFor({ user: COUNCIL_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1' } }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(h.archiveRoom).toHaveBeenCalledWith('u1', { userId: 'ca-1' })
  })

  it('200 ITAdmin (inherits)', async () => {
    getResource.mockResolvedValue({ external_id: '!r:matrix.test' })
    h.archiveRoom.mockResolvedValue('!r:matrix.test')
    const res = await archivePOST(eventFor({ user: IT_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(200)
  })

  it('T17: 404 on a roomId that is not this unit\'s current room', async () => {
    getResource.mockResolvedValue({ external_id: '!other:matrix.test' })
    const res = await archivePOST(eventFor({ user: COUNCIL_ADMIN, roomId: '!foreign:matrix.test', body: { orgUnitId: 'u1' } }))
    expect(res.status).toBe(404)
    expect(h.archiveRoom).not.toHaveBeenCalled()
  })

  it('MEDIUM fix: a rejected getResource read maps through mapRoomError instead of an unhandled exception', async () => {
    getResource.mockRejectedValue(new Error('pool exhausted'))
    const res = await archivePOST(eventFor({ user: COUNCIL_ADMIN, roomId: '!r:matrix.test', body: { orgUnitId: 'u1' } }))
    expect(res.status, await res.clone().text()).toBe(502)
    expect(h.archiveRoom).not.toHaveBeenCalled()
  })
})

describe('T16: DELETE /api/messages/rooms/[roomId]', () => {
  it('401 unauthenticated', async () => {
    const res = await DELETE(eventFor({ user: undefined, qs: '?orgUnitId=u1' }))
    expect(res.status).toBe(401)
  })

  it('403 CouncilAdmin (ITAdmin-only)', async () => {
    const res = await DELETE(eventFor({ user: COUNCIL_ADMIN, qs: '?orgUnitId=u1' }))
    expect(res.status).toBe(403)
    expect(h.deleteRoom).not.toHaveBeenCalled()
  })

  it('200 ITAdmin', async () => {
    h.deleteRoom.mockResolvedValue(undefined)
    const res = await DELETE(eventFor({ user: IT_ADMIN, roomId: '!r:matrix.test', qs: '?orgUnitId=u1' }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(h.deleteRoom).toHaveBeenCalledWith('u1', '!r:matrix.test', { userId: 'it-1' })
  })

  it('400 when orgUnitId is missing from the query', async () => {
    const res = await DELETE(eventFor({ user: IT_ADMIN }))
    expect(res.status).toBe(400)
    expect(h.deleteRoom).not.toHaveBeenCalled()
  })

  it('404 when room-admin throws RoomNotFoundError', async () => {
    h.deleteRoom.mockRejectedValue(new RoomNotFoundError('room not found'))
    const res = await DELETE(eventFor({ user: IT_ADMIN, qs: '?orgUnitId=u1' }))
    expect(res.status).toBe(404)
  })
})
