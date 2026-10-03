import type { HeliosElection } from '$lib/server/elections/helios-client'
import { deriveLifecycle } from '$lib/server/elections/helios-client'
import type { NcPoll } from '$lib/server/polls/polls-client'
import type { VoteItem } from './types'

export function mapHeliosToVoteItem(e: HeliosElection): VoteItem {
  const helLc = deriveLifecycle(e)
  return {
    id: `helios:${e.uuid}`,
    kind: 'helios',
    lifecycle: helLc === 'draft' ? 'planned' : helLc,
    title: e.name,
    description: e.description,
    // Helios's public election shape doesn't surface num_voters or quorum;
    // surface 0 here so the UI doesn't render "NaN%" turnout.
    turnout: 0,
    quorum: 0,
    voterCount: 0,
    castVotes: e.num_cast_votes,
    opens: e.voting_starts_at ?? '',
    closes: e.voting_ends_at ?? '',
  }
}

export function mapPollToVoteItem(p: NcPoll): VoteItem {
  const expireMs = p.configuration.expire * 1000
  return {
    id: `poll:${p.id}`,
    kind: 'poll',
    lifecycle: p.status.expired ? 'closed' : 'open',
    title: p.configuration.title,
    description: p.configuration.description,
    turnout: 0,
    quorum: 0,
    voterCount: 0,
    castVotes: 0,
    opens: '',
    closes: p.configuration.expire ? new Date(expireMs).toISOString() : '',
  }
}

const LIFECYCLE_ORDER: Record<VoteItem['lifecycle'], number> = {
  open: 0,
  planned: 1,
  closed: 2,
}

export function mergeVoteItems(elections: VoteItem[], polls: VoteItem[]): VoteItem[] {
  return [...elections, ...polls].sort((a, b) => {
    const lc = LIFECYCLE_ORDER[a.lifecycle] - LIFECYCLE_ORDER[b.lifecycle]
    if (lc !== 0) return lc
    const ac = a.closes ? new Date(a.closes).getTime() : Infinity
    const bc = b.closes ? new Date(b.closes).getTime() : Infinity
    return ac - bc
  })
}
