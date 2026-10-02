// gremion-ui/src/lib/server/calendar/recurrence-expand.ts
//
// F1-FIX-08 (S1c#12): recurring events used to vanish after their first
// occurrence — listEvents filtered on the stored first occurrence and nothing
// expanded the series. The backends now also return recurring masters that
// started before the window (calendar-db / leaf listEvents); this module turns
// every master into its occurrences inside [from, to).
//
// Semantics (RFC 5545 subset that the UI can create, CreateEventDialog):
// - FREQ daily | weekly | monthly | yearly, INTERVAL, COUNT, UNTIL (inclusive
//   Europe/Berlin civil day: the column is a DATE), weekly BYDAY (MO..SU),
//   EXDATE (DATE values, matched by Europe/Berlin civil day).
// - Occurrences keep the master's Europe/Berlin wall-clock time across DST
//   (a weekly 18:00 meeting stays at 18:00 local), and its duration.
// - DTSTART is always the first instance; COUNT counts from it and includes
//   excepted dates (EXDATE removes after the set is generated).
// - monthly/yearly skip months/years without the start's day (no clamping).
// Each occurrence is a shallow copy of the master with shifted startAt/endAt;
// id stays the master's (edits act on the series).

import type { DbEvent, DbRecurrence } from './backend/port'

const TZ = 'Europe/Berlin'
const DAY_MS = 86_400_000
const MAX_CANDIDATES = 10_000
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

const wallFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

interface Wall {
  y: number
  m: number // 1-12
  d: number
  h: number
  mi: number
  s: number
  ms: number
}

function wallOf(date: Date): Wall {
  const parts: Record<string, number> = {}
  for (const p of wallFormat.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute!, s: parts.second!, ms: date.getUTCMilliseconds() }
}

/** Europe/Berlin offset (ms) at the given instant. */
function offsetAt(t: number): number {
  const w = wallOf(new Date(t))
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s, w.ms) - t
}

/** Instant of a Europe/Berlin wall-clock time (two-pass offset fix for DST). */
function fromWall(civilDay: number, w: Pick<Wall, 'h' | 'mi' | 's' | 'ms'>): Date {
  const naive = civilDay * DAY_MS + ((w.h * 60 + w.mi) * 60 + w.s) * 1000 + w.ms
  let t = naive - offsetAt(naive)
  t = naive - offsetAt(t)
  return new Date(t)
}

function civilDayOf(date: Date): number {
  const w = wallOf(date)
  return Date.UTC(w.y, w.m - 1, w.d) / DAY_MS
}

/**
 * Europe/Berlin civil day (days since epoch) of a recurrence DATE value
 * (`until`, `exceptions`). The columns are DATE: postgres.js hands them over
 * as UTC midnight, node-postgres under TZ=Europe/Berlin as Berlin midnight, the
 * API as an ISO instant. All of them name a civil day, never an instant.
 */
export function recurrenceDateDay(value: Date | string): number {
  return civilDayOf(new Date(value))
}

/** YYYYMMDD of a civil day number. */
export function civilDayYmd(civilDay: number): string {
  return new Date(civilDay * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '')
}

/** HHMMSS of the Europe/Berlin wall-clock time of an instant. */
export function berlinWallHms(date: Date): string {
  const w = wallOf(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(w.h)}${pad(w.mi)}${pad(w.s)}`
}

/**
 * Last second of a recurrence `until` civil day in Europe/Berlin, as an
 * instant: the RFC 5545 UTC UNTIL for a TZID DTSTART (inclusive end day).
 */
export function endOfUntilDay(value: Date | string): Date {
  const nextMidnight = fromWall(recurrenceDateDay(value) + 1, { h: 0, mi: 0, s: 0, ms: 0 })
  return new Date(nextMidnight.getTime() - 1000)
}

function civilFromYmd(y: number, m: number, d: number): number | null {
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  if (back.getUTCMonth() !== (((m - 1) % 12) + 12) % 12 || back.getUTCDate() !== d) return null
  return t / DAY_MS
}

/** Monday = 0 … Sunday = 6 for a civil day number. */
function weekdayIndex(civilDay: number): number {
  return (new Date(civilDay * DAY_MS).getUTCDay() + 6) % 7
}

function* candidateDays(r: DbRecurrence, day0: number, w0: Wall): Generator<number> {
  const interval = Math.max(1, r.interval || 1)
  switch (r.frequency) {
    case 'daily':
      for (let k = 0; ; k++) yield day0 + k * interval
    case 'weekly': {
      const fromByday = (r.byday ?? [])
        .map((code) => WEEKDAYS.indexOf(code.toUpperCase() as (typeof WEEKDAYS)[number]))
        .filter((i) => i >= 0)
      const days = [...new Set(fromByday.length > 0 ? fromByday : [weekdayIndex(day0)])].sort((a, b) => a - b)
      const week0 = day0 - weekdayIndex(day0)
      if (!days.includes(weekdayIndex(day0))) yield day0 // DTSTART is always the first instance
      for (let k = 0; ; k++) {
        for (const idx of days) {
          const day = week0 + k * 7 * interval + idx
          if (day >= day0) yield day
        }
      }
    }
    case 'monthly':
      for (let k = 0; ; k++) {
        const monthIndex = w0.m - 1 + k * interval
        const day = civilFromYmd(w0.y + Math.floor(monthIndex / 12), (monthIndex % 12) + 1, w0.d)
        if (day !== null) yield day
      }
    case 'yearly':
      for (let k = 0; ; k++) {
        const day = civilFromYmd(w0.y + k * interval, w0.m, w0.d)
        if (day !== null) yield day
      }
  }
}

function expandOne(ev: DbEvent, r: DbRecurrence, from: Date, to: Date): DbEvent[] {
  const w0 = wallOf(ev.startAt)
  const day0 = civilDayOf(ev.startAt)
  const duration = ev.endAt.getTime() - ev.startAt.getTime()
  const excluded = new Set((r.exceptions ?? []).map((x) => recurrenceDateDay(x)))
  // UNTIL is an inclusive civil day (DATE column), compared by Berlin day: as
  // an instant (UTC midnight) it dropped the occurrence on the end date.
  const untilDay = r.until ? recurrenceDateDay(r.until) : null
  const out: DbEvent[] = []

  let n = 0
  for (const day of candidateDays(r, day0, w0)) {
    if (++n > MAX_CANDIDATES) break
    if (r.count !== null && r.count !== undefined && n > r.count) break
    if (untilDay !== null && day > untilDay) break
    const start = day === day0 ? ev.startAt : fromWall(day, w0)
    if (start.getTime() >= to.getTime()) break
    if (excluded.has(day)) continue
    const end = new Date(start.getTime() + duration)
    if (end.getTime() >= from.getTime()) {
      out.push(day === day0 ? ev : { ...ev, startAt: start, endAt: end })
    }
  }
  return out
}

/**
 * Expand recurring masters into their occurrences in [from, to) and keep
 * non-recurring events as they are. Result is sorted by start.
 */
export function expandRecurringEvents(events: readonly DbEvent[], from: Date, to: Date): DbEvent[] {
  const out: DbEvent[] = []
  for (const ev of events) {
    if (ev.recurrence) out.push(...expandOne(ev, ev.recurrence, from, to))
    else out.push(ev)
  }
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
}
