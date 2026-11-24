// Client-safe (no $lib/server import): does a decision fit the meeting it is
// recorded in? ONE predicate for the resolution routes and the entry form, so the
// server's refusal and the form's can never disagree about it.
//
// Two rules, both read from the attendance the protocol page shows (the voting
// members of the body and which of them are marked present):
//   - a meeting that is not quorate by the app's own rule (strict majority of the
//     voting members present, see quorum.ts) records no decision;
//   - yes + no + abstain cannot exceed the number of voting members present.
//
// What is exempt, in step with the publish gate:
//   - a withdrawn resolution: an author act, not a vote (and the way out for a row
//     whose stored count no longer fits);
//   - a counted row nobody voted on (0/0/0): a placeholder, not a decision (see
//     resolution-vote-state.ts). A consent row with an empty tally IS adopted and
//     is checked like any decision.

import { isUntalliedResolution, type ResolutionVoteFields } from './resolution-vote-state'

/** The attendance basis: the numbers the quorum pill on the protocol page shows. */
export interface AttendanceBasis {
  eligibleVotingCount: number
  presentVotingCount: number
  quorate: boolean
}

export type ResolutionPlausibilityRow = Omit<ResolutionVoteFields, 'result'> & {
  /** Only 'withdrawn' matters here; a row not yet decided may leave it out. */
  result?: string
}

export interface ResolutionRefusal {
  code: 'not_quorate' | 'votes_exceed_attendance'
  message: string
}

const count = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

export function notQuorateMessage(attendance: AttendanceBasis): string {
  return (
    `Nicht beschlussfähig: ${attendance.presentVotingCount} von ${attendance.eligibleVotingCount} ` +
    'stimmberechtigten Mitgliedern anwesend. Ein Beschluss wird erst gespeichert, wenn das Gremium ' +
    'beschlussfähig ist — bitte zuerst die Anwesenheit erfassen.'
  )
}

export function votesExceedAttendanceMessage(total: number, present: number): string {
  return (
    `Die Stimmen (${total}) übersteigen die Zahl der anwesenden stimmberechtigten Mitglieder (${present}). ` +
    'Bitte Stimmzahlen und Anwesenheit prüfen.'
  )
}

/** The refusal of a decision that does not fit the meeting, or null when it fits. */
export function checkResolutionAgainstAttendance(
  row: ResolutionPlausibilityRow,
  attendance: AttendanceBasis,
): ResolutionRefusal | null {
  if (row.result === 'withdrawn') return null

  const total = count(row.votes_yes) + count(row.votes_no) + count(row.votes_abstain)
  const isDecision = !isUntalliedResolution({ ...row, result: row.result ?? 'rejected' })

  if (isDecision && !attendance.quorate) {
    return { code: 'not_quorate', message: notQuorateMessage(attendance) }
  }
  if (total > attendance.presentVotingCount) {
    return {
      code: 'votes_exceed_attendance',
      message: votesExceedAttendanceMessage(total, attendance.presentVotingCount),
    }
  }
  return null
}
