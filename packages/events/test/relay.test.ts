// The relay's failure accounting without a database: a fake service database records the UPDATEs.
// A transport failure (broker unreachable) is a fact about the broker, not the row: it must burn no
// attempt and the loop backs off; a row-specific failure still counts (TASK-079 verify round 1, HIGH).
import { describe, expect, test } from 'vitest'
import { createRelay, isRowSpecificError, transportBackoffMs } from '../src/relay.ts'

interface Fake {
  sql: never
  updates: { sql: string; params: unknown[] }[]
}

function fakeDb(rowCount = 3): Fake {
  const updates: Fake['updates'] = []
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    event_id: `e${i}`, customer_id: 'c', event_type: 't', source: '/gremion/idt', subject: 's', event_time: new Date(0), data: {},
    traceparent: null, aggregate_type: 'x', aggregate_id: `a${i}`, aggregate_version: 1, test_run_id: null, attempt_count: 0,
  }))
  const tx = Object.assign(async () => [{ ok: true }], {
    unsafe: async (q: string, params: unknown[] = []) => {
      if (q.includes('set_config')) return [{ c: 'c' }]
      if (q.includes('FOR UPDATE')) return rows
      updates.push({ sql: q, params })
      return []
    },
  })
  return { sql: { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as never, updates }
}

const named = (name: string, msg = name) => Object.assign(new Error(msg), { name })
const relayWith = (db: Fake, publish: () => Promise<unknown>, extra = {}) =>
  createRelay({ sql: db.sql, ctx: 'idt', js: { publish } as never, subjects: () => 'gremion.t.x', onError: () => {}, log: () => {}, ...extra })
const attempts = (db: Fake) => db.updates.filter((u) => u.sql.includes('attempt_count'))

describe('transport errors burn no attempt', () => {
  test.each([
    ['timeout', named('TimeoutError')],
    ['closed connection', named('ClosedConnectionError')],
    ['draining connection', named('DrainingConnectionError')],
    ['no responders (503)', named('NoRespondersError')],
    ['unclassified', new Error('boom')],
  ])('%s: the pass rejects, nothing is counted, no row is touched', async (_n, err) => {
    const db = fakeDb()
    const relay = relayWith(db, async () => { throw err })
    await expect(relay.runOnce()).rejects.toBe(err)
    expect(attempts(db)).toEqual([])
    expect(db.updates).toEqual([])
  })

  test('N passes against a dead broker leave every row uncounted', async () => {
    const db = fakeDb()
    const relay = relayWith(db, async () => { throw named('TimeoutError') })
    for (let i = 0; i < 5; i++) await expect(relay.runOnce()).rejects.toBeDefined()
    expect(db.updates).toEqual([])
  })
})

describe('row-specific errors still count', () => {
  test.each([
    ['permission denied', named('PermissionViolationError')],
    ['max payload', named('InvalidArgumentError', 'payload max_payload size exceeded')],
    ['no subject', Object.assign(new Error('no subject'), { code: 'no_subject' })],
  ])('%s', async (_n, err) => {
    const db = fakeDb(1)
    const res = await relayWith(db, async () => { throw err }).runOnce()
    expect(res.failed).toBe(1)
    expect(attempts(db)).toHaveLength(1)
    expect(attempts(db)[0]!.params[1]).toBe(1)
  })

  test('a missing subject map entry counts without touching the broker', () => {
    expect(isRowSpecificError(Object.assign(new Error('x'), { code: 'no_subject' }))).toBe(true)
    expect(isRowSpecificError(new Error('boom'))).toBe(false)
  })
})

describe('transportBackoffMs', () => {
  test('bounded exponential, capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(transportBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})
