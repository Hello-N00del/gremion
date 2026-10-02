// src/routes/messages/manage/manage.test.ts
//
// TASK-009 lane B (row 14, FLOW-MSG-001 rows-plan.md S2.6): the admin room
// overview load. Gated CouncilAdmin — the hooks-level PAGE_ACCESS only sees
// the top-level 'messages' segment (Member), so this route re-checks the
// role itself (rows-plan.md S2.6) and never throws on a degraded
// Matrix/ledger read (PRD-DEP-004).
import { describe, it, expect, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const listOrgUnits = vi.fn()
const listOverview = vi.fn()

vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnits }))
vi.mock('$lib/server/messages/admin/room-admin', () => ({ listOverview }))

const { load } = await import('./+page.server')

function makeEvent(user: { id: string; roles: Role[] } | undefined) {
  return { locals: { user } } as unknown as Parameters<typeof load>[0]
}

describe('/messages/manage load (TASK-009 lane B row 14)', () => {
  it('401s when unauthenticated', async () => {
    await expect(load(makeEvent(undefined))).rejects.toMatchObject({ status: 401 })
  })

  it('403s a plain Member (only CouncilAdmin/ITAdmin reach the overview)', async () => {
    await expect(
      load(makeEvent({ id: 'u1', roles: [Role.Member] }))
    ).rejects.toMatchObject({ status: 403 })
  })

  it('returns the ledger+Matrix overview for a CouncilAdmin', async () => {
    listOrgUnits.mockResolvedValueOnce([
      { id: 'ou-1', name: 'Referat Finanzen' },
      { id: 'ou-2', name: 'AK Technik' },
    ])
    listOverview.mockResolvedValueOnce({
      matrix: 'reachable',
      units: [
        { unitId: 'ou-1', unitName: 'Referat Finanzen', state: 'aktiv', roomId: '!abc:local' },
        { unitId: 'ou-2', unitName: 'AK Technik', state: 'leer' },
      ],
    })

    const result = await load(makeEvent({ id: 'u2', roles: [Role.CouncilAdmin] }))

    expect(listOrgUnits).toHaveBeenCalledOnce()
    expect(listOverview).toHaveBeenCalledWith([
      { id: 'ou-1', name: 'Referat Finanzen' },
      { id: 'ou-2', name: 'AK Technik' },
    ])
    expect(result).toEqual({
      matrix: 'reachable',
      units: [
        { unitId: 'ou-1', unitName: 'Referat Finanzen', state: 'aktiv', roomId: '!abc:local' },
        { unitId: 'ou-2', unitName: 'AK Technik', state: 'leer' },
      ],
    })
  })

  it('ITAdmin (which inherits CouncilAdmin) also reaches the overview', async () => {
    listOrgUnits.mockResolvedValueOnce([])
    listOverview.mockResolvedValueOnce({ matrix: 'unreachable', units: [] })

    const result = await load(makeEvent({ id: 'u3', roles: [Role.ITAdmin] }))
    expect(result).toEqual({ matrix: 'unreachable', units: [] })
  })
})
