// Calendar automations — Stream B1.
//
// Three source integrations keep `calendar_events` in sync with the rest of
// the platform. All automations call `createEvent` via the CalendarBackendPort
// (getCalendarBackend()), which enqueues a CalDAV push per side-effect, so no
// dedicated sync step is needed here.
//
//   1. Helios → calendar  (source: 'helios')   — deadlines + voting windows
//   2. Meeting minutes   (source: 'minutes')   — extract next-meeting dates
//   3. German holidays   (source: 'holiday')   — federal/Bundesland calendar
//
// The Helios and minutes paths are exposed as shared HTTP endpoints for
// Stream B2 (Helios-Voting) and Stream B4 (Meeting Minutes) respectively.
// See `docs/superpowers/specs/2026-04-15-calendar-improvements-design.md`.

import { getCalendarBackend } from './backend'
import type { EventSource } from './backend'

// ─── 1. Helios → Calendar ─────────────────────────────────────────────────────

export interface HeliosCalendarInput {
  /** Helios election UUID — stored on events as `external_id`. */
  electionId: string
  /** Human-readable election name — used as event title prefix. */
  name: string
  /** Optional committee to tag events with (enables dual-tone colour). */
  committeeId: string | null
  /** When nominations close (a deadline event; null = skip). */
  nominationDeadline: Date | null
  /** When voting opens (a Wahl event; null = skip). */
  votingStartsAt: Date | null
  /** When voting closes (a Wahl event; null = skip). */
  votingEndsAt: Date | null
  /** When results publish (a Wahl event; null = skip). */
  resultsAt: Date | null
  /** Keycloak user id attributed as creator. */
  createdBy: string
}

/**
 * Creates up to four read-only calendar events for an election.
 *
 * Re-running with the same `electionId` first deletes any events still tagged
 * with that external id, so callers can safely invoke on update as well as
 * create.
 */
export async function createHeliosCalendarEvents(
  input: HeliosCalendarInput,
): Promise<void> {
  const backend = getCalendarBackend()

  // Idempotent: drop any previous events for this election before re-creating.
  await backend.deleteEventsByExternalId('helios', input.electionId)

  const types = await backend.listEventTypes()
  const deadlineTypeId = types.find((t) => t.name === 'Frist')?.id ?? null
  const electionTypeId = types.find((t) => t.name === 'Wahl')?.id ?? null

  const committeeIds = input.committeeId ? [input.committeeId] : []
  const entries: Array<{ title: string; date: Date | null; typeId: string | null }> = [
    {
      title: `${input.name} — Nominierungsfrist`,
      date: input.nominationDeadline,
      typeId: deadlineTypeId,
    },
    {
      title: `${input.name} — Abstimmung beginnt`,
      date: input.votingStartsAt,
      typeId: electionTypeId,
    },
    {
      title: `${input.name} — Abstimmung endet`,
      date: input.votingEndsAt,
      typeId: electionTypeId,
    },
    {
      title: `${input.name} — Ergebnisse`,
      date: input.resultsAt,
      typeId: electionTypeId,
    },
  ]

  for (const entry of entries) {
    if (!entry.date) continue
    await backend.createEvent({
      title: entry.title,
      description: null,
      location: null,
      startAt: entry.date,
      endAt: new Date(entry.date.getTime() + 60 * 60 * 1000),
      allDay: false,
      eventTypeId: entry.typeId,
      isMultiCommittee: false,
      createdBy: input.createdBy,
      source: 'helios',
      externalId: input.electionId,
      committeeIds,
      recurrence: null,
    })
  }
}

// ─── 2. Meeting minutes → Calendar ────────────────────────────────────────────

/**
 * A candidate event produced by {@link extractEventsFromMinutes}. Never auto-
 * committed — callers must render a confirmation UI first.
 */
export interface ExtractedEvent {
  title: string
  date: Date
  location: string | null
  /** `template` = structured `Nächstes Treffen:` field; `body` = free-text. */
  source: 'template' | 'body'
}

// Template field matches e.g.
//   Nächstes Treffen: 15.06.2026 14:00 Raum 101
//   Nächstes Treffen: 15-06-2026
const TEMPLATE_FIELD_RE =
  /N(?:ä|ae)chstes\s+Treffen\s*:\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})(?:\s+(\d{1,2}:\d{2}))?([^\r\n]*)/gi

// Body date scanner (fallback): German numeric DD.MM.YYYY [HH:MM] anywhere
// in the document. chrono-node is listed in the spec but not yet wired — a
// deterministic regex keeps the automation self-contained and testable.
const BODY_DATE_RE =
  /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?\b/g

function parseGermanDate(
  datePart: string,
  timePart: string | undefined,
): Date | null {
  const parts = datePart.split(/[.\-/]/)
  if (parts.length !== 3) return null
  let [day, month, year] = parts
  if (year.length === 2) year = '20' + year
  const iso =
    `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` +
    (timePart ? `T${timePart}:00` : 'T00:00:00')
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Extracts candidate events from free-text meeting minutes.
 *
 * Priority order (per design spec §2):
 *   1. Structured `Nächstes Treffen:` template field — title = "Nächstes Treffen"
 *   2. Free-text German numeric dates (DD.MM.YYYY)
 *
 * Deduplication: if a body date falls within 5 minutes of a template date it
 * is dropped so the UI shows each moment once.
 */
export function extractEventsFromMinutes(text: string): ExtractedEvent[] {
  const results: ExtractedEvent[] = []
  const seen = new Set<number>()

  // 1. Template fields
  TEMPLATE_FIELD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TEMPLATE_FIELD_RE.exec(text)) !== null) {
    const [, datePart, timePart, trailing] = match
    const date = parseGermanDate(datePart, timePart)
    if (!date) continue
    const ts = date.getTime()
    if (seen.has(ts)) continue
    seen.add(ts)
    results.push({
      title: 'Nächstes Treffen',
      date,
      location: trailing?.trim() ? trailing.trim() : null,
      source: 'template',
    })
  }

  // 2. Body numeric dates (deduped against templates within 5 min window)
  BODY_DATE_RE.lastIndex = 0
  while ((match = BODY_DATE_RE.exec(text)) !== null) {
    const [raw, d, m, y, hh, mm] = match
    const date = parseGermanDate(`${d}.${m}.${y}`, hh && mm ? `${hh}:${mm}` : undefined)
    if (!date) continue
    const ts = date.getTime()
    const dupe = [...seen].some((s) => Math.abs(s - ts) < 5 * 60 * 1000)
    if (dupe) continue
    seen.add(ts)
    // Slice surrounding context as a human-friendly title (≤ 100 chars).
    const start = Math.max(0, match.index - 40)
    const snippet = text.slice(start, match.index + raw.length + 20).replace(/\s+/g, ' ').trim()
    results.push({
      title: snippet.slice(0, 100) || 'Termin',
      date,
      location: null,
      source: 'body',
    })
  }

  return results
}

// ─── 3. German public holidays ────────────────────────────────────────────────

export interface HolidaySyncOptions {
  /** ISO 3166-1 alpha-2, always 'DE' for this integration. */
  countryCode: string
  /** Either 'DE' (federal) or 'DE-XX' for a specific Bundesland. */
  subdivisionCode: string
  /** Four-digit year to fetch. */
  year: number
}

interface OpenHolidayEntry {
  id: string
  name: Array<{ language: string; text: string }>
  startDate: string
  endDate: string
}

/**
 * Syncs German public holidays from the OpenHolidays public API into
 * calendar_events with source='holiday'. Idempotent on (source, external_id):
 * re-running the same year won't duplicate rows.
 */
export async function syncPublicHolidays(opts: HolidaySyncOptions): Promise<void> {
  const backend = getCalendarBackend()
  const { countryCode, subdivisionCode, year } = opts
  const url =
    `https://openholidaysapi.org/PublicHolidays` +
    `?countryIsoCode=${encodeURIComponent(countryCode)}` +
    `&subdivisionCode=${encodeURIComponent(subdivisionCode)}` +
    `&languageIsoCode=DE` +
    `&validFrom=${year}-01-01&validTo=${year}-12-31`

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`OpenHolidays API error: ${res.status}`)
  }

  const holidays = (await res.json()) as OpenHolidayEntry[]
  const types = await backend.listEventTypes()
  const holidayTypeId = types.find((t) => t.name === 'Feiertag')?.id ?? null

  for (const h of holidays) {
    const name =
      h.name.find((n) => n.language === 'DE')?.text ?? h.name[0]?.text ?? 'Feiertag'
    const startAt = new Date(h.startDate + 'T00:00:00Z')
    const endAt = new Date(h.endDate + 'T23:59:59Z')

    // Dedup against the SAME backend createEvent writes to. Under
    // CALENDAR_BACKEND=service the leaf owns the data plane, so a getDb() read
    // here would hit the WRONG database and duplicate every holiday; the port's
    // findEventByExternalId is backend-correct in both topologies.
    const existing = await backend.findEventByExternalId('holiday', h.id)
    if (existing) continue

    await backend.createEvent({
      title: name,
      description: null,
      location: null,
      startAt,
      endAt,
      allDay: true,
      eventTypeId: holidayTypeId,
      isMultiCommittee: false,
      createdBy: 'system',
      source: 'holiday' satisfies EventSource,
      externalId: h.id,
      committeeIds: [],
      recurrence: null,
    })
  }
}
