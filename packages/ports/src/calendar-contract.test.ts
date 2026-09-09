// packages/ports/src/calendar-contract.test.ts
// Task 9: calendar AsyncAPI contract pinned to calendarSubject().
// Mirrors the newsletter AsyncAPI contract-tie pattern (contracts-newsletter-specs.test.ts,
// D-P1-7) but scoped to the dependency-free @gremion/ports package: one channel per
// CalendarEvent, parameterized on {tenantId}, asserting the channel address ends with
// `.calendar.${event}` AND equals calendarSubject('{tenantId}', event) exactly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calendarSubject, type CalendarEvent } from './broker'

const portsRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(portsRoot, '..', '..')
const contractPath = join(repoRoot, 'contracts', 'calendar', 'asyncapi.calendar.json')

const doc = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  asyncapi: string
  info: { version: string }
  channels: Record<string, { address: string }>
  operations: Record<string, { action: string }>
}

const EVENTS: CalendarEvent[] = ['event.created', 'event.updated', 'event.deleted', 'caldav.sync.failed']

describe('calendar AsyncAPI contract', () => {
  it('is structurally present (AsyncAPI 3.0)', () => {
    expect(doc.asyncapi).toBe('3.0.0')
  })

  it('has one channel per CalendarEvent, ending with `.calendar.${event}`', () => {
    const channels = Object.values(doc.channels)
    for (const ev of EVENTS) {
      const match = channels.some((c) => c.address.endsWith(`.calendar.${ev}`))
      expect(match, `no channel address ends with .calendar.${ev}`).toBe(true)
    }
  })

  // Contract↔runtime tie (same pattern as D-P1-7): each channel address MUST equal
  // the output of calendarSubject() for the corresponding event. Drift between the
  // spec and the wire helper fails here, not at runtime.
  it('channel addresses equal calendarSubject({tenantId}, event) for every CalendarEvent', () => {
    for (const ev of EVENTS) {
      const expected = calendarSubject('{tenantId}', ev)
      const match = Object.values(doc.channels).find((c) => c.address === expected)
      expect(
        match,
        `No AsyncAPI channel has address "${expected}" — calendarSubject('{tenantId}', '${ev}') drift`,
      ).toBeDefined()
    }
  })

  it('has publish operations for the calendar events', () => {
    const sends = Object.values(doc.operations).filter((op) => op.action === 'send')
    expect(sends.length).toBeGreaterThanOrEqual(EVENTS.length)
  })
})
