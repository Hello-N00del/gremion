// The `date` query parameter of the calendar page: /calendar?date=YYYY-MM-DD opens the calendar on that day.
// The command palette links a found event this way.

/** The day a `date` parameter names, as a local date at noon (so a time zone never moves it to a
 *  neighbouring day); null for anything that is not exactly a real YYYY-MM-DD. */
export function parseDateParam(value: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(y, mo - 1, d, 12)
  // new Date rolls 2026-02-30 over to March: only a day that survives unchanged is real.
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null
  return day
}
