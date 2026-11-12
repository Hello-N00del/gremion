// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#39, operator decision D-3): the
// Beschlussregister of a unit answered any signed-in user, Guests included, for
// every unit (committee_only too). Now the register of a committee_only unit is
// visible only to its members and CouncilAdmins, and a Guest sees the published
// resolutions of an all_members unit. A hidden unit answers like a missing one.
//
// The role helper ($lib/auth) is REAL here on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS: Record<string, { id: string; visibility: 'all_members' | 'committee_only' }> = {
  'u-closed': { id: 'u-closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', visibility: 'all_members' },
}
const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }

const h = vi.hoisted(() => ({
  sqlCalls: 0,
  settingsCalls: 0,
  rows: [] as Array<Record<string, unknown>>,
  statements: [] as string[],
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: vi.fn(async (unitId: string, userId: string) => (MEMBERSHIPS[userId] ?? []).includes(unitId)),
}))
vi.mock('$lib/server/protocols/protocol-db', () => ({
  getBeschlussregisterSettings: vi.fn(async (committeeId: string) => {
    h.settingsCalls++
    return { committee_id: committeeId, include_protocols: true, include_polls: false, include_elections: true }
  }),
}))
vi.mock('$lib/server/db', () => ({
  getDb: () => ((strings: TemplateStringsArray) => {
    h.sqlCalls++
    h.statements.push(strings.join('?'))
    return Promise.resolve(h.rows)
  }),
}))

import { GET } from './+server'

const GUEST = { id: 'guest', roles: [Role.Guest], groups: [], email: 'g@example.org', name: 'g' }
const STRANGER = { id: 'stranger', roles: [Role.Member], groups: [], email: 's@example.org', name: 's' }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member], groups: [], email: 'm@example.org', name: 'm' }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'a' }

function ev(user: unknown, id: string) {
  return {
    params: { id },
    locals: { user },
    url: new URL(`http://localhost/api/committees/${id}/beschluesse`),
  } as never
}

async function statusOf(run: () => Promise<Response>): Promise<number> {
  try {
    return (await run()).status
  } catch (e) {
    return (e as { status?: number })?.status ?? -1
  }
}

// A published counted resolution with a recorded vote, as the register query returns it.
const COUNTED = {
  id: 'r1', type: 'beschluss', text: 'Beschluss', result: 'passed',
  votes_yes: 3, votes_no: 1, votes_abstain: 0, required_majority: 'simple', adoption_mode: 'tally',
}

beforeEach(() => {
  h.sqlCalls = 0
  h.settingsCalls = 0
  h.rows = [COUNTED]
  h.statements = []
})

describe('GET /api/committees/[id]/beschluesse -- visibility (D-3)', () => {
  it('a Guest and a non-member Member get a 404 for a committee_only unit, and nothing is read', async () => {
    for (const user of [GUEST, STRANGER]) {
      expect(await statusOf(() => GET(ev(user, 'u-closed')))).toBe(404)
    }
    expect(h.sqlCalls).toBe(0)
    expect(h.settingsCalls).toBe(0)
  })

  it('a Guest sees the published resolutions of an all_members unit', async () => {
    const res = await GET(ev(GUEST, 'u-open'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ type: string }> }
    expect(body.entries.map((e) => e.type)).toEqual(['beschluss'])
  })

  it('a member of the committee_only unit and a CouncilAdmin read its register', async () => {
    for (const user of [UNIT_MEMBER, ADMIN]) {
      expect(await statusOf(() => GET(ev(user, 'u-closed')))).toBe(200)
    }
  })

  it('an unknown unit is a 404, the same answer as a hidden one', async () => {
    expect(await statusOf(() => GET(ev(ADMIN, 'u-missing')))).toBe(404)
  })
})

// A protocol published before the vote gate existed may still hold a counted
// resolution nobody voted on, stored with the rule engine's placeholder
// "rejected". The register must not report that as a decision: the SERVER marks
// the row, with the same predicate the protocol page and the gates use.
describe('GET /api/committees/[id]/beschluesse -- a resolution nobody voted on', () => {
  type Entry = { id: string; result: string; untallied: boolean }
  const entriesFor = async () => ((await (await GET(ev(ADMIN, 'u-open'))).json()) as { entries: Entry[] }).entries

  it('reads the rule and the adoption mode the verdict depends on', async () => {
    await entriesFor()
    expect(h.statements[0]).toMatch(/r\.required_majority/)
    expect(h.statements[0]).toMatch(/r\.adoption_mode/)
  })

  it('marks a counted 0/0/0 resolution as untallied and a voted one as not', async () => {
    h.rows = [
      COUNTED,
      { ...COUNTED, id: 'r2', result: 'rejected', votes_yes: 0, votes_no: 0, votes_abstain: 0 },
      { ...COUNTED, id: 'r3', result: 'rejected', votes_yes: 0, votes_no: 2, votes_abstain: 0 },
    ]
    const entries = await entriesFor()
    expect(entries.map((e) => [e.id, e.untallied])).toEqual([['r1', false], ['r2', true], ['r3', false]])
  })

  it('does not mark a consent, an acclamation or a withdrawn resolution with an empty tally', async () => {
    const empty = { ...COUNTED, votes_yes: 0, votes_no: 0, votes_abstain: 0 }
    h.rows = [
      { ...empty, id: 'consent', required_majority: 'consent', result: 'passed' },
      { ...empty, id: 'acclamation', adoption_mode: 'acclamation', votes_yes: null, votes_no: null, votes_abstain: null },
      { ...empty, id: 'withdrawn', result: 'withdrawn' },
    ]
    expect((await entriesFor()).map((e) => e.untallied)).toEqual([false, false, false])
  })
})
