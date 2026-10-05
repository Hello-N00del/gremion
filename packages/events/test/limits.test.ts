// The delivery limits (Q3), the gauges' text (Q13) and the producer's refusals, all without a database.
import { describe, expect, test } from 'vitest'
import { assertConsumerLimits, CONSUMER_BACKOFF_MS, CONSUMER_MAX_DELIVER, nakDelayMs, RELAY_MAX_ATTEMPTS, relayBackoffMs } from '../src/backoff.ts'
import { enqueue, EnqueueError, isTransaction } from '../src/enqueue.ts'
import { renderMetrics } from '../src/metrics.ts'
import type { Sql } from '@gremion/db'

describe('limits (Q3)', () => {
  test('consumer MaxDeliver 5 with BackOff [1 s, 10 s, 60 s, 300 s]; NATS needs BackOff length <= MaxDeliver', () => {
    expect(CONSUMER_MAX_DELIVER).toBe(5)
    expect([...CONSUMER_BACKOFF_MS]).toEqual([1000, 10_000, 60_000, 300_000])
    expect(() => assertConsumerLimits(CONSUMER_MAX_DELIVER, CONSUMER_BACKOFF_MS)).not.toThrow()
    expect(() => assertConsumerLimits(3, CONSUMER_BACKOFF_MS)).toThrow(/BackOff length <= MaxDeliver/)
    expect(() => assertConsumerLimits(5, [])).toThrow()
  })

  test('the nak delay follows the BackOff and repeats its last entry', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => nakDelayMs(n))).toEqual([1000, 10_000, 60_000, 300_000, 300_000, 300_000])
    expect(() => nakDelayMs(0)).toThrow(RangeError)
  })

  test('relay: 10 attempts at min(2^n s, 1 h)', () => {
    expect(RELAY_MAX_ATTEMPTS).toBe(10)
    expect([1, 2, 3, 10, 11, 40].map(relayBackoffMs)).toEqual([2000, 4000, 8000, 1_024_000, 2_048_000, 3_600_000])
    expect(() => relayBackoffMs(0)).toThrow(RangeError)
  })
})

describe('gauges as OpenMetrics 1.0 text (Q13)', () => {
  test('the three gauges, labelled, ending in # EOF', () => {
    const text = renderMetrics({ ctx: 'fin', consumer: 'finance', outboxDeadLettered: 0, inboxDeadLettered: 2, inboxStalled: 1 })
    expect(text).toContain('# TYPE gremion_outbox_dead_lettered gauge')
    expect(text).toContain('gremion_outbox_dead_lettered{ctx="fin"} 0')
    expect(text).toContain('gremion_inbox_dead_lettered{ctx="fin",consumer="finance"} 2')
    expect(text).toContain('gremion_inbox_stalled{ctx="fin",consumer="finance"} 1')
    expect(text.endsWith('# EOF\n')).toBe(true)
  })

  test('several databases share one family block', () => {
    const text = renderMetrics([
      { ctx: 'idt', consumer: 'idt', outboxDeadLettered: 1, inboxDeadLettered: 0, inboxStalled: 0 },
      { ctx: 'gov', consumer: 'gov', outboxDeadLettered: 0, inboxDeadLettered: 0, inboxStalled: 0 },
    ])
    expect(text.match(/# TYPE gremion_outbox_dead_lettered/g)).toHaveLength(1)
    expect(text).toContain('gremion_outbox_dead_lettered{ctx="idt"} 1')
    expect(text).toContain('gremion_outbox_dead_lettered{ctx="gov"} 0')
  })

  test('a label value is escaped', () => {
    expect(renderMetrics({ ctx: 'fin', consumer: 'a"b\\c', outboxDeadLettered: 0, inboxDeadLettered: 0, inboxStalled: 0 })).toContain('consumer="a\\"b\\\\c"')
  })
})

describe('enqueue refuses a non-transaction handle (TRD-422)', () => {
  const input = {
    eventType: 'de.gremion.idt.orgunit.created.v1',
    source: '/gremion/idt',
    aggregate: { type: 'orgunit', id: '019f2f0a-0000-7000-8000-0000000000bb', version: 1 },
    data: { orgUnitId: '019f2f0a-0000-7000-8000-0000000000bb' },
  }

  test('a pool (no savepoint) is refused before any statement', async () => {
    const calls: string[] = []
    const pool = Object.assign(() => undefined, { unsafe: async (q: string) => void calls.push(q), begin: () => undefined })
    expect(isTransaction(pool)).toBe(false)
    await expect(enqueue(pool as unknown as Sql, input)).rejects.toThrow(EnqueueError)
    expect(calls).toEqual([])
  })

  test('a handle with savepoint passes the structural check, and a bad source or version is refused', async () => {
    const tx = Object.assign(() => undefined, { savepoint: () => undefined, unsafe: async () => [{ event_id: 'x' }] })
    expect(isTransaction(tx)).toBe(true)
    await expect(enqueue(tx as unknown as Sql, { ...input, source: 'idt' })).rejects.toThrow(/not \/gremion/)
    await expect(enqueue(tx as unknown as Sql, { ...input, aggregate: { ...input.aggregate, version: 0 } })).rejects.toThrow(/positive integer/)
    await expect(enqueue(tx as unknown as Sql, { ...input, data: { aggregate_version: 7 } })).rejects.toThrow(/disagrees/)
    await expect(enqueue(tx as unknown as Sql, input)).resolves.toBe('x')
  })

  test('no gremion.customer_id in the transaction is a named error, not a NOT NULL violation', async () => {
    const tx = Object.assign(() => undefined, { savepoint: () => undefined, unsafe: async () => [] })
    await expect(enqueue(tx as unknown as Sql, input)).rejects.toThrow(/gremion\.customer_id is not set/)
  })
})
