import { describe, expect, it } from 'vitest'
import { mapHeliosToVoteItem, mapPollToVoteItem, mergeVoteItems } from './aggregator'
import type { HeliosElection } from '$lib/server/elections/helios-client'
import type { NcPoll } from '$lib/server/polls/polls-client'

function fakeElection(over: Partial<HeliosElection> = {}): HeliosElection {
  return {
    uuid: 'uuid-1',
    short_name: 'short',
    name: 'Election',
    description: 'desc',
    voting_starts_at: '2026-04-01T00:00:00Z',
    voting_ends_at: '2026-05-01T00:00:00Z',
    frozen_at: '2026-04-01T00:00:00Z',
    archived_at: null,
    num_cast_votes: 12,
    result: null,
    result_proof: null,
    ...over,
  }
}

function fakePoll(over: Partial<NcPoll> = {}): NcPoll {
  return {
    id: 7,
    type: 'textPoll',
    configuration: {
      title: 'Poll title',
      description: 'Poll desc',
      allowComment: false,
      anonymous: false,
      expire: 0,
      ...(over.configuration ?? {}),
    },
    status: { expired: false, countOptions: 3, ...(over.status ?? {}) },
    currentUserStatus: { userRole: '', isLocked: false, countVotes: 0, ...(over.currentUserStatus ?? {}) },
    ...over,
  }
}

describe('mapHeliosToVoteItem', () => {
  it('maps a frozen + future-end election to lifecycle "open"', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const item = mapHeliosToVoteItem(fakeElection({ voting_ends_at: future }))
    expect(item.kind).toBe('helios')
    expect(item.lifecycle).toBe('open')
    expect(item.id).toBe('helios:uuid-1')
    expect(item.castVotes).toBe(12)
  })

  it('maps an unfrozen election to lifecycle "planned"', () => {
    const item = mapHeliosToVoteItem(fakeElection({ frozen_at: null }))
    expect(item.lifecycle).toBe('planned')
  })

  it('maps a frozen + past-end election to lifecycle "closed"', () => {
    const item = mapHeliosToVoteItem(fakeElection({ voting_ends_at: '2020-01-01T00:00:00Z' }))
    expect(item.lifecycle).toBe('closed')
  })

  it('handles missing voting_starts_at / voting_ends_at without throwing', () => {
    const item = mapHeliosToVoteItem(fakeElection({ voting_starts_at: null, voting_ends_at: null }))
    expect(item.opens).toBe('')
    expect(item.closes).toBe('')
  })
})

describe('mapPollToVoteItem', () => {
  it('maps an active, non-expired poll to lifecycle "open"', () => {
    const item = mapPollToVoteItem(fakePoll())
    expect(item.kind).toBe('poll')
    expect(item.lifecycle).toBe('open')
    expect(item.id).toBe('poll:7')
  })

  it('maps an expired poll to lifecycle "closed"', () => {
    const item = mapPollToVoteItem(fakePoll({ status: { expired: true, countOptions: 3 } }))
    expect(item.lifecycle).toBe('closed')
  })

  it('treats expire=0 as no end date', () => {
    const item = mapPollToVoteItem(fakePoll())
    expect(item.closes).toBe('')
  })

  it('converts a non-zero expire to ISO string', () => {
    const expireSec = 1_900_000_000 // 2030-03-17
    const item = mapPollToVoteItem(fakePoll({
      configuration: {
        title: 't', description: '', allowComment: false, anonymous: false,
        expire: expireSec,
      },
    }))
    expect(item.closes).toBe(new Date(expireSec * 1000).toISOString())
  })
})

describe('mergeVoteItems', () => {
  function vi(over: Partial<import('./types').VoteItem>): import('./types').VoteItem {
    return {
      id: 'x', kind: 'helios', lifecycle: 'open', title: '', description: '',
      turnout: 0, quorum: 0, voterCount: 0, castVotes: 0, opens: '', closes: '',
      ...over,
    }
  }

  it('orders open before planned before closed', () => {
    const merged = mergeVoteItems(
      [vi({ id: 'a', lifecycle: 'closed' })],
      [vi({ id: 'b', lifecycle: 'open' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('within an lifecycle, sorts by closes-soonest first', () => {
    const merged = mergeVoteItems(
      [vi({ id: 'late',  lifecycle: 'open', closes: '2026-12-01T00:00:00Z' })],
      [vi({ id: 'soon',  lifecycle: 'open', closes: '2026-05-01T00:00:00Z' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['soon', 'late'])
  })

  it('items without closes go last within their lifecycle', () => {
    const merged = mergeVoteItems(
      [vi({ id: 'none', lifecycle: 'open', closes: '' })],
      [vi({ id: 'soon', lifecycle: 'open', closes: '2026-05-01T00:00:00Z' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['soon', 'none'])
  })

  it('merges both inputs without dropping items', () => {
    const merged = mergeVoteItems(
      [vi({ id: 'h1' }), vi({ id: 'h2' })],
      [vi({ id: 'p1' })],
    )
    expect(merged).toHaveLength(3)
  })
})
