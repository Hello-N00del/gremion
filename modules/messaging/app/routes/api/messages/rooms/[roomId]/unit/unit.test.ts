// src/routes/api/messages/rooms/[roomId]/unit/unit.test.ts
//
// TASK-009 lane B (row 15): GET .../unit resolves an active/archived room's
// owning org unit for the /messages Einstellungen panel (room-admin.ts's
// findUnitIdForRoom). CouncilAdmin-gated — same role as PATCH/archive on the
// sibling routes (rows-plan.md S2.5).
import { describe, it, expect, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const findUnitIdForRoom = vi.fn()
vi.mock('$lib/server/messages/admin/room-admin', () => ({ findUnitIdForRoom }))

const { GET } = await import('./+server')

function event(user: { id: string; roles: Role[] } | undefined, roomId: string) {
  return { locals: { user }, params: { roomId } } as unknown as Parameters<typeof GET>[0]
}

describe('GET /api/messages/rooms/[roomId]/unit', () => {
  it('401s when unauthenticated', async () => {
    const res = await GET(event(undefined, '!r:matrix.test'))
    expect(res.status).toBe(401)
  })

  it('403s a plain Member', async () => {
    const res = await GET(event({ id: 'u1', roles: [Role.Member] }, '!r:matrix.test'))
    expect(res.status).toBe(403)
  })

  it('404s when no unit owns the room', async () => {
    findUnitIdForRoom.mockResolvedValueOnce(null)
    const res = await GET(event({ id: 'u2', roles: [Role.CouncilAdmin] }, '!unknown:matrix.test'))
    expect(res.status).toBe(404)
  })

  it('200s with the orgUnitId for a CouncilAdmin', async () => {
    findUnitIdForRoom.mockResolvedValueOnce('ou-1')
    const res = await GET(event({ id: 'u3', roles: [Role.CouncilAdmin] }, '!r:matrix.test'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { orgUnitId: 'ou-1' } })
    expect(findUnitIdForRoom).toHaveBeenCalledWith('!r:matrix.test')
  })
})
