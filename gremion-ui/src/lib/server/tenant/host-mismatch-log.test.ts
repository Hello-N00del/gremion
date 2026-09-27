// TASK-041 (L3-08; TRD-076): the host-rejection event emitter.
//
// Every host-path 404 of the tenant resolver emits ONE structured application
// log line, `tenant.host.rejected`, naming the timestamp and the rejected host.
// Because the host is attacker-chosen, the emitter is bounded on three axes
// (OWASP Logging Cheat Sheet, "Attacks on Logs": flooding and injection):
//   * dedupe  -- one line per (reason, host) per 60 s; the next carries
//                `suppressed:<n>`;
//   * memory  -- the dedupe map holds at most 1024 keys (oldest insertion out);
//   * volume  -- at most 60 event lines per 60 s window per process; beyond
//                that, lines are dropped and ONE `tenant.host.rejected.flood`
//                line per window reports `dropped:<n>`.
// The emitter never throws: a logging failure must not turn a 404 into a 500.
//
// The line itself goes through the REAL tlog seam (one JSON line on
// console.warn, `tenant: null` outside a tenant scope); the clock and the
// flood-flush timer are injected so every window edge is exact.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHostRejectionLog,
  DEDUPE_WINDOW_MS,
  HOST_REJECTED_EVENT,
  HOST_REJECTED_FLOOD_EVENT,
  MAX_DEDUPE_KEYS,
  MAX_LINES_PER_WINDOW,
} from './host-mismatch-log'

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0)

let clock = T0
let timers: Array<{ fn: () => void; at: number }> = []
let warn: ReturnType<typeof vi.spyOn>

function make() {
  return createHostRejectionLog({
    now: () => clock,
    schedule: (fn, ms) => {
      timers.push({ fn, at: clock + ms })
    },
  })
}
/** Fire every scheduled timer that is due at the current clock. */
function runDueTimers() {
  const due = timers.filter((t) => t.at <= clock)
  timers = timers.filter((t) => t.at > clock)
  for (const t of due) t.fn()
}
/** Every console.warn line, parsed. */
function lines(): Array<Record<string, unknown>> {
  return warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}
const events = () => lines().filter((l) => l.msg === HOST_REJECTED_EVENT)
const floods = () => lines().filter((l) => l.msg === HOST_REJECTED_FLOOD_EVENT)

beforeEach(() => {
  clock = T0
  timers = []
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('tenant.host.rejected: the line', () => {
  it('is ONE JSON line with an RFC 3339 UTC ts, the host, the reason and tenant:null', () => {
    make()('unbound', 'nope.example.org')
    expect(warn).toHaveBeenCalledTimes(1)
    const raw = String(warn.mock.calls[0][0])
    expect(raw).not.toContain('\n')
    const line = JSON.parse(raw)
    expect(line).toEqual({
      level: 'warn',
      msg: 'tenant.host.rejected',
      tenant: null,
      ts: '2026-09-27T10:00:00.000Z',
      host: 'nope.example.org',
      reason: 'unbound',
    })
    // RFC 3339 date-time in UTC (Z), not a locale string and not epoch millis.
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  })

  it('carries each of the four reasons verbatim', () => {
    const log = make()
    for (const reason of ['unparseable', 'unbound', 'inactive', 'forged'] as const) log(reason, `${reason}.example.org`)
    expect(events().map((e) => e.reason)).toEqual(['unparseable', 'unbound', 'inactive', 'forged'])
  })

  it('an attacker-chosen raw value is truncated to 253 characters and stays one escaped JSON string', () => {
    const hostile = 'a'.repeat(100) + '\n{"level":"info","msg":"forged"}\r\n' + 'b'.repeat(200)
    expect(hostile.length).toBeGreaterThan(300)
    make()('unparseable', hostile)
    expect(warn).toHaveBeenCalledTimes(1)
    const raw = String(warn.mock.calls[0][0])
    expect(raw.split('\n')).toHaveLength(1) // no log-line injection
    const line = JSON.parse(raw)
    expect(line.host).toBe(hostile.slice(0, 253))
    expect((line.host as string).length).toBe(253)
    expect(raw).toContain('\\n') // escaped, not raw
  })

  it('an absent header is logged as the empty string, never null or "undefined"', () => {
    make()('unparseable', null)
    expect(events()[0].host).toBe('')
  })
})

describe('tenant.host.rejected: dedupe per (reason, host)', () => {
  it('a repeat within 60 s is suppressed; the next line after the window carries suppressed:1', () => {
    const log = make()
    log('unbound', 'nope.example.org')
    clock += DEDUPE_WINDOW_MS - 1
    log('unbound', 'nope.example.org')
    expect(events()).toHaveLength(1)
    clock += 1
    log('unbound', 'nope.example.org')
    expect(events()).toHaveLength(2)
    expect(events()[1].suppressed).toBe(1)
    expect(events()[0]).not.toHaveProperty('suppressed')
  })

  it('the same host under a different reason is a different key', () => {
    const log = make()
    log('unbound', 'a.example.org')
    log('forged', 'a.example.org')
    expect(events().map((e) => e.reason)).toEqual(['unbound', 'forged'])
  })

  it('the dedupe map never exceeds 1024 keys: the oldest insertion is evicted', () => {
    const out: Array<Record<string, unknown>> = []
    const log = createHostRejectionLog({
      now: () => clock,
      schedule: () => {},
      emit: (_m, f) => out.push({ ...f }),
    })
    // h0 and h1 each swallow one repeat, so a retained key would report it.
    log('unbound', 'h0.example.org')
    log('unbound', 'h0.example.org')
    log('unbound', 'h1.example.org')
    log('unbound', 'h1.example.org')
    // Fill past the bound. The volume cap allows 60 lines per window, so the
    // clock steps one window every 60 keys: the map, not the cap, is under test.
    for (let i = 2; i < MAX_DEDUPE_KEYS + 1; i++) {
      if (i % MAX_LINES_PER_WINDOW === 0) clock += DEDUPE_WINDOW_MS
      log('unbound', `h${i}.example.org`)
      expect(log.size()).toBeLessThanOrEqual(MAX_DEDUPE_KEYS)
    }
    expect(log.size()).toBe(MAX_DEDUPE_KEYS)
    clock += DEDUPE_WINDOW_MS
    out.length = 0
    // h1 was the next-oldest and survived the single eviction: it still reports
    // its swallowed repeat (asked first, so h0's re-insert cannot evict it).
    log('unbound', 'h1.example.org')
    // h0 was the oldest insertion: evicted, so its swallowed repeat is gone.
    log('unbound', 'h0.example.org')
    expect(out.map((f) => [f.host, f.suppressed])).toEqual([
      ['h1.example.org', 1],
      ['h0.example.org', undefined],
    ])
    expect(log.size()).toBe(MAX_DEDUPE_KEYS)
  })
})

describe('tenant.host.rejected: volume cap', () => {
  it('61 hosts in one window -> 60 event lines and ONE flood line with dropped:1', () => {
    const log = make()
    for (let i = 0; i < MAX_LINES_PER_WINDOW + 1; i++) log('unbound', `h${i}.example.org`)
    expect(events()).toHaveLength(60)
    expect(floods()).toHaveLength(0) // reported when the window closes, with its final count
    clock += DEDUPE_WINDOW_MS
    runDueTimers()
    expect(floods()).toHaveLength(1)
    expect(floods()[0]).toMatchObject({ level: 'warn', tenant: null, dropped: 1 })
    expect(floods()[0].ts).toMatch(/Z$/)
    expect(events()).toHaveLength(60)
  })

  it('many drops in one window still produce exactly one flood line, counting all of them', () => {
    const log = make()
    for (let i = 0; i < 500; i++) log('unbound', `h${i}.example.org`)
    clock += DEDUPE_WINDOW_MS
    runDueTimers()
    expect(events()).toHaveLength(60)
    expect(floods()).toHaveLength(1)
    expect(floods()[0].dropped).toBe(440)
  })

  it('without the timer, the next event after the window reports the flood first, then logs', () => {
    const log = createHostRejectionLog({ now: () => clock, schedule: () => {} })
    for (let i = 0; i < 62; i++) log('unbound', `h${i}.example.org`)
    clock += DEDUPE_WINDOW_MS
    log('unbound', 'later.example.org')
    expect(floods()).toHaveLength(1)
    expect(floods()[0].dropped).toBe(2)
    expect(events().at(-1)?.host).toBe('later.example.org')
    // a new window has a fresh budget
    expect(events()).toHaveLength(61)
  })

  it('suppressed repeats do not spend the volume budget', () => {
    const log = make()
    for (let i = 0; i < 1000; i++) log('unbound', 'same.example.org')
    for (let i = 0; i < 59; i++) log('unbound', `h${i}.example.org`)
    expect(events()).toHaveLength(60)
    expect(floods()).toHaveLength(0)
    clock += DEDUPE_WINDOW_MS
    runDueTimers()
    expect(floods()).toHaveLength(0)
  })
})

describe('tenant.host.rejected: never throws', () => {
  it('a throwing sink does not escape the emitter', () => {
    warn.mockImplementation(() => {
      throw new Error('stderr closed')
    })
    const log = make()
    expect(() => log('unbound', 'nope.example.org')).not.toThrow()
    for (let i = 0; i < 70; i++) expect(() => log('unbound', `h${i}.example.org`)).not.toThrow()
    clock += DEDUPE_WINDOW_MS
    expect(() => runDueTimers()).not.toThrow()
  })

  it('a throwing clock does not escape the emitter', () => {
    const log = createHostRejectionLog({
      now: () => {
        throw new Error('clock')
      },
    })
    expect(() => log('forged', 'a.example.org')).not.toThrow()
  })
})
