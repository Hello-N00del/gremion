// ensureConsumer (via start) against an in-memory JetStream manager: an existing durable whose config drifted
// is reconciled field by field (mutable: updated + logged; immutable: refused by name). The broker half is test/live.
import { AckPolicy, DeliverPolicy, JetStreamApiError } from '@nats-io/jetstream'
import { describe, expect, test } from 'vitest'
import { createConsumer } from '../src/consumer.ts'

const NS = 1_000_000
const base = () => ({
  name: 'c1', durable_name: 'c1', ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All,
  max_deliver: 5, max_ack_pending: 1, backoff: [1_000 * NS, 10_000 * NS, 60_000 * NS, 300_000 * NS], filter_subject: 'gremion.t1.org-unit.>',
}) as Record<string, unknown>

function run(existing: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = []
  const adds: unknown[] = []
  const logs: string[] = []
  const jsm = {
    consumers: {
      info: async () => {
        if (!existing) throw new JetStreamApiError({ code: 404, err_code: 10014, description: 'consumer not found' })
        return { config: existing }
      },
      update: async (_s: string, _n: string, u: Record<string, unknown>) => void updates.push(u),
      add: async (_s: string, c: unknown) => void adds.push(c),
    },
  }
  const js = { consumers: { get: async () => ({ consume: async () => ({ close: async () => undefined, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) }) }, publish: async () => ({}) }
  const c = createConsumer({
    sql: {} as never, ctx: 'fin', tenant: 't1', module: 'finance', js: js as never, jsm: jsm as never, stream: 'ORGUNIT', name: 'c1',
    filterSubject: 'gremion.t1.org-unit.>', handler: async () => {}, log: (l) => logs.push(l), onError: () => {}, ...over,
  })
  return { start: () => c.start().then(() => c.stop()), updates, adds, logs }
}

describe('ensureConsumer reconciles an existing durable', () => {
  test('a matching durable is left alone (no update, no add)', async () => {
    const r = run(base())
    await r.start()
    expect(r.updates).toEqual([])
    expect(r.adds).toEqual([])
  })

  test('drifted max_deliver, backoff, filter_subject and max_ack_pending are all updated and logged', async () => {
    const r = run({ ...base(), max_deliver: 9, backoff: [5 * NS], filter_subject: 'gremion.t1.other.>', max_ack_pending: 10 })
    await r.start()
    expect(r.updates).toEqual([{ max_ack_pending: 1, max_deliver: 5, backoff: [1_000 * NS, 10_000 * NS, 60_000 * NS, 300_000 * NS], filter_subject: 'gremion.t1.org-unit.>' }])
    const line = r.logs.join('\n')
    for (const f of ['max_ack_pending', 'max_deliver', 'backoff', 'filter_subject']) expect(line).toContain(f)
  })

  test('a changed filter alone is updated (it was silently ignored before)', async () => {
    const r = run({ ...base(), filter_subject: 'gremion.t1.old.>' })
    await r.start()
    expect(r.updates).toEqual([{ filter_subject: 'gremion.t1.org-unit.>' }])
  })

  test('dropping the filter sends the empty filter', async () => {
    const r = run(base(), { filterSubject: undefined })
    await r.start()
    expect(r.updates).toEqual([{ filter_subject: '' }])
  })

  test('a changed maxDeliver option is updated', async () => {
    const r = run(base(), { maxDeliver: 6 })
    await r.start()
    expect(r.updates).toEqual([{ max_deliver: 6 }])
  })

  test('a different ack_policy is refused naming the field, nothing is updated', async () => {
    const r = run({ ...base(), ack_policy: AckPolicy.None, max_deliver: 9 })
    await expect(r.start()).rejects.toThrow(/ack_policy is none/)
    expect(r.updates).toEqual([])
  })

  test('a different deliver_policy is refused naming the field, nothing is updated', async () => {
    const r = run({ ...base(), deliver_policy: DeliverPolicy.New, max_deliver: 9 })
    await expect(r.start()).rejects.toThrow(/deliver_policy is new/)
    expect(r.updates).toEqual([])
  })

  test('a multi-filter durable is refused', async () => {
    const r = run({ ...base(), filter_subject: undefined, filter_subjects: ['a.>', 'b.>'] })
    await expect(r.start()).rejects.toThrow(/filter_subjects/)
  })

  test('no existing durable: it is created with the full config', async () => {
    const r = run(undefined)
    await r.start()
    expect(r.updates).toEqual([])
    expect(r.adds).toEqual([expect.objectContaining({ name: 'c1', max_deliver: 5, max_ack_pending: 1, filter_subject: 'gremion.t1.org-unit.>', ack_policy: AckPolicy.Explicit })])
  })
})
