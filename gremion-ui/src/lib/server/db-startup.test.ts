import { describe, it, expect, vi } from 'vitest'
import {
  DB_STARTUP_INITIAL_DELAY_MS,
  DB_STARTUP_MAX_DELAY_MS,
  DbStartupBudgetExhaustedError,
  dbStartupBackoffMs,
  isTransientDbStartupError,
  jitterDelayMs,
  waitForDbReady,
} from './db'

describe('isTransientDbStartupError', () => {
  it('is true while Postgres is still starting up (57P03)', () => {
    expect(
      isTransientDbStartupError({ code: '57P03', message: 'the database system is starting up' }),
    ).toBe(true)
  })

  it('is true for a refused TCP connection (ECONNREFUSED)', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' })
    expect(isTransientDbStartupError(err)).toBe(true)
  })

  it('is false for a real schema error (undefined_table 42P01)', () => {
    expect(
      isTransientDbStartupError({ code: '42P01', message: 'relation "x" does not exist' }),
    ).toBe(false)
  })

  it('is false for a generic error', () => {
    expect(isTransientDbStartupError(new Error('boom'))).toBe(false)
  })
})

describe('waitForDbReady', () => {
  const sleep = async () => {}

  it('retries a transient ping failure, then resolves once the DB is up', async () => {
    let n = 0
    const ping = vi.fn(async () => {
      n++
      if (n < 3) throw { code: '57P03', message: 'the database system is starting up' }
    })
    await waitForDbReady({ attempts: 5, ping, sleep })
    expect(n).toBe(3)
  })

  it('rethrows a non-transient error immediately without retrying', async () => {
    const ping = vi.fn(async () => {
      throw { code: '42P01', message: 'relation does not exist' }
    })
    await expect(waitForDbReady({ attempts: 5, ping, sleep })).rejects.toMatchObject({
      code: '42P01',
    })
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget when the DB never comes up', async () => {
    const ping = vi.fn(async () => {
      throw { code: '57P03', message: 'the database system is starting up' }
    })
    await expect(waitForDbReady({ attempts: 3, ping, sleep })).rejects.toThrow(/not ready/i)
    expect(ping).toHaveBeenCalledTimes(3)
  })
})

// ── TASK-023: exponential backoff with a real, asserted ceiling ─────────────
describe('dbStartupBackoffMs (the ladder before jitter)', () => {
  it('doubles from 500 ms: [500, 1000, 2000, 4000]', () => {
    expect([1, 2, 3, 4].map((n) => dbStartupBackoffMs(n))).toEqual([500, 1000, 2000, 4000])
  })

  it('is capped at the 30 000 ms default ceiling from attempt 7 on', () => {
    expect(DB_STARTUP_INITIAL_DELAY_MS).toBe(500)
    expect(DB_STARTUP_MAX_DELAY_MS).toBe(30_000)
    expect(dbStartupBackoffMs(6)).toBe(16_000)
    expect(dbStartupBackoffMs(7)).toBe(30_000)
    expect(dbStartupBackoffMs(8)).toBe(30_000)
    // No overflow to Infinity/NaN far past the cap.
    expect(dbStartupBackoffMs(5000)).toBe(30_000)
  })

  it('honours an explicit cap and start', () => {
    expect(dbStartupBackoffMs(3, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(250)
    expect(dbStartupBackoffMs(2, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(200)
  })
})

describe('jitterDelayMs (the window is [50%, 100%] of the ladder step)', () => {
  it('random 0 gives exactly half, random just below 1 stays below the step', () => {
    expect(jitterDelayMs(30_000, () => 0)).toBe(15_000)
    expect(jitterDelayMs(30_000, () => 0.999999)).toBeLessThanOrEqual(30_000)
    expect(jitterDelayMs(30_000, () => 0.999999)).toBeGreaterThanOrEqual(29_999)
  })

  it('never leaves the window for any random draw', () => {
    for (let i = 0; i <= 100; i++) {
      const d = jitterDelayMs(4000, () => i / 101)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThanOrEqual(4000)
    }
  })
})

describe('waitForDbReady — backoff ladder, cap and budget', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' })

  it('sleeps the jittered ladder: with random=1-ε the waits track [500, 1000, 2000, 4000, …] and never exceed the cap', async () => {
    const waits: number[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ping = vi.fn(async () => {
      throw refused()
    })
    await expect(
      waitForDbReady({ attempts: 10, ping, sleep: async (ms) => void waits.push(ms), random: () => 0.9999999 }),
    ).rejects.toBeInstanceOf(DbStartupBudgetExhaustedError)
    warn.mockRestore()
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000)
  })

  it('with random=0 every wait is exactly half its ladder step', async () => {
    const waits: number[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ping = vi.fn(async () => {
      throw refused()
    })
    await expect(
      waitForDbReady({ attempts: 5, ping, sleep: async (ms) => void waits.push(ms), random: () => 0 }),
    ).rejects.toThrow()
    warn.mockRestore()
    expect(waits).toEqual([250, 500, 1000, 2000])
  })

  it('logs each wait with its attempt, ladder step and whether it was capped', async () => {
    const lines: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)))
    const ping = vi.fn(async () => {
      throw refused()
    })
    await expect(waitForDbReady({ attempts: 9, ping, sleep: async () => {}, random: () => 0.5 })).rejects.toThrow()
    warn.mockRestore()
    expect(lines[0]).toMatch(/^\[boot\] database not ready \(attempt 1\/9\): .*ECONNREFUSED.*; backoff=500ms wait=375ms$/)
    expect(lines[7]).toMatch(/\(attempt 8\/9\).*; backoff=30000ms \(capped\) wait=22500ms$/)
  })

  it('exhausting the budget throws DbStartupBudgetExhaustedError, carrying the last error as its cause', async () => {
    const last = refused()
    const ping = vi.fn(async () => {
      throw last
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = await waitForDbReady({ attempts: 3, ping, sleep: async () => {} }).catch((e: unknown) => e)
    warn.mockRestore()
    expect(err).toBeInstanceOf(DbStartupBudgetExhaustedError)
    expect((err as DbStartupBudgetExhaustedError).attempts).toBe(3)
    expect((err as Error).cause).toBe(last)
  })
})

describe('Q1: an exhausted startup budget is NOT transient', () => {
  it('DbStartupBudgetExhaustedError is classed non-transient even though its cause is ECONNREFUSED', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' })
    expect(isTransientDbStartupError(new DbStartupBudgetExhaustedError(60, cause))).toBe(false)
  })

  it('the pre-TASK-023 exhaustion text would have matched the transient regex (why the class exists)', () => {
    expect(isTransientDbStartupError(new Error('database not ready after 60 attempts: connect ECONNREFUSED 10.0.0.2:5432'))).toBe(true)
  })

  it('a waitForDbReady exhaustion, end to end, is non-transient', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = await waitForDbReady({
      attempts: 2,
      ping: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:5432'), { code: 'ECONNREFUSED' })
      },
      sleep: async () => {},
    }).catch((e: unknown) => e)
    warn.mockRestore()
    expect(isTransientDbStartupError(err)).toBe(false)
  })

  it('a wrong password (28P01) is non-transient and not retried', async () => {
    const ping = vi.fn(async () => {
      throw { code: '28P01', message: 'password authentication failed for user "gremion"' }
    })
    await expect(waitForDbReady({ attempts: 5, ping, sleep: async () => {} })).rejects.toMatchObject({ code: '28P01' })
    expect(ping).toHaveBeenCalledTimes(1)
  })
})
