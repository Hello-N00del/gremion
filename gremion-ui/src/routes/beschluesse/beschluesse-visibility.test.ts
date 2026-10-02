// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#39, D-3): the Beschlussbuch at
// /beschluesse is Guest-reachable, but its loader read the UNFILTERED
// listBeschluesse(), so a Guest -- or a Member outside the unit -- got every
// passed resolution of every committee_only unit (text, vote counts, committee
// name, protocol title).
//
// Operator decision D-3 (R29-I16, binding): a Guest sees nothing of a
// committee_only unit; a Member sees all_members units plus their own units; a
// CouncilAdmin sees everything.
//
// The role helper ($lib/auth) is REAL here on purpose: beschluesse-page.test.ts
// mocks it, which hides exactly this kind of defect.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth/types'

const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }

const ROWS = [
  { id: 'r-closed', text: 'Geheimer Beschluss', committeeId: 'u-closed', committeeName: 'Closed', visibility: 'committee_only', openChallengeCount: 0 },
  { id: 'r-open', text: 'Offener Beschluss', committeeId: 'u-open', committeeName: 'Open', visibility: 'all_members', openChallengeCount: 0 },
]

const h = vi.hoisted(() => ({
  listBeschluesse: vi.fn(),
  listChallengesForBeschluesse: vi.fn(),
  getOrgUnitIdsForUser: vi.fn(),
}))

vi.mock('$lib/server/governance/protocols-db', () => ({
  listBeschluesse: h.listBeschluesse,
  listChallengesForBeschluesse: h.listChallengesForBeschluesse,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: h.getOrgUnitIdsForUser,
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
}))

const { load } = await import('./+page.server')

const GUEST = { id: 'guest', roles: [Role.Guest] }
const STRANGER = { id: 'stranger', roles: [Role.Member] }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

function evt(user: unknown) {
  return { locals: { auth: async () => (user ? { user } : null) } } as unknown as Parameters<typeof load>[0]
}

async function ids(user: unknown): Promise<string[]> {
  const data = (await load(evt(user))) as unknown as { beschluesse: Array<{ id: string }> }
  return data.beschluesse.map((b) => b.id).sort()
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  h.listBeschluesse.mockReset().mockResolvedValue(ROWS)
  h.listChallengesForBeschluesse.mockReset().mockResolvedValue([])
  h.getOrgUnitIdsForUser.mockReset().mockImplementation(async (userId: string) => MEMBERSHIPS[userId] ?? [])
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('/beschluesse load follows D-3', () => {
  it('a Guest gets no resolution of a committee_only unit', async () => {
    expect(await ids(GUEST)).toEqual(['r-open'])
  })

  it('a Member outside the committee_only unit gets none of its resolutions', async () => {
    expect(await ids(STRANGER)).toEqual(['r-open'])
  })

  it('a member of the committee_only unit and a CouncilAdmin see its resolutions', async () => {
    expect(await ids(UNIT_MEMBER)).toEqual(['r-closed', 'r-open'])
    expect(await ids(ADMIN)).toEqual(['r-closed', 'r-open'])
  })

  it('no session sees nothing', async () => {
    expect(await ids(null)).toEqual([])
  })

  it('a failed membership lookup fails CLOSED (only rows that need no membership) and is logged', async () => {
    h.getOrgUnitIdsForUser.mockRejectedValue(new Error('db down'))
    expect(await ids(UNIT_MEMBER)).toEqual(['r-open'])
    const record = errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')
    expect(record).toContain('[beschluesse] membership lookup failed')
    expect(record).toContain('db down')
  })
})
