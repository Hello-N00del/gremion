// #196: the calendar page (guest-accessible) fetches GET /api/governance/committees
// to populate its committee filter chips. The endpoint previously required
// Role.Member, so guests (and the calendar's onMount fetch) hit a 403. The
// committees list is non-sensitive reference data (id + name), so it should be
// readable by any authenticated session — matching the sibling calendar
// endpoints (/api/calendar/event-types, /api/calendar/events) which gate on
// Role.Guest.
import { describe, it, expect, vi } from 'vitest'
import { Role } from '$lib/auth'

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: vi.fn().mockResolvedValue([{ id: 'ou-1', name: 'Vorstand' }]),
  createOrgUnit: vi.fn(),
  deleteOrgUnit: vi.fn(),
  getOrgUnit: vi.fn(), // P2.2 Task 10: the POST handler imports it for parent-kind resolution
}))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  provisionOrgUnit: vi.fn(),
  deprovisionOrgUnit: vi.fn(),
  wantedSubsystems: vi.fn().mockReturnValue([]),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({
  enqueueResources: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ({ begin: async (fn: any) => fn({} as any) }),
}))

const { GET } = await import('./+server')

function eventFor(user: unknown) {
  return { locals: { auth: async () => (user ? { user } : null) } } as never
}

describe('#196 GET /api/governance/committees access', () => {
  it('returns 200 for a Guest (calendar/guest-accessible reference data)', async () => {
    const res = await GET(
      eventFor({ id: 'g', roles: [Role.Guest], groups: [], email: 'g@example.org', name: 'g' }),
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('still returns 403 for an unauthenticated request', async () => {
    const res = await GET(eventFor(null))
    expect(res.status).toBe(403)
  })
})
