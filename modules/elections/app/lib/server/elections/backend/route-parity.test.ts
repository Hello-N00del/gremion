// gremion-ui/src/lib/server/elections/backend/route-parity.test.ts
// TDD seam test (mirrors calendar/content/files backend/route-parity intent for
// the votes/elections/polls subsystem). With VOTES_BACKEND unset the factory
// returns the INPROCESS client, and its listVotes() composes the SAME three
// pieces the pre-extraction /votes route composed by hand — the Helios satellite
// read (HeliosClient.getElection, settled per-row so one 5xx never blanks the
// page), the Nextcloud Polls read (NextcloudPollsClient.listPolls), and the pure
// aggregator (mapHeliosToVoteItem / mapPollToVoteItem / mergeVoteItems) — and
// returns BYTE-IDENTICAL results to the direct-call path. createPoll() delegates
// verbatim to NextcloudPollsClient.createPoll.
//
// This is the RED test: it fails until port + inprocess-client + index + resolve
// exist. It pins the delegation contract so the flag-OFF default can never drift
// away from byte-identical monolith behavior. It also pins the fail-closed
// contract: an unknown VOTES_BACKEND value THROWS (no silent inprocess fallback).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The inprocess client wraps HeliosClient.getElection + NextcloudPollsClient
// (listPolls/createPoll) — mock those two modules so we can observe pass-through
// delegation. Keep the REAL error classes + deriveLifecycle on helios-client
// (`...actual`) because the real aggregator's mapHeliosToVoteItem depends on
// deriveLifecycle, and isHeliosUnavailable classifies the settled rejections.
const { heliosMethods, pollsMethods } = vi.hoisted(() => ({
  heliosMethods: { getElection: vi.fn() },
  pollsMethods: { listPolls: vi.fn(), createPoll: vi.fn() },
}))

vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return { ...actual, HeliosClient: heliosMethods }
})

vi.mock('$lib/server/polls/polls-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/polls/polls-client')>()
  return { ...actual, NextcloudPollsClient: pollsMethods }
})

// The REAL aggregator is what the pre-extraction route used; import it here to
// compute the expected byte-identical output (NOT re-implement the mapping).
import { mapHeliosToVoteItem, mapPollToVoteItem, mergeVoteItems } from '$lib/votes/aggregator'
import type { HeliosElection } from '$lib/server/elections/helios-client'
import type { NcPoll } from '$lib/server/polls/polls-client'

function election(uuid: string, over: Partial<HeliosElection> = {}): HeliosElection {
  return {
    uuid,
    short_name: uuid,
    name: `Election ${uuid}`,
    description: 'desc',
    voting_starts_at: '2026-01-01T00:00:00Z',
    voting_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    frozen_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    num_cast_votes: 3,
    result: null,
    result_proof: null,
    ...over,
  }
}

function poll(id: number): NcPoll {
  return {
    id,
    type: 'textPoll',
    configuration: { title: `Poll ${id}`, description: '', allowComment: false, anonymous: true, expire: 0 },
    status: { expired: false, countOptions: 2 },
    currentUserStatus: { userRole: 'owner', isLocked: false, countVotes: 0 },
  }
}

beforeEach(() => {
  delete process.env.VOTES_BACKEND
  heliosMethods.getElection.mockReset()
  pollsMethods.listPolls.mockReset()
  pollsMethods.createPoll.mockReset()
})

describe('votes backend seam — VOTES_BACKEND unset → inprocess delegation (byte-identical)', () => {
  it('getVotesBackend() returns the inprocess client', async () => {
    const { getVotesBackend } = await import('./index')
    expect(getVotesBackend().kind).toBe('inprocess')
  })

  it('resolveVotesBackendOr503() returns the inprocess client (not a Response)', async () => {
    const { resolveVotesBackendOr503 } = await import('./resolve')
    const resolved = resolveVotesBackendOr503()
    expect(resolved).not.toBeInstanceOf(Response)
    expect((resolved as { kind: string }).kind).toBe('inprocess')
  })

  it('listVotes composes Helios reads + Polls + aggregator IDENTICALLY to the direct-call path', async () => {
    const e1 = election('u1')
    const p1 = poll(11)
    heliosMethods.getElection.mockResolvedValue(e1)
    pollsMethods.listPolls.mockResolvedValue([p1])

    const { getVotesBackend } = await import('./index')
    const out = await getVotesBackend().listVotes(['u1'])

    // Byte-identical to the pre-extraction /votes composition.
    expect(out.votes).toEqual(mergeVoteItems([mapHeliosToVoteItem(e1)], [mapPollToVoteItem(p1)]))
    expect(out.degradedUuids).toEqual([])
    expect(out.pollError).toBeNull()
    expect(heliosMethods.getElection).toHaveBeenCalledWith('u1')
    expect(pollsMethods.listPolls).toHaveBeenCalledTimes(1)
  })

  it('settles each Helios election individually — an unreachable ballot degrades (not drops), page still renders', async () => {
    const ok = election('ok')
    heliosMethods.getElection.mockImplementation((uuid: string) =>
      uuid === 'ok' ? Promise.resolve(ok) : Promise.reject(new TypeError('fetch failed')),
    )
    pollsMethods.listPolls.mockResolvedValue([])

    const { getVotesBackend } = await import('./index')
    const out = await getVotesBackend().listVotes(['ok', 'bad'])

    expect(out.votes).toEqual(mergeVoteItems([mapHeliosToVoteItem(ok)], []))
    expect(out.degradedUuids).toEqual(['bad']) // row order preserved
  })

  it('a Nextcloud Polls failure surfaces as pollError (elections still render)', async () => {
    const e1 = election('u1')
    heliosMethods.getElection.mockResolvedValue(e1)
    pollsMethods.listPolls.mockRejectedValue(new Error('NC Polls down'))

    const { getVotesBackend } = await import('./index')
    const out = await getVotesBackend().listVotes(['u1'])

    expect(out.votes).toEqual(mergeVoteItems([mapHeliosToVoteItem(e1)], []))
    expect(out.pollError).toBe('NC Polls down')
  })

  it('createPoll delegates to NextcloudPollsClient.createPoll unchanged', async () => {
    pollsMethods.createPoll.mockResolvedValue(poll(1))
    const { getVotesBackend } = await import('./index')
    await getVotesBackend().createPoll({ title: 'T', type: 'textPoll', options: ['a', 'b'], anonymous: true })
    expect(pollsMethods.createPoll).toHaveBeenCalledWith({
      title: 'T',
      type: 'textPoll',
      options: ['a', 'b'],
      anonymous: true,
    })
  })

  it('getVotesBackend() THROWS on an unknown VOTES_BACKEND value (fail-closed, no silent inprocess fallback)', async () => {
    process.env.VOTES_BACKEND = 'totally-bogus'
    const { getVotesBackend } = await import('./index')
    expect(() => getVotesBackend()).toThrow(/VOTES_BACKEND/)
    delete process.env.VOTES_BACKEND
  })
})
