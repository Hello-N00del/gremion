/** Unified vote-list item shape combining Helios elections + Nextcloud Polls.
 *
 * Field semantics:
 * - `id` is namespaced — `helios:<uuid>` for elections, `poll:<numericId>` for
 *   Nextcloud polls. Lets the UI tell which detail-fetch endpoint to call.
 * - `lifecycle` is reconciled across the two sources:
 *     - Helios `draft`  → 'planned'   (election created but not yet frozen)
 *     - Helios `open`   → 'open'
 *     - Helios `closed` → 'closed'
 *     - Polls expired   → 'closed'
 *     - Polls active    → 'open'      (Nextcloud Polls has no "planned" state)
 * - `turnout` / `quorum` / `voterCount` are 0 when the source doesn't expose
 *   them (Nextcloud Polls list response carries no voter-count surface).
 * - `castVotes` is `num_cast_votes` for Helios. For polls it's 0 in the list
 *   response; populated when options are fetched on click.
 * - `opens` / `closes` are ISO strings; empty string when missing.
 * - `candidates` / `options` are populated lazily — list view leaves them
 *   undefined; detail view fills them via dedicated endpoints. */
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
