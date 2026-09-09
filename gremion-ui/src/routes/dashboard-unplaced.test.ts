import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

// Task 3.3 — unplaced-guest dashboard branch. The dashboard load consults
// getOrgUnitIdsForUser to decide whether a guest is "eingeladen, noch nicht
// zugeordnet". Mock the governance DB + calendar so the test never touches
// Postgres (the load also pulls calendar events for Task 3.6).
const getOrgUnitIdsForUser = vi.fn<(id: string) => Promise<readonly string[]>>()
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: (id: string) => getOrgUnitIdsForUser(id),
}))
vi.mock('$lib/server/calendar/calendar-db', () => ({
  listEvents: vi.fn(async () => []),
}))

import { load } from './+page.server'

type LoadResult = {
  unplaced?: boolean
  myApprovals: unknown[]
  myApprovalsCount: number
}

function eventStub(opts: {
  roles: Role[]
  groups?: string[]
}): Parameters<typeof load>[0] {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-tom', name: 'Tom Maier', email: 'tom@example.com', roles: opts.roles, groups: opts.groups ?? [] },
        expires: '2099-01-01T00:00:00.000Z',
      }),
      user: { id: 'u-tom', roles: opts.roles },
    },
    // No approver branch needs this for the guest case; return empty for others.
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    parent: async () => ({}),
  } as unknown as Parameters<typeof load>[0]
}

describe('dashboard load — unplaced-guest branch (Task 3.3)', () => {
  beforeEach(() => {
    getOrgUnitIdsForUser.mockReset()
    // Default: the membership lookup (also used by the Task 3.6 "mine" flag)
    // resolves to an empty list unless a test overrides it.
    getOrgUnitIdsForUser.mockResolvedValue([])
  })

  test('guest with zero memberships → unplaced empty state', async () => {
    getOrgUnitIdsForUser.mockResolvedValue([])
    const result = (await load(eventStub({ roles: [Role.Guest], groups: [] }))) as LoadResult
    expect(result.unplaced).toBe(true)
    expect(getOrgUnitIdsForUser).toHaveBeenCalledWith('u-tom')
  })

  test('guest WITH a membership → not unplaced (renders the normal dashboard)', async () => {
    getOrgUnitIdsForUser.mockResolvedValue(['ou-kulturreferat'])
    const result = (await load(eventStub({ roles: [Role.Guest], groups: [] }))) as LoadResult
    expect(result.unplaced).not.toBe(true)
  })

  test('member is never unplaced (the guest guard does not apply)', async () => {
    getOrgUnitIdsForUser.mockResolvedValue([])
    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult
    // Even with zero memberships a Member is never demoted to the guest empty
    // state — the unplaced branch is gated on lacking the Member role.
    expect(result.unplaced).not.toBe(true)
  })

  test('DB outage during the membership check does not strip a guest to unplaced', async () => {
    getOrgUnitIdsForUser.mockRejectedValue(new Error('db down'))
    const result = (await load(eventStub({ roles: [Role.Guest], groups: [] }))) as LoadResult
    expect(result.unplaced).not.toBe(true)
  })
})
