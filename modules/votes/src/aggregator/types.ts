// services/votes/src/aggregator/types.ts
// Leaf-local copy of the unified vote-list item shape. Duplicated from
// gremion-ui/src/lib/votes/types.ts on purpose: the leaf is a SEPARATE process and
// cannot import the kernel $lib — the two must be kept byte-compatible (the
// contract at contracts/votes/openapi.votes-internal.json is the seam). See the
// kernel copy for the full field semantics.
export interface VoteItem {
  id: string
  kind: 'helios' | 'poll'
  lifecycle: 'open' | 'planned' | 'closed'
  title: string
  description: string
  turnout: number
  quorum: number
  voterCount: number
  castVotes: number
  opens: string
  closes: string
  candidates?: string[]
  options?: { label: string; votes: number }[]
}
