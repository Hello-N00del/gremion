import { describe, it, expect, vi } from 'vitest'
import { resolveBoardOrgUnitScope } from './scope'

describe('board scope resolver', () => {
  it('auditor (it-admin) gets ALL org-unit ids', async () => {
    const all = vi.fn(async () => ['ou-1', 'ou-2', 'ou-3'])
    const mine = vi.fn(async () => ['ou-1'])
    const ids = await resolveBoardOrgUnitScope({ userId: 'u', roles: ['it-admin'] }, { allOrgUnitIds: all, myOrgUnitIds: mine })
    expect(ids).toEqual(['ou-1', 'ou-2', 'ou-3'])
    expect(mine).not.toHaveBeenCalled()
  })

  it('a normal member gets only their org-unit ids', async () => {
    const all = vi.fn(async () => ['ou-1', 'ou-2', 'ou-3'])
    const mine = vi.fn(async () => ['ou-1'])
    const ids = await resolveBoardOrgUnitScope({ userId: 'u', roles: ['member'] }, { allOrgUnitIds: all, myOrgUnitIds: mine })
    expect(ids).toEqual(['ou-1'])
  })
})
