// Day separators of a conversation. Pure and import-free, like sender-label.ts.
//
// A conversation is shown as runs of messages that share a calendar day, each run under one
// separator that names that day. The day is the reader's civil day (the zone their clock and the
// time beside each message use), never the UTC date: a message sent at 00:30 belongs to the new
// day even while UTC still shows the old one.
//
// "Heute" and "Gestern" are decided per group against the day of `now`, so they are only ever
// printed above messages they are true for. "Gestern" is the civil day before today, not
// "24 hours ago": a day with a clock change is 23 or 25 hours long.

export interface DayGroup<T> {
  /** The group's civil day as YYYY-MM-DD, or null for leading messages that carry no timestamp. */
  day: string | null
  /** The separator text, or null when the group has no known day (then no separator is shown). */
  label: string | null
  messages: T[]
}

interface CivilDay {
  year: number
  month: number
  day: number
}

const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
const keyOf = (d: CivilDay): string => `${d.year}-${two(d.month)}-${two(d.day)}`
const dateOf = (d: CivilDay): string => `${two(d.day)}.${two(d.month)}.${d.year}`

/** Reads the civil day of an instant in `timeZone` (undefined = the zone of this runtime). */
function civilDayReader(timeZone: string | undefined): (ts: number) => CivilDay | null {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
  return (ts) => {
    // 0 / missing / not a number: the message has no usable timestamp, so it names no day.
    if (!Number.isFinite(ts) || ts <= 0) return null
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return null
    const out: CivilDay = { year: 0, month: 0, day: 0 }
    for (const part of format.formatToParts(date)) {
      if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
        out[part.type] = Number(part.value)
      }
    }
    return out
  }
}

/** The civil day before `d`. Calendar arithmetic on the date itself, so it is independent of zone and clock changes. */
function dayBefore(d: CivilDay): CivilDay {
  const prev = new Date(Date.UTC(d.year, d.month - 1, d.day - 1))
  return { year: prev.getUTCFullYear(), month: prev.getUTCMonth() + 1, day: prev.getUTCDate() }
}

/**
 * Splits `messages` (in the order they are shown) into runs of the same civil day.
 *
 * A message whose day differs from the run before it opens a new group; a message without a
 * timestamp stays in the group it follows. Order is never changed.
 */
export function groupByDay<T extends { ts?: number | null }>(
  messages: readonly T[],
  now: number | Date = Date.now(),
  timeZone?: string,
): DayGroup<T>[] {
  const civilDay = civilDayReader(timeZone)
  const today = civilDay(typeof now === 'number' ? now : now.getTime())
  const todayKey = today ? keyOf(today) : null
  const yesterdayKey = today ? keyOf(dayBefore(today)) : null

  const groups: DayGroup<T>[] = []
  let current: DayGroup<T> | null = null
  for (const message of messages) {
    const day = civilDay(message.ts ?? 0)
    const key = day ? keyOf(day) : null
    if (current === null || (key !== null && key !== current.day)) {
      let label: string | null = null
      if (day && key !== null) {
        const date = dateOf(day)
        if (key === todayKey) label = `Heute · ${date}`
        else if (key === yesterdayKey) label = `Gestern · ${date}`
        else label = date
      }
      current = { day: key, label, messages: [] }
      groups.push(current)
    }
    current.messages.push(message)
  }
  return groups
}
