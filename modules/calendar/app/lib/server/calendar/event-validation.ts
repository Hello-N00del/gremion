// Order check for the start and end of a calendar event.
//
// An end before the start is refused. An end equal to the start stays valid:
// the create dialog sends exactly that for an all-day event (both are the one
// chosen date), and neither the store nor the CalDAV push treat it as an error.

export const END_BEFORE_START_MESSAGE = 'Das Ende darf nicht vor dem Beginn liegen.'

/** True when `end` lies strictly before `start`. */
export function endsBeforeStart(start: Date, end: Date): boolean {
  return end.getTime() < start.getTime()
}
