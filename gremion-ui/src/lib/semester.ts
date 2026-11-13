// src/lib/semester.ts
//
// The semester label shown beside the organisation's short name ("WiSe 26/27",
// "SoSe 27"). A customer stores only the two START MONTHS of its semesters
// (config brand.term_months); the label is computed from the current date at
// read time, so it can never go stale across a semester boundary.
//
// Pure and free of server-only imports (the clock is injected), so it can be
// unit-tested with a fixed date and bundled anywhere.

/** The months (1 to 12) in which the winter and the summer semester start. */
export interface TermMonths {
  winter: number
  summer: number
}

/** Calendar months are read in this zone, so a server in UTC and a council in Berlin name the same semester. */
const TIME_ZONE = 'Europe/Berlin'

const isMonth = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 12

/** True for two different integer months 1 to 12. */
export function isTermMonths(v: unknown): v is TermMonths {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return isMonth(m.winter) && isMonth(m.summer) && m.winter !== m.summer
}

/** The Berlin calendar year and month (1 to 12) of an instant. */
function berlinYearMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric' }).formatToParts(now)
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return { year: num('year'), month: num('month') }
}

/** Two-digit year; the rollover prints "00" (2100 -> "00", 2099 -> "99"). */
const yy = (year: number): string => String(((year % 100) + 100) % 100).padStart(2, '0')

/**
 * The semester that `now` falls into.
 *
 * The year is split into two half-open ranges: the summer semester runs from
 * month S up to (not including) month W, the winter semester from W up to S,
 * both wrapping around the new year when needed. A semester is named for the
 * calendar year it STARTED in: "WiSe 26/27" is the winter semester that began in
 * 2026, "SoSe 27" the summer semester that began in 2027. With the usual
 * W=10, S=4 that is the date's own year for a summer semester; with W < S (a
 * summer semester that crosses the new year) January and February still belong
 * to the semester that began in the previous year.
 */
export function semesterLabel(now: Date, months: TermMonths): string {
  const { year, month } = berlinYearMonth(now)
  const { winter, summer } = months
  const inSummer = summer < winter ? month >= summer && month < winter : month >= summer || month < winter
  const start = inSummer ? summer : winter
  const startYear = month >= start ? year : year - 1
  return inSummer ? `SoSe ${yy(startYear)}` : `WiSe ${yy(startYear)}/${yy(startYear + 1)}`
}
