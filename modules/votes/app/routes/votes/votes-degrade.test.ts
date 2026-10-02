import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import type { VoteListItem, DegradedVoteItem, NormalVoteItem } from './+page.server'

// ── Mocks ────────────────────────────────────────────────────────────────
// election-db: feed two tracked rows. helios-client: keep the REAL error
// classes + deriveLifecycle (the aggregator's mapHeliosToVoteItem depends on
// deriveLifecycle), but stub HeliosClient.getElection per-test. org-units-db:
// resolve a friendly committee name for the degraded card. polls-client:
// no polls (irrelevant to the degrade behaviour).

const getElection = vi.fn()
const findAll = vi.fn()
const findVisibleToUser = vi.fn()
const getOrgUnit = vi.fn()

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: {
    findAll: () => findAll(),
    findVisibleToUser: (id: string) => findVisibleToUser(id),
  },
}))

vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return {
    ...actual,
    HeliosClient: { getElection: (uuid: string) => getElection(uuid) },
  }
})

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: (id: string) => getOrgUnit(id),
}))

vi.mock('$lib/server/polls/polls-client', () => ({
  NextcloudPollsClient: { listPolls: async () => [] },
}))

const { load } = await import('./+page.server')
const { HeliosUnavailableError } = await import('$lib/server/elections/helios-client')

// A reachable Helios election shape (only the fields the mapper reads).
function reachableElection(uuid: string, name: string) {
  return {
    uuid,
    short_name: name,
    name,
    description: '',
    frozen_at: '2026-04-01T00:00:00Z',
    voting_starts_at: '2026-04-01T00:00:00Z',
    voting_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    archived_at: null,
    num_cast_votes: 7,
    result: null,
    result_proof: null,
  }
}

function row(uuid: string, orgUnitId: string) {
  return {
    id: `row-${uuid}`,
    helios_uuid: uuid,
    org_unit_id: orgUnitId,
    created_by: 'seed',
    calendar_linked: false,
    created_at: new Date('2026-05-22T19:50:00.000Z'),
    archived_at: null,
  }
}

const adminEvent = {
  locals: {
    auth: async () => ({
      user: { id: 'admin-1', name: 'Admin', email: 'a@x.de', roles: [Role.ITAdmin], groups: [] },
      expires: '2099-01-01T00:00:00.000Z',
    }),
  },
} as unknown as Parameters<typeof load>[0]

function isDegraded(v: VoteListItem): v is DegradedVoteItem {
  return v.degraded
}

describe('/votes loader — Helios graceful degrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findVisibleToUser.mockResolvedValue([])
    getOrgUnit.mockResolvedValue({ id: 'ou-1', name: 'Vorstand' })
  })

  test('a tracked row whose ballot 404s is degraded, not dropped', async () => {
    findAll.mockResolvedValue([row('hel-vorstand-26', 'ou-1')])
    getElection.mockRejectedValue(new HeliosUnavailableError('Helios → 404', 404))

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(1)
    const item = result.votes[0]
    expect(isDegraded(item)).toBe(true)
    const d = item as DegradedVoteItem
    expect(d.id).toBe('helios:hel-vorstand-26')
    expect(d.kind).toBe('helios')
    expect(d.heliosUuid).toBe('hel-vorstand-26')
    expect(d.committeeName).toBe('Vorstand')
    expect(d.stateLabel).toBe('Wahl angelegt · Ballot extern (Helios)')
    expect(d.createdAt).toBe('2026-05-22T19:50:00.000Z')
  })

  test('A1: two unreachable rows of the SAME committee stay two cards, distinguishable by heliosUuid', async () => {
    findAll.mockResolvedValue([
      row('hel-vorstand-26', 'ou-1'),
      row('hel-fs-inf-2025', 'ou-1'),
    ])
    getElection.mockRejectedValue(new HeliosUnavailableError('Helios → 404', 404))

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(2)
    const degraded = result.votes.filter(isDegraded)
    expect(degraded).toHaveLength(2)
    // Same committee name on both cards — the Helios id is the tell-apart.
    expect(degraded.map((d) => d.committeeName)).toEqual(['Vorstand', 'Vorstand'])
    expect(degraded.map((d) => d.heliosUuid)).toEqual(['hel-vorstand-26', 'hel-fs-inf-2025'])
  })

  test('D4 guard: two rows sharing ONE helios_uuid still collapse to a single degraded card', async () => {
    findAll.mockResolvedValue([
      row('hel-vorstand-26', 'ou-1'),
      { ...row('hel-vorstand-26', 'ou-1'), id: 'row-dupe' },
    ])
    getElection.mockRejectedValue(new HeliosUnavailableError('Helios → 404', 404))

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(1)
    expect((result.votes[0] as DegradedVoteItem).heliosUuid).toBe('hel-vorstand-26')
  })

  test('a network failure (TypeError "fetch failed") degrades rather than drops', async () => {
    findAll.mockResolvedValue([row('hel-fs-inf-2025', 'ou-2')])
    getElection.mockRejectedValue(new TypeError('fetch failed'))
    getOrgUnit.mockResolvedValue({ id: 'ou-2', name: 'Fachschaft Informatik' })

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(1)
    expect(isDegraded(result.votes[0])).toBe(true)
    expect((result.votes[0] as DegradedVoteItem).committeeName).toBe('Fachschaft Informatik')
  })

  test('a reachable election hydrates normally (degraded: false) and is not degraded', async () => {
    findAll.mockResolvedValue([row('hel-live', 'ou-1')])
    getElection.mockResolvedValue(reachableElection('hel-live', 'Vorstandswahl 2026'))

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(1)
    const item = result.votes[0]
    expect(item.degraded).toBe(false)
    const n = item as NormalVoteItem
    expect(n.title).toBe('Vorstandswahl 2026')
    expect(n.castVotes).toBe(7)
    expect(getOrgUnit).not.toHaveBeenCalled() // no name lookup for reachable rows
  })

  test('mixed: reachable rows sort first, degraded rows tail the list', async () => {
    findAll.mockResolvedValue([
      row('hel-down', 'ou-1'),
      row('hel-live', 'ou-1'),
    ])
    getElection.mockImplementation((uuid: string) =>
      uuid === 'hel-live'
        ? Promise.resolve(reachableElection('hel-live', 'Live Wahl'))
        : Promise.reject(new HeliosUnavailableError('Helios → 503', 503)),
    )

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(2)
    expect(result.votes[0].degraded).toBe(false)
    expect(result.votes[1].degraded).toBe(true)
  })

  test('committee name resolves to null when the org-unit lookup fails — still degraded', async () => {
    findAll.mockResolvedValue([row('hel-orphan', 'ou-missing')])
    getElection.mockRejectedValue(new HeliosUnavailableError('Helios → 404', 404))
    getOrgUnit.mockRejectedValue(new Error('DB down'))

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }
    expect(result.votes).toHaveLength(1)
    const d = result.votes[0] as DegradedVoteItem
    expect(d.degraded).toBe(true)
    expect(d.committeeName).toBeNull()
  })
})
