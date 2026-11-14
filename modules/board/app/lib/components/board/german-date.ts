// German display format for a card's due date. Display only: the value the editor sends stays the
// ISO day ("YYYY-MM-DD"). The browser's own date input follows the browser language (month first
// in an English browser), so the editor types the date as text in German order and turns it back
// into the ISO day here. The calendar and the content module carry the same idea for date and
// time; like the count labels the board keeps its own, because those modules can be switched off.

const pad = (n: number): string => String(n).padStart(2, '0')

const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/

/** A real calendar day: Date rolls 31.02. over into March, so compare it back. */
function isRealDay(year: number, month: number, day: number): boolean {
  const d = new Date(year, month - 1, day)
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
}

/** "2026-11-05" -> "05.11.2026"; '' when empty or not in that form. */
export function formatDateDe(isoDate: string): string {
  const m = DATE_ISO.exec(isoDate)
  if (!m) return ''
  return `${m[3]}.${m[2]}.${m[1]}`
}

/** "05.11.2026" or "5.11.2026" -> "2026-11-05"; null when the text is not a real German date. */
export function parseDateDe(text: string): string | null {
  const m = GERMAN_DATE.exec(text.trim())
  if (!m) return null
  const [day, month, year] = [m[1], m[2], m[3]].map(Number)
  if (!isRealDay(year, month, day)) return null
  return `${m[3]}-${pad(month)}-${pad(day)}`
}
