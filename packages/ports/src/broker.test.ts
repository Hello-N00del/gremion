// packages/ports/src/broker.test.ts
import { describe, it, expect } from 'vitest'
import {
  InMemoryBroker,
  provisioningSubject,
  newsletterSubject,
  calendarSubject,
  contentSubject,
  orgUnitSubject,
  makeEnvelope,
  type EventEnvelope,
  type NewsletterEvent,
  type CalendarEvent,
  type OrgUnitEvent,
} from './broker'

describe('provisioningSubject', () => {
  it('builds the AsyncAPI subject grammar (tenant-first)', () => {
    expect(provisioningSubject('default', 'org-unit', 'succeeded'))
      .toBe('gremion.default.provisioning.org-unit.succeeded')
  })
})

describe('newsletterSubject', () => {
  it('builds the newsletter subject grammar (tenant-first), the single source of the wire subject', () => {
    expect(newsletterSubject('default', 'send.succeeded'))
      .toBe('gremion.default.newsletter.send.succeeded')
    expect(newsletterSubject('t1', 'send.failed'))
      .toBe('gremion.t1.newsletter.send.failed')
  })
  it('accepts exactly the NewsletterEvent short pair (never a newsletter.-prefixed long form)', () => {
    const events: NewsletterEvent[] = ['send.succeeded', 'send.failed']
    for (const ev of events) {
      // The event token must remain the short pair so the emitted subject is the
      // 5-token gremion.<t>.newsletter.<send.x>, NOT gremion.<t>.newsletter.newsletter.send.x
      expect(newsletterSubject('default', ev)).toBe(`gremion.default.newsletter.${ev}`)
      expect(newsletterSubject('default', ev).split('.')).toHaveLength(5)
    }
  })
})

describe('calendarSubject', () => {
  it('builds the calendar subject grammar (tenant-first), the single source of the wire subject', () => {
    expect(calendarSubject('default', 'event.created'))
      .toBe('gremion.default.calendar.event.created')
    expect(calendarSubject('t1', 'caldav.sync.failed'))
      .toBe('gremion.t1.calendar.caldav.sync.failed')
  })
  it('accepts exactly the CalendarEvent set (token count >= 5)', () => {
    const events: CalendarEvent[] = ['event.created', 'event.updated', 'event.deleted', 'caldav.sync.failed']
    for (const ev of events) {
      expect(calendarSubject('default', ev)).toBe(`gremion.default.calendar.${ev}`)
      expect(calendarSubject('default', ev).split('.').length).toBeGreaterThanOrEqual(5)
    }
  })
})

describe('contentSubject', () => {
  it('builds the 5-token content subject', () => {
    expect(contentSubject('default', 'publish.succeeded')).toBe('gremion.default.content.publish.succeeded')
    expect(contentSubject('t1', 'channel.portal.sent').split('.').length).toBeGreaterThanOrEqual(5)
  })
})

describe('orgUnitSubject', () => {
  it('builds the 4-token org-unit subject grammar (tenant-first), the single source of the wire subject', () => {
    expect(orgUnitSubject('default', 'upserted')).toBe('gremion.default.org-unit.upserted')
    expect(orgUnitSubject('t1', 'deleted')).toBe('gremion.t1.org-unit.deleted')
  })
  it('accepts exactly the OrgUnitEvent pair and stays DISJOINT from the 5-token provisioning grammar', () => {
    const events: OrgUnitEvent[] = ['upserted', 'deleted']
    for (const ev of events) {
      expect(orgUnitSubject('default', ev)).toBe(`gremion.default.org-unit.${ev}`)
      // 4 tokens: gremion / <tenant> / org-unit / <event>
      expect(orgUnitSubject('default', ev).split('.')).toHaveLength(4)
    }
    // The domain token is `org-unit`, NOT `provisioning` — so an org-unit subject can
    // never collide with gremion.<t>.provisioning.org-unit.<event>.
    expect(orgUnitSubject('default', 'upserted').split('.')[2]).toBe('org-unit')
    expect(provisioningSubject('default', 'org-unit', 'succeeded').split('.')[2]).toBe('provisioning')
  })
})

describe('makeEnvelope', () => {
  it('fills id/timestamp and carries tenant + correlation', () => {
    const e = makeEnvelope({ eventType: 'org-unit.succeeded', tenantId: 'default', correlationId: 'abc', payload: { x: 1 } })
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(e.occurredAt)).not.toBeNaN()
    expect(e.tenantId).toBe('default')
    expect(e.correlationId).toBe('abc')
  })
})

describe('InMemoryBroker', () => {
  it('delivers published events to matching subscribers', async () => {
    const b = new InMemoryBroker()
    const got: Array<{ e: EventEnvelope; subject: string }> = []
    b.subscribe('gremion.default.provisioning.*.*', async (e, subject) => { got.push({ e, subject }) })
    const env = makeEnvelope({ eventType: 'member.failed', tenantId: 'default', correlationId: null, payload: {} })
    await b.publish(provisioningSubject('default', 'member', 'failed'), env)
    expect(got).toHaveLength(1)
    expect(got[0].subject).toBe('gremion.default.provisioning.member.failed')
    expect(got[0].e.eventId).toBe(env.eventId)
  })
  it('wildcard tokens match exactly one token (NATS semantics)', async () => {
    const b = new InMemoryBroker()
    let hits = 0
    b.subscribe('gremion.*.provisioning.org-unit.failed', async () => { hits++ })
    await b.publish('gremion.t1.provisioning.org-unit.failed', makeEnvelope({ eventType: 'x', tenantId: 't1', correlationId: null, payload: {} }))
    await b.publish('gremion.t1.t2.provisioning.org-unit.failed', makeEnvelope({ eventType: 'x', tenantId: 't1', correlationId: null, payload: {} }))
    expect(hits).toBe(1)
  })
  it('unsubscribe stops delivery; publish with no subscribers records to the log', async () => {
    const b = new InMemoryBroker()
    let hits = 0
    const sub = b.subscribe('a.b', async () => { hits++ })
    sub.unsubscribe()
    await b.publish('a.b', makeEnvelope({ eventType: 'x', tenantId: 'default', correlationId: null, payload: {} }))
    expect(hits).toBe(0)
    expect(b.published).toHaveLength(1) // test-introspection log
  })

  describe("'>' multi-token wildcard (P1 newsletter consumer subscribes gremion.*.newsletter.>)", () => {
    it('matches the 5-token newsletter subject built by newsletterSubject', async () => {
      const b = new InMemoryBroker()
      const got: string[] = []
      b.subscribe('gremion.*.newsletter.>', async (_e, subject) => { got.push(subject) })
      await b.publish(newsletterSubject('t1', 'send.succeeded'), makeEnvelope({ eventType: 'send.succeeded', tenantId: 't1', correlationId: null, payload: {} }))
      expect(got).toEqual(['gremion.t1.newsletter.send.succeeded'])
    })
    it("'>' matches one-or-more remaining tokens (4-token AND 5-token)", async () => {
      const b = new InMemoryBroker()
      const got: string[] = []
      b.subscribe('gremion.*.newsletter.>', async (_e, subject) => { got.push(subject) })
      // 4-token: one remaining token after the prefix
      await b.publish('gremion.t1.newsletter.x', makeEnvelope({ eventType: 'x', tenantId: 't1', correlationId: null, payload: {} }))
      // 5-token: two remaining tokens after the prefix
      await b.publish('gremion.t1.newsletter.send.succeeded', makeEnvelope({ eventType: 'send.succeeded', tenantId: 't1', correlationId: null, payload: {} }))
      expect(got).toEqual(['gremion.t1.newsletter.x', 'gremion.t1.newsletter.send.succeeded'])
    })
    it("'>' requires at least one remaining token — does NOT match the bare prefix", async () => {
      const b = new InMemoryBroker()
      let hits = 0
      b.subscribe('gremion.*.newsletter.>', async () => { hits++ })
      // The 3-token prefix has ZERO tokens left for '>' to consume.
      await b.publish('gremion.t1.newsletter', makeEnvelope({ eventType: 'x', tenantId: 't1', correlationId: null, payload: {} }))
      expect(hits).toBe(0)
    })
    it("'>' is valid ONLY as the final pattern token — a non-final '>' matches nothing", async () => {
      const b = new InMemoryBroker()
      let hits = 0
      // '>' not in final position is rejected/ignored (never matches).
      b.subscribe('gremion.>.newsletter.send.succeeded', async () => { hits++ })
      await b.publish('gremion.t1.newsletter.send.succeeded', makeEnvelope({ eventType: 'send.succeeded', tenantId: 't1', correlationId: null, payload: {} }))
      expect(hits).toBe(0)
    })
  })
})
