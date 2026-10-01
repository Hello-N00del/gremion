// Ported from the source `routes/resolutions/resolutions-page.test.ts` (TASK-206-A 1b; the kernel segment is `beschluesse`).
// #438: the Beschlussbuch loader's admin-only privacy gate decides whether
// challenger identities, grounds and disposition data cross to the client. It
// had NO test of any kind — a regression that evaluated isAdmin true, or
// dropped the conditional entirely, would not have failed anything.
//
// The DB-layer test (protocols-db.beschluesse-challenges.integration.test.ts)
// exercises listBeschluesse/listChallengesForBeschluesse directly and never
// touches this load(), so it cannot cover the gate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  listBeschluesse: vi.fn(),
  listChallengesForBeschluesse: vi.fn(),
}))

vi.mock('$lib/server/governance/protocols-db', () => ({
  listBeschluesse: h.listBeschluesse,
  listChallengesForBeschluesse: h.listChallengesForBeschluesse,
}))

vi.mock('$lib/auth', async () => {
  const Role = { Guest: 'guest', Member: 'member', CouncilAdmin: 'council-admin' }
  return {
    Role,
    // Mirrors the real helper closely enough for a gate test: CouncilAdmin is
    // satisfied only by CouncilAdmin itself.
    hasRole: (roles: string[] | undefined, required: string) => (roles ?? []).includes(required),
  }
})

const { load } = await import('./+page.server')

// R29-F104-KTWIN (D-3): an all_members unit's resolution, which every
// signed-in viewer may see; the visibility rule itself is pinned in
// beschluesse-visibility.test.ts with the real role helper.
const BESCHLUESSE = [
  { id: 'b1', text: 'Beschluss A', committeeId: 'u-open', visibility: 'all_members', openChallengeCount: 1 },
]
const CHALLENGES = [
  { challengeId: 'c1', resolutionId: 'b1', raisedBy: 'member-7', grounds: 'Verstoß gegen §7' },
]

function evt(roles: string[] | null) {
  return {
    locals: {
      auth: async () => (roles === null ? null : { user: { id: 'u1', roles } }),
    },
  } as unknown as Parameters<typeof load>[0]
}

// The kernel's generated load type is a union with `void`; narrow once here.
type Loaded = { beschluesse: unknown[]; isAdmin: boolean; challenges: unknown[] }
const run = async (roles: string[] | null) => (await load(evt(roles))) as unknown as Loaded

beforeEach(() => {
  h.listBeschluesse.mockReset().mockResolvedValue(BESCHLUESSE)
  h.listChallengesForBeschluesse.mockReset().mockResolvedValue(CHALLENGES)
})

describe('#438 Beschlussbuch privacy gate', () => {
  it('CouncilAdmin receives the challenge disposition rows', async () => {
    const data = await run(['council-admin'])
    expect(data.isAdmin).toBe(true)
    expect(data.challenges).toEqual(CHALLENGES)
    expect(h.listChallengesForBeschluesse).toHaveBeenCalledOnce()
  })

  it.each([
    ['plain member', ['member']],
    ['guest', ['guest']],
    ['no roles', []],
  ])('%s gets NO challenge rows and the query is never run', async (_label, roles) => {
    const data = await run(roles)
    expect(data.isAdmin).toBe(false)
    expect(data.challenges).toEqual([])
    // Not merely filtered after the fact — never fetched at all, so challenger
    // identities cannot leak through the payload.
    expect(h.listChallengesForBeschluesse).not.toHaveBeenCalled()
  })

  it('an unauthenticated session is not admin and gets no challenge rows', async () => {
    const data = await run(null)
    expect(data.isAdmin).toBe(false)
    expect(data.challenges).toEqual([])
    expect(h.listChallengesForBeschluesse).not.toHaveBeenCalled()
  })

  it('the register itself is still returned to a non-admin', async () => {
    const data = await run(['member'])
    expect(data.beschluesse).toEqual(BESCHLUESSE)
  })

  it('#439: a failing challenge query degrades to empty for an admin, and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listChallengesForBeschluesse.mockRejectedValueOnce(new Error('db down'))
    const data = await run(['council-admin'])
    expect(data.challenges).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('#439: a failing register query degrades to empty, and is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listBeschluesse.mockRejectedValueOnce(new Error('db down'))
    const data = await run(['member'])
    expect(data.beschluesse).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// R28 house review MEDIUM (silent-failure): a server log alone left the page
// unable to tell "the query failed" from "there is nothing" — an admin was told
// "Keine Einsprüche zu diesem Beschluss." while challenges awaited disposition.
// The degraded load now carries a flag the page renders as an error line.
describe('#439 degraded loads are flagged to the page, not only logged', () => {
  type Flagged = Loaded & { challengesUnavailable: boolean; beschluesseUnavailable: boolean }
  const runFlagged = async (roles: string[] | null) => (await load(evt(roles))) as unknown as Flagged

  it('a failing challenge query sets challengesUnavailable for an admin', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listChallengesForBeschluesse.mockRejectedValueOnce(new Error('db down'))
    const data = await runFlagged(['council-admin'])
    expect(data.challenges).toEqual([])
    expect(data.challengesUnavailable).toBe(true)
    expect(data.beschluesseUnavailable).toBe(false)
    spy.mockRestore()
  })

  it('a failing register query sets beschluesseUnavailable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listBeschluesse.mockRejectedValueOnce(new Error('db down'))
    const data = await runFlagged(['member'])
    expect(data.beschluesse).toEqual([])
    expect(data.beschluesseUnavailable).toBe(true)
    spy.mockRestore()
  })

  it('healthy loads carry both flags false', async () => {
    const data = await runFlagged(['council-admin'])
    expect(data.challengesUnavailable).toBe(false)
    expect(data.beschluesseUnavailable).toBe(false)
  })

  it('a non-admin never gets challengesUnavailable (the query is never run)', async () => {
    const data = await runFlagged(['member'])
    expect(data.challengesUnavailable).toBe(false)
  })
})
