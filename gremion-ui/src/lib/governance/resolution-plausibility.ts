// Client-safe (no $lib/server import): does a decision fit the meeting it is
// recorded in? ONE predicate for the resolution routes and the entry form, so the
// server's refusal and the form's can never disagree about it.
//
// Three rules. The two attendance rules read the attendance the protocol page
// shows (the voting members of the body and which of them are marked present):
//   - each count is a whole number from 0 (a negative part could cancel a huge
//     positive one and slip the sum below the attendance);
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
  code: 'invalid_count' | 'not_quorate' | 'votes_exceed_attendance'
  message: string
}

const count = (v: number | string | null | undefined): number => Number(v ?? 0) || 0

export const INVALID_COUNT_MESSAGE = 'Jede Stimmzahl muss eine ganze Zahl von 0 an sein.'

/**
 * True for a count the form or an API client sent: null/undefined (no count) or a whole
 * number from 0, given as a number or as a numeric string (as the vote-state helper
 * reads it).
 */
const isValidCount = (v: unknown): boolean => {
  if (v === null || v === undefined) return true
  if (typeof v === 'string' && v.trim() === '') return false
  if (typeof v !== 'number' && typeof v !== 'string') return false
  const n = Number(v)
  return Number.isInteger(n) && n >= 0
}

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

  if (![row.votes_yes, row.votes_no, row.votes_abstain].every(isValidCount)) {
    return { code: 'invalid_count', message: INVALID_COUNT_MESSAGE }
  }

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

/**
 * The first of `resolutions` that does not fit the meeting, with its refusal, or null when
 * all fit. One loop for the submit and publish gates, so both refuse the same rows.
 */
export function firstMisfittingResolution<T extends ResolutionPlausibilityRow>(
  resolutions: readonly T[],
  attendance: AttendanceBasis,
): { resolution: T; refusal: ResolutionRefusal } | null {
  for (const resolution of resolutions) {
    const refusal = checkResolutionAgainstAttendance(resolution, attendance)
    if (refusal) return { resolution, refusal }
  }
  return null
}
