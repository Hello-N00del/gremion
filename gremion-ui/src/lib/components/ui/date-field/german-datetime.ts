// German display formats for date fields. Display only: the values a form
// works with and sends stay ISO. The browser's own date and time inputs follow
// the browser language, so a field types the date as text in German order and
// turns it back into the ISO local value ("YYYY-MM-DD", or "YYYY-MM-DDTHH:mm"
// with a time).

const pad = (n: number): string => n.toString().padStart(2, '0')

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const GERMAN_DATE_TIME = /^(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})$/
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/

/**
 * A real calendar day: Date rolls 31.02. over into March, so compare it back. Years below 1000 are
 * refused: the ISO value would lose its leading zeros ("999-01-01") and no term starts there.
 */
function isRealDay(year: number, month: number, day: number): boolean {
  if (year < 1000) return false
  const d = new Date(year, month - 1, day)
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
}

/** "2026-11-05T09:30" -> "05.11.2026 09:30"; '' when empty or not in that form. */
export function formatLocalInputDe(localIso: string): string {
  const m = LOCAL_ISO.exec(localIso)
  if (!m) return ''
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`
}

/** "2026-11-05" -> "05.11.2026"; '' when empty or not in that form. */
export function formatDateDe(isoDate: string): string {
  const m = DATE_ISO.exec(isoDate)
  if (!m) return ''
  return `${m[3]}.${m[2]}.${m[1]}`
}

/**
 * "05.11.2026 09:30" -> "2026-11-05T09:30"; null when the text is not a real
 * German date and time (wrong order, a day or time that does not exist, no time).
 */
export function parseDateTimeDe(text: string): string | null {
  const m = GERMAN_DATE_TIME.exec(text.trim())
  if (!m) return null
  const [day, month, year, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  if (hour > 23 || minute > 59) return null
  if (!isRealDay(year, month, day)) return null
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}

/** "05.11.2026" -> "2026-11-05"; null when the text is not a real German date. */
export function parseDateDe(text: string): string | null {
  const m = GERMAN_DATE.exec(text.trim())
  if (!m) return null
  const [day, month, year] = [m[1], m[2], m[3]].map(Number)
  if (!isRealDay(year, month, day)) return null
  return `${year}-${pad(month)}-${pad(day)}`
}
