// packages/ports/src/nats-topology.test.ts
//
// WP-A: JetStream stream TOPOLOGY tests — dependency-free (node:crypto only),
// NO live NATS. Runs via `pnpm --filter @gremion/ports test` AND through
// gremion-ui's vitest (the `../packages/ports/src/**/*.test.ts` include glob), so
// it imports ONLY from ./broker (never ./nats-broker, which pulls the `nats`
// library that must not load under the jsdom monolith run).
//
// Proves the one thing WP-A parametrizes: each event DOMAIN has its OWN stream
// whose subject filter captures ONLY that domain's subjects. Before WP-A the
// content/calendar leaves + their monolith consumers all defaulted to the single
// NEWSLETTER stream (streamName = DEFAULT_STREAM, ensureStream() default subjects),
// so a content/calendar subject could never land in a matching stream. The
// disjoint-routing block below is the reference proof that content/calendar/
// newsletter subjects route to three DIFFERENT stream filters via the SAME '>'
// wildcard semantics the existing newsletter parity block relies on.

import { describe, it, expect } from 'vitest'
import {
  STREAMS,
  DEFAULT_STREAM,
  InMemoryBroker,
  makeEnvelope,
  newsletterSubject,
  contentSubject,
  calendarSubject,
  orgUnitSubject,
} from './broker'
import type { NewsletterEvent, ContentEvent, CalendarEvent, OrgUnitEvent } from './broker'

// Enumerate EVERY event of each domain. Typed against the shared union so that
// adding/removing a union member breaks compilation here (same convention as
// content-contract.test.ts) — the routing proof therefore covers the full set.
const NEWSLETTER_EVENTS: NewsletterEvent[] = ['send.succeeded', 'send.failed']
const CONTENT_EVENTS: ContentEvent[] = [
  'publish.succeeded',
  'publish.failed',
  'channel.email.sent',
  'channel.portal.sent',
  'channel.instagram.enqueued',
]
const CALENDAR_EVENTS: CalendarEvent[] = [
  'event.created',
  'event.updated',
  'event.deleted',
  'caldav.sync.failed',
]
const ORGUNIT_EVENTS: OrgUnitEvent[] = ['upserted', 'deleted']

const TENANT = 'topology-tenant'

// ── Byte-identity pins: WP-A must NOT touch the newsletter topology ──────────
describe('STREAMS topology — newsletter byte-identity pins', () => {
  it('STREAMS.NEWSLETTER is exactly {name:NEWSLETTER, subjects:[gremion.*.newsletter.>]}', () => {
    expect(STREAMS.NEWSLETTER).toEqual({
      name: 'NEWSLETTER',
      subjects: ['gremion.*.newsletter.>'],
    })
  })

  it('DEFAULT_STREAM is still NEWSLETTER (the first-leaf default)', () => {
    expect(DEFAULT_STREAM).toBe('NEWSLETTER')
  })

  it('CONTENT and CALENDAR descriptors carry their own name + domain subjects', () => {
    expect(STREAMS.CONTENT).toEqual({ name: 'CONTENT', subjects: ['gremion.*.content.>'] })
    expect(STREAMS.CALENDAR).toEqual({ name: 'CALENDAR', subjects: ['gremion.*.calendar.>'] })
  })

  it('ORGUNIT descriptor (Lane E1) carries its own name + domain subjects', () => {
    expect(STREAMS.ORGUNIT).toEqual({ name: 'ORGUNIT', subjects: ['gremion.*.org-unit.>'] })
  })
})

// ── Disjoint subject → stream routing (InMemoryBroker reference semantics) ────
//
// One InMemoryBroker per check, with one subscription per stream descriptor
// filter (STREAMS.X.subjects[0]). For every domain event, its subject MUST be
// received by ONLY its own domain's filter and by NEITHER of the other two.
describe('STREAMS topology — every domain subject lands ONLY in its own stream filter', () => {
  /** Publish `subject` and return which stream filters received it, using the
   *  same '>' wildcard semantics as the existing newsletter parity block. */
  async function landingStreams(subject: string): Promise<string[]> {
    const broker = new InMemoryBroker()
    const hits: string[] = []
    broker.subscribe(STREAMS.NEWSLETTER.subjects[0], async () => {
      hits.push('NEWSLETTER')
    })
    broker.subscribe(STREAMS.CONTENT.subjects[0], async () => {
      hits.push('CONTENT')
    })
    broker.subscribe(STREAMS.CALENDAR.subjects[0], async () => {
      hits.push('CALENDAR')
    })
    broker.subscribe(STREAMS.ORGUNIT.subjects[0], async () => {
      hits.push('ORGUNIT')
    })
    await broker.publish(
      subject,
      makeEnvelope({ eventType: 'routing-probe', tenantId: TENANT, correlationId: null, payload: {} }),
    )
    return hits
  }

  it('every newsletter subject lands ONLY in the NEWSLETTER filter', async () => {
    for (const event of NEWSLETTER_EVENTS) {
      const subject = newsletterSubject(TENANT, event)
      expect(await landingStreams(subject)).toEqual(['NEWSLETTER'])
    }
  })

  it('every content subject lands ONLY in the CONTENT filter', async () => {
    for (const event of CONTENT_EVENTS) {
      const subject = contentSubject(TENANT, event)
      expect(await landingStreams(subject)).toEqual(['CONTENT'])
    }
  })

  it('every calendar subject lands ONLY in the CALENDAR filter', async () => {
    for (const event of CALENDAR_EVENTS) {
      const subject = calendarSubject(TENANT, event)
      expect(await landingStreams(subject)).toEqual(['CALENDAR'])
    }
  })

  it('every org-unit subject lands ONLY in the ORGUNIT filter (disjoint from the other three)', async () => {
    for (const event of ORGUNIT_EVENTS) {
      const subject = orgUnitSubject(TENANT, event)
      expect(await landingStreams(subject)).toEqual(['ORGUNIT'])
    }
  })

  it('no newsletter/content/calendar subject ever lands in the ORGUNIT filter', async () => {
    const foreign = [
      ...NEWSLETTER_EVENTS.map((e) => newsletterSubject(TENANT, e)),
      ...CONTENT_EVENTS.map((e) => contentSubject(TENANT, e)),
      ...CALENDAR_EVENTS.map((e) => calendarSubject(TENANT, e)),
    ]
    for (const subject of foreign) {
      expect(await landingStreams(subject)).not.toContain('ORGUNIT')
    }
  })
})
