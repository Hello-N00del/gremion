import { error, fail } from '@sveltejs/kit'
import type { Actions, PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { ElectionDb, type CommitteeElection } from '$lib/server/elections/election-db'
import { getOrgUnit } from '$lib/server/governance/org-units-db'
import { getVotesBackend } from '$lib/server/elections/backend'
import { dedupeDegradedUuids, deriveHeliosStatus } from '$lib/votes/helios-status'
import type { VoteItem } from '$lib/votes/types'

/**
 * A tracked Helios election whose ballot could not be reached on the external
 * Helios instance (404 / network / unreachable). We deliberately do NOT drop
 * the row — we surface what the local committee_elections row already tells us
 * (the org-unit it belongs to, when it was created) plus a neutral state label,
 * so the operator still sees the election exists and is simply awaiting / not
 * reachable on Helios. Field names mirror VoteItem where they overlap so the
 * page can render both shapes from one list. */
export interface DegradedVoteItem {
  id: string
  kind: 'helios'
  degraded: true
  /** Raw Helios election id (A1): shown on the card so two tracked elections
   *  of the same committee stay tellable apart while both are unreachable. */
  heliosUuid: string
  /** Friendly committee name resolved from the row's org_unit_id, if known. */
  committeeName: string | null
  /** ISO created-at from the local row — the only date we have without Helios. */
  createdAt: string
  /** Neutral, institutional state label (no infrastructure jargon beyond the
   *  unavoidable Helios/extern). */
  stateLabel: string
}

/** Normal, fully-hydrated VoteItem carries an explicit `degraded: false` so the
 *  page can discriminate the union without an extra `in` check. */
export type NormalVoteItem = VoteItem & { degraded: false }
export type VoteListItem = NormalVoteItem | DegradedVoteItem

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    error(403, 'Forbidden')
  }

  const isAdmin = hasRole(user.roles, Role.CouncilAdmin) || hasRole(user.roles, Role.ITAdmin)

  // Kernel-owned reads: the committee_elections rows stay in the kernel DB. The
  // votes backend (branch-by-abstraction: in-process HeliosClient + Nextcloud
  // Polls + aggregator, or the votes-service leaf) hydrates them into VoteItems.
  const electionRows: readonly CommitteeElection[] = await (
    isAdmin
      ? ElectionDb.findAll()
      : ElectionDb.findVisibleToUser(user.id)
  ).catch(() => [])

  // Helios satellite reads + Nextcloud Polls + aggregator merge, behind the seam.
  // Unreachable ballots come back as `degradedUuids` (never dropped) so we can
  // render a degraded card from the LOCAL row below. Tracked uuids are deduped
  // up front (D4): two committee_elections rows sharing a helios_uuid must not
  // probe — or render — the same ballot twice.
  const backend = getVotesBackend()
  const trackedUuids = [...new Set(electionRows.map((r) => r.helios_uuid))]
  const { votes: hydrated, degradedUuids, pollError } = await backend.listVotes(trackedUuids)
  const pollErrors = pollError

  // Degraded cards — built from the kernel's own rows (the leaf owns none). We
  // resolve committee names for the degraded rows in parallel (deduped by
  // org-unit) so the muted card can name the org-unit instead of a bare UUID.
  // D4 dedupe: filter the degraded set against the hydrated items first (key:
  // helios_uuid, the hydrated row wins) and keep only the FIRST local row per
  // uuid — the combined list below can never carry the same helios_uuid twice.
  const degradedSet = new Set(dedupeDegradedUuids(hydrated, degradedUuids))
  const degradedRows: CommitteeElection[] = []
  for (const row of electionRows) {
    if (!degradedSet.has(row.helios_uuid)) continue
    degradedSet.delete(row.helios_uuid)
    degradedRows.push(row)
  }
  const committeeNames = new Map<string, string | null>()
  await Promise.all(
    degradedRows.map(async (r) => {
      if (committeeNames.has(r.org_unit_id)) return
      try {
        const ou = await getOrgUnit(r.org_unit_id)
        committeeNames.set(r.org_unit_id, ou?.name ?? null)
      } catch {
        committeeNames.set(r.org_unit_id, null)
      }
    }),
  )
  const degraded: DegradedVoteItem[] = degradedRows.map((row) => ({
    id: `helios:${row.helios_uuid}`,
    kind: 'helios',
    degraded: true,
    heliosUuid: row.helios_uuid,
    committeeName: committeeNames.get(row.org_unit_id) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    stateLabel: 'Wahl angelegt · Ballot extern (Helios)',
  }))

  // The aggregator already ordered the hydrated items (open → planned → closed,
  // then by closing date); the degraded cards tail the list — they have no
  // lifecycle/close date to sort against and read as a quiet "tracked but
  // external" tail.
  const sortedHydrated: NormalVoteItem[] = hydrated.map((v) => ({ ...v, degraded: false }))

  return {
    votes: [...sortedHydrated, ...degraded] as VoteListItem[],
    pollErrors,
    // D4: the head pill derives from the SAME probe as the degraded cards —
    // never a hardcoded "verbunden" contradicting the list below it.
    heliosStatus: deriveHeliosStatus(pollError, degraded.length),
    // Drives the inline quick-poll create control (relocated from /polls, #197).
    isManager: isAdmin,
  }
}

export const actions: Actions = {
  // Quick-poll creation, relocated here from the now-removed /polls page (#197).
  // Mirrors the original /polls create action: same role gate, de-duplication
  // and Nextcloud error handling. Returns a fail() on validation/upstream error
  // so the inline PollCreateForm surfaces it; success closes the dialog (the
  // enhanced form invalidates the load on update, refreshing the poll list).
  create: async ({ request, locals }) => {
    const session = await locals.auth()
    const user = session?.user as SessionUser | undefined
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
      return fail(403, { error: 'Keine Berechtigung' })
    }

    const data = await request.formData()
    const title = (data.get('title') as string | null)?.trim()
    const optionsRaw = (data.get('options') as string | null)?.trim()
    const anonymous = data.get('anonymous') === 'on'

    if (!title) return fail(400, { error: 'Titel ist erforderlich' })
    const options = [
      ...new Set(
        (optionsRaw ?? '')
          .split('\n')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    ]
    if (options.length < 2) {
      return fail(400, { error: 'Mindestens 2 Optionen erforderlich (nach Entfernung von Duplikaten)' })
    }

    try {
      await getVotesBackend().createPoll({ title, type: 'textPoll', options, anonymous })
    } catch (e) {
      console.error('[votes] poll create failed:', e instanceof Error ? e.message : e)
      return fail(502, { error: 'Umfrage konnte nicht erstellt werden' })
    }

    return { success: true }
  },
}
