// gremion-ui/src/lib/server/elections/backend/port.ts
// Branch-by-abstraction seam for the votes/elections subsystem — the aggregation
// path behind the /votes list page (#363).
//
// VotesBackendPort is the interface the /votes route composes with, once the seam
// is wired in. The method set is the exact aggregation surface the pre-extraction
// route drove by hand: it fetches each tracked Helios election (the "satellite"),
// lists the Nextcloud quick-polls, maps both through the pure aggregator and
// merges them into one ordered VoteItem list. The kernel keeps ownership of the
// committee_elections rows (election-db reads) and the degraded-card composition
// (it names the org-unit via governance/org-units-db) — the port returns which
// helios_uuids could NOT be reached so the kernel can render a degraded card from
// its OWN local row. That split is what keeps the flag-OFF path byte-identical.
//
// The Helios ADMIN surface (create/freeze/setQuestions/bulkUploadVoters, driven
// by the /elections management routes) is NOT part of this seam: it stays on the
// in-process HeliosClient by design — this leaf is a stateless read/aggregate +
// quick-poll-create thin proxy (Option A), not the full elections lifecycle.
//
// This file has NO runtime deps — it is a near-pure TypeScript interface (VoteItem
// is `import type`, erased at compile).

import type { VoteItem } from '$lib/votes/types'

export type { VoteItem } from '$lib/votes/types'

/** Result of composing the /votes list. */
export interface VotesListResult {
  /** Reachable Helios elections + Nextcloud polls, mapped to VoteItems and merged
   *  (open → planned → closed, then by closing date) by the aggregator. Does NOT
   *  carry the `degraded` discriminant — the kernel wraps each with
   *  `degraded: false` when it assembles the final VoteListItem[]. */
  votes: VoteItem[]
  /** helios_uuids of tracked elections whose ballot could not be reached on the
   *  external Helios instance (404 / 5xx / network). Returned — NOT dropped — so
   *  the kernel renders a degraded card for each from its committee_elections row
   *  (which carries the org-unit + created-at the leaf does not have). Preserves
   *  the input `electionUuids` order. */
  degradedUuids: string[]
  /** Non-null when Nextcloud Polls could not be listed — the page still renders
   *  the Helios elections. Mirrors the pre-extraction route's `pollErrors`. */
  pollError: string | null
}

/** Inputs for a Nextcloud quick-poll create (the /votes inline create action). */
export interface CreatePollInput {
  title: string
  type: 'textPoll' | 'datePoll'
  options: string[]
  anonymous: boolean
}

export interface VotesBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   * 'inprocess' = in-process HeliosClient + NextcloudPollsClient + aggregator
   * (byte-identical to the monolith); 'service' = HTTP ACL calls to the
   * votes-service leaf.
   */
  readonly kind: 'inprocess' | 'service'

  /**
   * Compose the /votes list for the given tracked election UUIDs: fetch each
   * Helios election (settling individually so one 5xx never blanks the page),
   * list the Nextcloud polls, map both through the aggregator and merge. Elections
   * that can't be reached are returned as `degradedUuids` (never dropped).
   */
  listVotes(electionUuids: readonly string[]): Promise<VotesListResult>

  /** Create a Nextcloud quick-poll. Resolves on success; throws on upstream error
   *  (the route maps the throw to a 502 fail()). */
  createPoll(input: CreatePollInput): Promise<void>
}
