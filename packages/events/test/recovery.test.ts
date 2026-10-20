// replayDeadLetter / listDeadLetters against an in-memory stream double (the real broker half is
// test/live): the entry is deleted ONLY after the PubAck, advisory entries are fetched by stream_seq.
import { describe, expect, test } from 'vitest'
import { H } from '../src/envelope.ts'
import { ADVISORY_PREFIX, listDeadLetters, RecoveryError, replayDeadLetter } from '../src/recovery.ts'

const hdr = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? '', keys: () => Object.keys(m) })
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
const EVENT = '019f2f0a-0000-7000-8000-000000000001'

interface Stored {
  seq: number
  subject: string
  header: ReturnType<typeof hdr>
  data: Uint8Array
  time: Date
}

function double(streams: Record<string, Stored[]>) {
  const deleted: [string, number][] = []
  const jsm = {
    streams: {
      info: async (s: string) => {
        const l = streams[s] ?? []
        return { state: { messages: l.length, first_seq: l[0]?.seq ?? 0, last_seq: l.at(-1)?.seq ?? 0 } }
      },
      getMessage: async (s: string, q: { seq: number }) => (streams[s] ?? []).find((m) => m.seq === q.seq) ?? null,
      deleteMessage: async (s: string, seq: number) => {
        deleted.push([s, seq])
        return true
      },
    },
  }
  const published: { subject: string; data: Uint8Array; opts: { msgID: string; headers: { keys(): string[]; get(k: string): string } } }[] = []
  let failPublish = false
  const js = {
    publish: async (subject: string, data: Uint8Array, opts: never) => {
      if (failPublish) throw new Error('no responders')
      published.push({ subject, data, opts })
      return { stream: 'ORGUNIT', seq: 99, duplicate: false }
    },
  }
  return { jsm: jsm as never, js: js as never, deleted, published, failNext: () => (failPublish = true) }
}

const consumerEntry = (seq: number): Stored => ({
  seq,
  subject: 'gremion.t1.dlq.finance.fin-consumer',
  header: hdr({
    [H.eventId]: EVENT,
    [H.source]: '/gremion/idt',
    [H.msgId]: 'dlq-own-id',
    [H.dlqOrigSubject]: 'gremion.t1.org-unit.created',
    [H.dlqStream]: 'ORGUNIT',
    [H.dlqSeq]: '41',
    [H.dlqConsumer]: 'fin-consumer',
    [H.dlqError]: 'handler_error',
    [H.dlqOrigMsgId]: EVENT,
  }),
  data: enc({ eventId: EVENT }),
  time: new Date('2026-10-05T12:00:00Z'),
})

const advisoryEntry = (seq: number): Stored => ({
  seq,
  subject: `${ADVISORY_PREFIX}ORGUNIT.fin-consumer`,
  header: hdr({}),
  data: enc({ stream: 'ORGUNIT', consumer: 'fin-consumer', stream_seq: 41, deliveries: 5 }),
  time: new Date('2026-10-05T12:00:00Z'),
})

describe('listDeadLetters', () => {
  test('names consumer and advisory entries', async () => {
    const d = double({ DLQ: [consumerEntry(1), advisoryEntry(2)] })
    const list = await listDeadLetters(d.jsm)
    expect(list.map((e) => [e.seq, e.kind, e.eventId, e.error, e.origSubject, e.streamSeq])).toEqual([
      [1, 'consumer', EVENT, 'handler_error', 'gremion.t1.org-unit.created', 41],
      [2, 'advisory', undefined, 'max_deliveries', undefined, 41],
    ])
  })

  test('an empty DLQ lists nothing', async () => {
    expect(await listDeadLetters(double({ DLQ: [] }).jsm)).toEqual([])
  })
})

describe('replayDeadLetter', () => {
  test('a consumer entry republishes the body to its original subject under <event_id>.r<dlq_seq>, then deletes it', async () => {
    const d = double({ DLQ: [consumerEntry(7)] })
    const r = await replayDeadLetter(d.jsm, d.js, { seq: 7, log: () => {} })
    expect(r).toMatchObject({ kind: 'consumer', republishedTo: 'gremion.t1.org-unit.created', msgId: `${EVENT}.r7` })
    expect(d.published).toHaveLength(1)
    expect(d.published[0]!.subject).toBe('gremion.t1.org-unit.created')
    expect(d.published[0]!.opts.msgID).toBe(`${EVENT}.r7`)
    const sent = d.published[0]!.opts.headers
    expect(sent.get(H.eventId)).toBe(EVENT)
    expect(sent.get(H.msgId)).toBe(`${EVENT}.r7`)
    for (const k of sent.keys()) expect(k.startsWith('Gremion-Dlq-')).toBe(false)
    expect(d.deleted).toEqual([['DLQ', 7]])
  })

  test('a failed publish deletes NOTHING (the entry survives for another attempt)', async () => {
    const d = double({ DLQ: [consumerEntry(7)] })
    d.failNext()
    await expect(replayDeadLetter(d.jsm, d.js, { seq: 7, log: () => {} })).rejects.toThrow(/no responders/)
    expect(d.deleted).toEqual([])
  })

  test('an advisory entry fetches the original by stream_seq and republishes it', async () => {
    const original: Stored = {
      seq: 41,
      subject: 'gremion.t1.org-unit.created',
      header: hdr({ [H.eventId]: EVENT, [H.source]: '/gremion/idt', [H.msgId]: EVENT }),
      data: enc({ eventId: EVENT, payload: {} }),
      time: new Date(),
    }
    const d = double({ DLQ: [advisoryEntry(3)], ORGUNIT: [original] })
    const r = await replayDeadLetter(d.jsm, d.js, { seq: 3, log: () => {} })
    expect(r).toMatchObject({ kind: 'advisory', republishedTo: 'gremion.t1.org-unit.created', msgId: `${EVENT}.r3` })
    expect(d.published[0]!.data).toEqual(original.data)
    expect(d.deleted).toEqual([['DLQ', 3]])
  })

  test('an advisory whose original expired says to use outbox-replay and deletes nothing', async () => {
    const d = double({ DLQ: [advisoryEntry(3)], ORGUNIT: [] })
    await expect(replayDeadLetter(d.jsm, d.js, { seq: 3, log: () => {} })).rejects.toThrow(/outbox-replay/)
    expect(d.deleted).toEqual([])
  })

  test('a missing entry is a RecoveryError', async () => {
    const d = double({ DLQ: [] })
    await expect(replayDeadLetter(d.jsm, d.js, { seq: 9, log: () => {} })).rejects.toThrow(RecoveryError)
  })

  test('the log line names the stale outcome (Q14)', async () => {
    const d = double({ DLQ: [consumerEntry(7)] })
    const lines: string[] = []
    await replayDeadLetter(d.jsm, d.js, { seq: 7, log: (l) => lines.push(l) })
    expect(lines.join('\n')).toContain('skipped_stale')
  })
})

describe('replayOutbox orders by publish order, not event_time', () => {
  const mk = (id: string, publishedAt: string) => ({
    event_id: id, customer_id: 'c', event_type: 't', source: '/gremion/idt', subject: 's', event_time: new Date('2020-01-01T00:00:00Z'), data: {},
    traceparent: null, aggregate_type: 'x', aggregate_id: 'a', aggregate_version: 1, test_run_id: null, published_cursor: publishedAt,
  })

  test('ORDER BY published_at, event_id, and the keyset cursor follows the same pair', async () => {
    const { replayOutbox } = await import('../src/recovery.ts')
    const queries: { sql: string; params: unknown[] }[] = []
    const pages = [[mk('a', '2026-01-01T00:00:01Z'), mk('b', '2026-01-01T00:00:02Z')], [mk('c', '2026-01-01T00:00:03Z')]]
    const tx = Object.assign(async () => [], {
      unsafe: async (q: string, params: unknown[] = []) => {
        if (q.includes('set_config')) return [{ c: 'c' }]
        queries.push({ sql: q, params })
        return pages.shift() ?? []
      },
    })
    const sql = { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as never
    const published: string[] = []
    const js = { publish: async (_s: string, _d: unknown, o: { msgID: string }) => (published.push(o.msgID), { stream: 'S', seq: 1, duplicate: false }) } as never
    const r = await replayOutbox(sql, js, { ctx: 'idt', subjects: () => 'gremion.t.x', batchSize: 2, log: () => {} })
    expect(r.republished).toBe(3)
    expect(published).toEqual(['a', 'b', 'c'])
    const q = queries[0]!.sql.replace(/\s+/g, ' ')
    expect(q).toContain('ORDER BY published_at, event_id')
    expect(q).toContain('(published_at, event_id) > ($2::timestamptz, $3::uuid)')
    expect(q).not.toContain('ORDER BY event_time')
    expect(queries[1]!.params.slice(1, 3)).toEqual(['2026-01-01T00:00:02Z', 'b'])
  })
})
