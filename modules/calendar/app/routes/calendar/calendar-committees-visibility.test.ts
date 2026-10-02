// F1-FIX-04 round 3 (grep item 3, operator decision D-3): the Guest-reachable
// /calendar page and the Member /files page listed every org unit by name,
// committee_only units included, as filter chips and file workspaces. Same rule
// as GET /api/governance/committees and the /committees tree: a committee_only
// unit is named only to its members and CouncilAdmins.
//
// The role helper is REAL.
import { describe, it, expect, vi } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS = [
  { id: 'u-open', parent_id: null, name: 'Finanzausschuss', visibility: 'all_members', wants_nextcloud_folder: true },
  { id: 'u-closed', parent_id: null, name: 'Geheimausschuss', visibility: 'committee_only', wants_nextcloud_folder: true },
]
const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }
const h = vi.hoisted(() => ({ memberLookupFails: false }))

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: vi.fn(async () => UNITS),
  getOrgUnitIdsForUser: vi.fn(async (id: string) => {
    if (h.memberLookupFails) throw new Error('db down')
    return MEMBERSHIPS[id] ?? []
  }),
  isMemberOf: vi.fn(),
}))
vi.mock('$lib/server/calendar/backend/resolve', () => ({
  resolveCalendarBackendForPage: () => ({ listEventTypes: async () => [] }),
}))

const { load: calendarLoad } = await import('./+page.server')
const { load: filesLoad } = await import('../files/+page.server')

const GUEST = { id: 'guest', roles: [Role.Guest] }
const STRANGER = { id: 'stranger', roles: [Role.Member] }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

async function chips(user: unknown): Promise<string[]> {
  const out = (await calendarLoad({ locals: { auth: async () => ({ user }) } } as never)) as {
    committees: Array<{ key: string; label: string }>
  }
  return out.committees.map((c) => c.key)
}
async function workspaces(user: unknown): Promise<string[]> {
  const out = (await filesLoad({
    locals: { auth: async () => ({ user }) },
    url: new URL('http://localhost/files?ou=u-closed'),
  } as never)) as { workspaces: Array<{ id: string }>; initialWorkspace: string }
  return [...out.workspaces.map((w) => w.id), `initial:${out.initialWorkspace}`]
}

describe('/calendar committee chips follow D-3', () => {
  it('a Guest and a non-member Member get no chip for a committee_only unit', async () => {
    expect(await chips(GUEST)).toEqual(['u-open'])
    expect(await chips(STRANGER)).toEqual(['u-open'])
  })

  it('a member of the unit and a CouncilAdmin get its chip', async () => {
    expect(await chips(UNIT_MEMBER)).toEqual(['u-open', 'u-closed'])
    expect(await chips(ADMIN)).toEqual(['u-open', 'u-closed'])
  })

  it('fails closed when the membership lookup fails', async () => {
    h.memberLookupFails = true
    try {
      expect(await chips(UNIT_MEMBER)).toEqual(['u-open'])
    } finally {
      h.memberLookupFails = false
    }
  })
})

describe('/files workspaces follow D-3', () => {
  it('a non-member Member gets no workspace, and no deep link, for a committee_only unit', async () => {
    expect(await workspaces(STRANGER)).toEqual(['u-open', 'initial:'])
  })

  it('a member of the unit and a CouncilAdmin get it', async () => {
    expect(await workspaces(UNIT_MEMBER)).toEqual(['u-open', 'u-closed', 'initial:Geheimausschuss'])
    expect(await workspaces(ADMIN)).toEqual(['u-open', 'u-closed', 'initial:Geheimausschuss'])
  })
})
