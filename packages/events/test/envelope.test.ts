// TDD 4 (unit half) and TDD 16: the wire contract. A message missing any required header is
// envelope_invalid; the body, the headers and the trace hop are consistent.
import { describe, expect, test } from 'vitest'
import { bodyOf, correlationOf, H, headersOf, parseEnvelope, REQUIRED_HEADERS, type OutboxRow } from '../src/envelope.ts'

const ROW: OutboxRow = {
  event_id: '019f2f0a-0000-7000-8000-000000000001',
  customer_id: '019f2f0a-0000-7000-8000-0000000000aa',
  event_type: 'de.gremion.idt.orgunit.created.v1',
  source: '/gremion/idt',
  subject: null,
  event_time: new Date('2026-10-05T12:00:00.000Z'),
  data: { orgUnitId: '019f2f0a-0000-7000-8000-0000000000bb', aggregate_version: 1 },
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  aggregate_type: 'orgunit',
  aggregate_id: '019f2f0a-0000-7000-8000-0000000000bb',
  aggregate_version: '1',
  test_run_id: null,
}

const wire = (row: OutboxRow = ROW) => ({ hdrs: headersOf(row), data: new TextEncoder().encode(JSON.stringify(bodyOf(row))) })
const parse = (hdrs: Record<string, string>, data: Uint8Array) => parseEnvelope((n) => hdrs[n], data)

describe('stable identity (TRD-422)', () => {
  test('outbox.event_id = body eventId = Gremion-Event-Id = Nats-Msg-Id', () => {
    const { hdrs } = wire()
    expect(bodyOf(ROW).eventId).toBe(ROW.event_id)
    expect(hdrs[H.eventId]).toBe(ROW.event_id)
    expect(hdrs[H.msgId]).toBe(ROW.event_id)
  })

  test('the body is today EventEnvelope shape (TASK-189 dual-read legacy)', () => {
    expect(Object.keys(bodyOf(ROW)).sort()).toEqual(['correlationId', 'eventId', 'eventType', 'occurredAt', 'payload', 'tenantId'])
    expect(bodyOf(ROW).tenantId).toBe(ROW.customer_id)
    expect(bodyOf(ROW).payload).toEqual(ROW.data)
  })
})

describe('the Q6 headers', () => {
  test('every relayed message carries the required headers', () => {
    const { hdrs } = wire()
    for (const h of REQUIRED_HEADERS) expect(hdrs[h], h).toBeTruthy()
    expect(hdrs[H.source]).toBe('/gremion/idt')
    expect(hdrs[H.aggregateType]).toBe('orgunit')
    expect(hdrs[H.aggregateVersion]).toBe('1')
  })

  test('TDD 16: traceparent is the outbox value; a null value adds no header', () => {
    expect(wire().hdrs[H.traceparent]).toBe(ROW.traceparent)
    expect(correlationOf(ROW.traceparent)).toBe('0af7651916cd43dd8448eb211c80319c')
    const none = wire({ ...ROW, traceparent: null }).hdrs
    expect(H.traceparent in none).toBe(false)
    expect(bodyOf({ ...ROW, traceparent: null }).correlationId).toBeNull()
  })

  test('Gremion-Test-Run-Id only when the row has one', () => {
    expect(H.testRunId in wire().hdrs).toBe(false)
    expect(wire({ ...ROW, test_run_id: '019f2f0a-0000-7000-8000-0000000000cc' }).hdrs[H.testRunId]).toBe('019f2f0a-0000-7000-8000-0000000000cc')
  })
})

describe('parseEnvelope (TDD 4): a message missing one header is envelope_invalid, never applied', () => {
  test('the intact message parses, with the trace and test-run carried to the handler', () => {
    const r = parse(wire().hdrs, wire().data)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.event.eventId).toBe(ROW.event_id)
      expect(r.event.sourceContext).toBe('idt')
      expect(r.event.aggregate).toEqual({ type: 'orgunit', id: ROW.aggregate_id, version: 1 })
      expect(r.event.traceparent).toBe(ROW.traceparent)
    }
  })

  test.each([...REQUIRED_HEADERS])('without %s', (missing) => {
    const { hdrs, data } = wire()
    delete hdrs[missing]
    const r = parse(hdrs, data)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.reason).toContain(missing)
  })

  test('the inbox key ignores Nats-Msg-Id: a replay msg id does not change the parsed key', () => {
    const { hdrs, data } = wire()
    const a = parse(hdrs, data)
    const b = parse({ ...hdrs, [H.msgId]: `${ROW.event_id}.r7` }, data)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect([b.event.source, b.event.eventId]).toEqual([a.event.source, a.event.eventId])
    }
  })

  test.each([
    ['body eventId differs from the header', (h: Record<string, string>) => ({ ...h, [H.eventId]: '019f2f0a-0000-7000-8000-0000000000ff' })],
    ['a source that is not /gremion/<ctx>', (h: Record<string, string>) => ({ ...h, [H.source]: 'idt' })],
    ['a non-uuid aggregate id', (h: Record<string, string>) => ({ ...h, [H.aggregateId]: 'x' })],
    ['a zero aggregate version', (h: Record<string, string>) => ({ ...h, [H.aggregateVersion]: '0' })],
    ['a malformed traceparent', (h: Record<string, string>) => ({ ...h, [H.traceparent]: 'nope' })],
  ])('%s', (_name, mutate) => {
    const { hdrs, data } = wire()
    expect(parse(mutate(hdrs), data).ok).toBe(false)
  })

  test('a body that is not JSON, or has no payload object, is invalid', () => {
    const { hdrs } = wire()
    expect(parse(hdrs, new TextEncoder().encode('not json')).ok).toBe(false)
    const noPayload = { ...bodyOf(ROW), payload: null }
    expect(parse(hdrs, new TextEncoder().encode(JSON.stringify(noPayload))).ok).toBe(false)
  })
})
