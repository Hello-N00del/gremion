// gremion-ui/src/lib/server/elections/backend/inprocess-client.ts
// Branch-by-abstraction default path; byte-identical to the pre-seam /votes route
// behavior until the deliberate (HELD) cutover to 'service'.
//
// listVotes reproduces the pre-extraction /votes composition VERBATIM: settle a
// HeliosClient.getElection per tracked uuid (so one 5xx never blanks the page),
// map each reachable election with the pure aggregator, collect the unreachable
// uuids as `degradedUuids` (the kernel builds the degraded card from its local
// row), list Nextcloud polls (a failure surfaces as `pollError`, non-fatal), and
// merge reachable elections + polls with mergeVoteItems. createPoll is a thin
// delegate to NextcloudPollsClient.createPoll.
//
// No logic lives here beyond that delegation — callers use VotesBackendPort.

import { HeliosClient, isHeliosUnavailable } from '../helios-client'
import { NextcloudPollsClient } from '$lib/server/polls/polls-client'
import { mapHeliosToVoteItem, mapPollToVoteItem, mergeVoteItems } from '$lib/votes/aggregator'
import type { VoteItem } from '$lib/votes/types'
import type { CreatePollInput, VotesBackendPort, VotesListResult } from './port'

export class InprocessVotesClient implements VotesBackendPort {
  readonly kind = 'inprocess' as const

  async listVotes(electionUuids: readonly string[]): Promise<VotesListResult> {
    // Helios — settle each lookup individually. A single 5xx from Helios must not
    // blank the whole page, and an unreachable ballot must not silently drop the
    // tracked election (the kernel degrades it from its local row instead).
    const heliosResults = await Promise.allSettled(
      electionUuids.map((uuid) => HeliosClient.getElection(uuid)),
    )

    const reachable: VoteItem[] = []
    const degradedUuids: string[] = []
    heliosResults.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        reachable.push(mapHeliosToVoteItem(r.value))
        return
      }
      // Rejected. Keep the row regardless — the only realistic failure modes are
      // "ballot not on this Helios instance" (404), "Helios is down" (5xx), or
      // "unreachable" (network). An unexpected error is logged but STILL degraded
      // rather than dropped, so a seeded/known election never disappears.
      if (!isHeliosUnavailable(r.reason)) {
        console.warn(
          `[votes] unexpected Helios error for ${electionUuids[i]}; rendering degraded card:`,
          r.reason,
        )
      }
      degradedUuids.push(electionUuids[i])
    })

    // Nextcloud Polls — surface a non-fatal error if unavailable so /votes still
    // renders the Helios elections.
    let pollItems: VoteItem[] = []
    let pollError: string | null = null
    try {
      const ncPolls = await NextcloudPollsClient.listPolls()
      pollItems = ncPolls.map((p) => mapPollToVoteItem(p))
    } catch (e) {
      pollError = e instanceof Error ? e.message : 'Umfragen konnten nicht geladen werden'
    }

    // Order the fully-hydrated items with the existing aggregator (open → planned
    // → closed, then by closing date). Degraded cards are appended by the kernel.
    return { votes: mergeVoteItems(reachable, pollItems), degradedUuids, pollError }
  }

  async createPoll(input: CreatePollInput): Promise<void> {
    await NextcloudPollsClient.createPoll(input)
  }
}
