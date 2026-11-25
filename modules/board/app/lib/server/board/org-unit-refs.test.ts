// @vitest-environment node
// 'board:org-unit-refs': how many boards an org unit has, read where the boards really are.
// The kernel's committee delete asks it before it tears anything down.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ listBoardsForOrgUnits: vi.fn() }))
vi.mock('./backend', () => ({ getBoardBackend: () => ({ listBoardsForOrgUnits: h.listBoardsForOrgUnits }) }))

import { boardRefsOfOrgUnit } from './org-unit-refs'

describe('boardRefsOfOrgUnit', () => {
  beforeEach(() => { h.listBoardsForOrgUnits.mockReset() })

  it('counts every board of that unit, archived ones included, through the routed backend', async () => {
    h.listBoardsForOrgUnits.mockResolvedValue([{ id: 'b1', archived: false }, { id: 'b2', archived: true }])
    expect(await boardRefsOfOrgUnit('ou-1')).toEqual({ referenced: true, counts: { boards: 2 } })
    expect(h.listBoardsForOrgUnits).toHaveBeenCalledWith(['ou-1'])
  })

  it('says not referenced for a unit without boards', async () => {
    h.listBoardsForOrgUnits.mockResolvedValue([])
    expect(await boardRefsOfOrgUnit('ou-2')).toEqual({ referenced: false, counts: { boards: 0 } })
  })

  it('lets a failure through (a blocked board database), never answering zero for it', async () => {
    h.listBoardsForOrgUnits.mockRejectedValue(new Error('tenant_not_provisioned'))
    await expect(boardRefsOfOrgUnit('ou-3')).rejects.toHaveProperty('message', 'tenant_not_provisioned')
  })
})
