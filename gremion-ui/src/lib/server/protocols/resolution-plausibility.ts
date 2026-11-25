// The resolution write routes refuse a decision that does not fit the meeting it
// is recorded in. The rule itself lives in $lib/governance/resolution-plausibility
// (shared with the entry form); this is only its answer as an HTTP refusal.
import { error } from '@sveltejs/kit'
import {
  INVALID_COUNT_MESSAGE,
  checkResolutionAgainstAttendance,
  isWholeNumberCountInput,
  type AttendanceBasis,
  type ResolutionPlausibilityRow,
} from '$lib/governance/resolution-plausibility'

/**
 * Throws 422 when the meeting is not quorate (the same status the publish gate
 * answers with), 400 when a count is not a whole number from 0 or the total exceeds
 * the members present. Returns when the
 * decision fits, or is exempt (withdrawn, nobody voted on yet).
 */
export function assertResolutionFitsMeeting(
  row: ResolutionPlausibilityRow,
  attendance: AttendanceBasis,
): void {
  const refusal = checkResolutionAgainstAttendance(row, attendance)
  if (!refusal) return
  throw error(refusal.code === 'not_quorate' ? 422 : 400, refusal.message)
}

/**
 * Throws 400 when a count the client sent is not a JSON number that is a whole number
 * from 0 (a numeric string is refused, as on the tally path). Absent counts pass.
 */
export function requireWholeNumberCounts(...counts: unknown[]): void {
  if (!counts.every(isWholeNumberCountInput)) throw error(400, INVALID_COUNT_MESSAGE)
}
