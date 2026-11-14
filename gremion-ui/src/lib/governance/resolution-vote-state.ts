// Client-safe (no $lib/server import): whether a resolution has been voted on
// at all. ONE predicate for the row display, the register and the submit and
// publish gates, so the server and the UI can never disagree about it.
//
// A counted ("tally") resolution is created with 0/0/0 and the rule engine
// computes "rejected" for that under every majority rule. That stored value is
// a placeholder, not a decision: nobody voted. Such a row is UNTALLIED until a
// count is entered, the resolution is withdrawn or it is deleted, and a protocol
// that still carries one can be neither submitted nor published.
//
// Not untallied, by the domain model:
//   - withdrawn: an author act, no vote is expected;
//   - acclamation: the chair declared the outcome, a count is optional;
//   - consent: silence adopts. With no objection recorded the resolution IS
//     adopted, so an empty tally is a real (passed) decision there.

/** The `code` on the publish route's 422 body when it refuses an untallied resolution. */
export const UNTALLIED_RESOLUTION_CODE = 'untallied_resolution'

export interface ResolutionVoteFields {
  result: string
  required_majority: string
  // Absent on rows read before the adoption-mode column existed: a counted vote.
  adoption_mode?: string | null
  votes_yes?: number | string | null
  votes_no?: number | string | null
  votes_abstain?: number | string | null
}

// A missing, empty or non-numeric count is no vote (fail closed: a tally row
// without counts must not pass as decided).
const count = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

/** True iff no vote was cast or recorded at all (every count missing or zero). */
export function tallyIsEmpty(r: Pick<ResolutionVoteFields, 'votes_yes' | 'votes_no' | 'votes_abstain'>): boolean {
  return count(r.votes_yes) + count(r.votes_no) + count(r.votes_abstain) === 0
}

/** True iff `r` is a counted resolution that nobody has voted on yet. */
export function isUntalliedResolution(r: ResolutionVoteFields): boolean {
  if (r.result === 'withdrawn') return false
  if (r.adoption_mode === 'acclamation') return false
  if (r.required_majority === 'consent') return false
  return tallyIsEmpty(r)
}

/**
 * The 1-based positions (in the given order, which is the order the protocol
 * page lists them in) of the resolutions nobody has voted on yet.
 */
export function untalliedPositions(resolutions: readonly ResolutionVoteFields[]): number[] {
  const positions: number[] = []
  resolutions.forEach((r, i) => {
    if (isUntalliedResolution(r)) positions.push(i + 1)
  })
  return positions
}

/**
 * The German refusal shown when a protocol with untallied resolutions is
 * submitted or published, or null when every resolution has a vote.
 */
export function untalliedResolutionsMessage(resolutions: readonly ResolutionVoteFields[]): string | null {
  const positions = untalliedPositions(resolutions)
  if (positions.length === 0) return null
  if (positions.length === 1) {
    return `Beschluss ${positions[0]} hat noch keine Abstimmung. Bitte die Stimmen eintragen oder den Beschluss zurückziehen oder löschen.`
  }
  const list = `${positions.slice(0, -1).join(', ')} und ${positions[positions.length - 1]}`
  return `Die Beschlüsse ${list} haben noch keine Abstimmung. Bitte die Stimmen eintragen oder die Beschlüsse zurückziehen oder löschen.`
}
