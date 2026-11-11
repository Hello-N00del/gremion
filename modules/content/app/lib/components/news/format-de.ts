// Content Engine — German display formats for the UI. Display only: every
// stored or sent value stays ISO. The schedule field shows "TT.MM.JJJJ HH:MM"
// and turns what the author typed back into the ISO local value
// ("YYYY-MM-DDTHH:mm", the form <input type=datetime-local> uses) before it is
// converted to an ISO instant.

const pad = (n: number): string => String(n).padStart(2, '0')

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const GERMAN = /^(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})$/

/** "2026-11-05T09:30" -> "05.11.2026 09:30"; '' when empty or not in that form. */
export function formatLocalInputDe(localIso: string): string {
  const m = LOCAL_ISO.exec(localIso)
  if (!m) return ''
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`
}

/**
 * "05.11.2026 09:30" -> "2026-11-05T09:30"; null when the text is not a real
 * German date and time (wrong order, a day or time that does not exist, no time).
 */
export function parseDateTimeDe(text: string): string | null {
  const m = GERMAN.exec(text.trim())
  if (!m) return null
  const [day, month, year, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  if (hour > 23 || minute > 59) return null
  // Real calendar day: Date rolls 31.02. over into March, so compare it back.
  const d = new Date(year, month - 1, day)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}

/** "1 Mitglied" / "2 Mitglieder": the singular for exactly 1. */
export function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}
