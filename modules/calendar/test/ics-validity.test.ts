// modules/calendar/test/ics-validity.test.ts
//
// F1-FIX-08-K / K4#21: the ICS pushed to Nextcloud must be valid and injection-free.
//   * RRULE BYDAY values were unvalidated strings written raw into the body
//     (CRLF / property injection).
//   * Lines were folded at 75 UTF-16 units, not 75 OCTETS, so any non-ASCII text
//     (German umlauts!) produced over-long, and possibly mid-codepoint, lines.

import { describe, it, expect } from 'vitest'
import { buildIcs, foldLine } from '../src/caldav/client.js'
import { RecurrenceSchema } from '../src/http/routes.js'

const base = {
  uid: 'u@stura',
  summary: 'S',
  description: null,
  location: null,
  dtstart: new Date('2026-05-04T14:00:00Z'),
  dtend: new Date('2026-05-04T15:00:00Z'),
  allDay: false,
}

describe('RRULE BYDAY is validated (K4#21)', () => {
  const rec = (byday: string[]) => ({
    frequency: 'weekly' as const,
    interval: 1,
    until: null,
    count: null,
    byday,
    exceptions: null,
  })

  it('accepts MO..SU with an optional ordinal', () => {
    for (const ok of ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU', '1MO', '-1SU', '+2FR']) {
      expect(RecurrenceSchema.safeParse({ frequency: 'monthly', byday: [ok] }).success, ok).toBe(true)
    }
  })

  it('rejects anything else at the API boundary (CRLF / property injection)', () => {
    for (const bad of ['MO\r\nATTACH:http://evil', 'MO;COUNT=9999', 'monday', 'XX', '', '99MO']) {
      expect(RecurrenceSchema.safeParse({ frequency: 'weekly', byday: [bad] }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('buildIcs refuses an invalid byday even if it bypassed the API (defence in depth)', () => {
    expect(() => buildIcs({ ...base, recurrence: rec(['MO\r\nATTACH:http://evil']) })).toThrow(/BYDAY/)
    const ics = buildIcs({ ...base, recurrence: rec(['MO', '-1FR']) })
    expect(ics).toContain('BYDAY=MO,-1FR')
    expect(ics).not.toContain('ATTACH')
  })
})

describe('foldLine folds at 75 OCTETS (K4#21)', () => {
  it('keeps ASCII behaviour: first line 75, continuations 74 + the leading space', () => {
    const folded = foldLine('SUMMARY:' + 'A'.repeat(200))
    const parts = folded.split('\r\n')
    expect(parts[0]!.length).toBe(75)
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true)
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe('SUMMARY:' + 'A'.repeat(200))
  })

  it('never exceeds 75 octets per physical line for multi-byte text, and round-trips', () => {
    const text = 'Sitzung für Öffentlichkeitsarbeit und Ökologie – Übergabe der Geschäftsführung ' + 'ä'.repeat(120)
    const line = 'SUMMARY:' + text
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8'), part).toBeLessThanOrEqual(75)
    }
    const unfolded = folded.replace(/\r\n /g, '')
    expect(unfolded).toBe(line)
  })

  it('never splits a surrogate pair (emoji)', () => {
    const line = 'SUMMARY:' + '😀'.repeat(60)
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75)
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(part.replace(/^ /, '')).not.toMatch(/^[\uDC00-\uDFFF]/)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line)
  })
})
