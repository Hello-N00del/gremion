// The relay's failure accounting without a database: a fake service database records the UPDATEs.
// A transport failure (broker unreachable) is a fact about the broker, not the row: it must burn no
// attempt and the loop backs off; a row-specific failure still counts (TASK-079 verify round 1, HIGH).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRelay, isRowSpecificError, transportBackoffMs } from '../src/relay.ts'

interface Fake {
  sql: never
  updates: { sql: string; params: unknown[] }[]
}

function fakeDb(rowCount = 3, rowsPerPass?: (pass: number) => number): Fake & { passes: () => number } {
  const updates: Fake['updates'] = []
  let passes = 0
  const mk = (i: number) => ({
    event_id: `e${i}`, customer_id: 'c', event_type: 't', source: '/gremion/idt', subject: 's', event_time: new Date(0), data: {},
    traceparent: null, aggregate_type: 'x', aggregate_id: `a${i}`, aggregate_version: 1, test_run_id: null, attempt_count: 0,
  })
  const tx = Object.assign(async () => [{ ok: true }], {
    unsafe: async (q: string, params: unknown[] = []) => {
      if (q.includes('set_config')) return [{ c: 'c' }]
      if (q.includes('FOR UPDATE')) {
        passes++
        return Array.from({ length: rowsPerPass ? rowsPerPass(passes) : rowCount }, (_, i) => mk(i))
      }
      updates.push({ sql: q, params })
      return []
    },
  })
  return { sql: { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as never, updates, passes: () => passes }
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
  ])('%s: the pass rejects, nothing is counted, no row is touched', async (_n, err) => {
    const db = fakeDb()
    const relay = relayWith(db, async () => { throw err }, { probe: async () => { throw new Error('down') } })
    await expect(relay.runOnce()).rejects.toBe(err)
    expect(attempts(db)).toEqual([])
    expect(db.updates).toEqual([])
  })

  test('N passes against a dead broker leave every row uncounted', async () => {
    const db = fakeDb()
    const relay = relayWith(db, async () => { throw named('TimeoutError') }, { probe: async () => { throw new Error('down') } })
    for (let i = 0; i < 5; i++) await expect(relay.runOnce()).rejects.toBeDefined()
    expect(db.updates).toEqual([])
  })
})

describe('row-specific errors still count', () => {
  const apiErr = (code: number, err_code: number, msg: string) => Object.assign(new Error(msg), { name: 'JetStreamApiError', code, err_code })
  test.each([
    ['JetStream max_msg_size (10054)', apiErr(400, 10054, 'message size exceeds maximum allowed')],
    ['JetStream sealed stream', apiErr(400, 10109, 'stream is sealed')],
    ['unclassified error', new Error('boom')],
    ['RequestError wrapping a permission violation', Object.assign(named('RequestError'), { cause: named('PermissionViolationError') })],
    ['TypeError', new TypeError('x is not a function')],
    ['timeout with a healthy broker', named('TimeoutError')],
    ['permission denied', named('PermissionViolationError')],
    ['max payload', named('InvalidArgumentError', 'payload max_payload size exceeded')],
    ['no subject', Object.assign(new Error('no subject'), { code: 'no_subject' })],
  ])('%s', async (_n, err) => {
    const db = fakeDb(1)
    const res = await relayWith(db, async () => { throw err }, { probe: async () => undefined }).runOnce()
    expect(res.failed).toBe(1)
    expect(attempts(db)).toHaveLength(1)
    expect(attempts(db)[0]!.params[1]).toBe(1)
  })

  test('a missing subject map entry counts without touching the broker', () => {
    expect(isRowSpecificError(Object.assign(new Error('x'), { code: 'no_subject' }))).toBe(true)
    expect(isRowSpecificError(new Error('boom'))).toBe(true)
    expect(isRowSpecificError(named('TimeoutError'))).toBe(false)
    expect(isRowSpecificError(named('ClosedConnectionError'))).toBe(false)
  })
})

describe('transport classification (allowlist)', () => {
  test('JetStream 503 / no responders is transport, not counted', async () => {
    const err = Object.assign(new Error('no responders'), { name: 'JetStreamApiError', code: 503 })
    const db = fakeDb(2)
    await expect(relayWith(db, async () => { throw err }, { probe: async () => undefined }).runOnce()).rejects.toBe(err)
    expect(db.updates).toEqual([])
  })
  test('RequestError wrapping no-responders is transport', async () => {
    const err = Object.assign(named('RequestError'), { cause: named('NoRespondersError') })
    const db = fakeDb(1)
    await expect(relayWith(db, async () => { throw err }, { probe: async () => undefined }).runOnce()).rejects.toBe(err)
    expect(db.updates).toEqual([])
  })
  test('timeout with a failing probe is transport, not counted', async () => {
    const err = named('TimeoutError')
    const db = fakeDb(2)
    await expect(relayWith(db, async () => { throw err }, { probe: async () => { throw new Error('down') } }).runOnce()).rejects.toBe(err)
    expect(db.updates).toEqual([])
  })
  test('timeout with a hanging probe is transport (the probe is bounded)', async () => {
    vi.useFakeTimers()
    const db = fakeDb(1)
    const p = relayWith(db, async () => { throw named('TimeoutError') }, { probe: () => new Promise(() => {}) }).runOnce()
    const assertion = expect(p).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    vi.useRealTimers()
    expect(db.updates).toEqual([])
  })
  test('a poison row (stream max_msg_size) dead-letters at maxAttempts', async () => {
    const db = fakeDb(1)
    const err = Object.assign(new Error('message size exceeds maximum allowed'), { name: 'JetStreamApiError', code: 400, err_code: 10054 })
    const res = await relayWith(db, async () => { throw err }, { maxAttempts: 1 }).runOnce()
    expect(res.deadLettered).toBe(1)
  })
})

describe('the loop applies the transport backoff', () => {
  afterEach(() => vi.useRealTimers())
  const transport = () => named('ClosedConnectionError')

  test('after a transport failure the next pass waits 1 s, then 2 s (not pollMs)', async () => {
    vi.useFakeTimers()
    const db = fakeDb(1)
    const relay = relayWith(db, async () => { throw transport() }, { pollMs: 10 })
    relay.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.passes()).toBe(1)
    await vi.advanceTimersByTimeAsync(900)
    expect(db.passes()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(db.passes()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_900)
    expect(db.passes()).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(db.passes()).toBe(3)
    await relay.stop()
  })

  test('a pass that does not throw resets the backoff', async () => {
    vi.useFakeTimers()
    const db = fakeDb(1, (n) => (n === 2 ? 0 : 1))
    const relay = relayWith(db, async () => { throw transport() }, { pollMs: 10 })
    relay.start()
    await vi.advanceTimersByTimeAsync(0) // pass 1 fails, failures=1, wait 1000
    await vi.advanceTimersByTimeAsync(1_000) // pass 2 finds no rows: reset, wait 10
    expect(db.passes()).toBe(2)
    await vi.advanceTimersByTimeAsync(10) // pass 3 fails: failures=1 -> wait 1000 (2000 without the reset)
    expect(db.passes()).toBe(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.passes()).toBe(4)
    await relay.stop()
  })
})

describe('transportBackoffMs', () => {
  test('bounded exponential, capped at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(transportBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})
