import { describe, it, expect, vi } from 'vitest'
import { isTransientDbStartupError, waitForDbReady } from './db'

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
    await waitForDbReady({ attempts: 5, delayMs: 0, ping, sleep })
    expect(n).toBe(3)
  })

  it('rethrows a non-transient error immediately without retrying', async () => {
    const ping = vi.fn(async () => {
      throw { code: '42P01', message: 'relation does not exist' }
    })
    await expect(waitForDbReady({ attempts: 5, delayMs: 0, ping, sleep })).rejects.toMatchObject({
      code: '42P01',
    })
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget when the DB never comes up', async () => {
    const ping = vi.fn(async () => {
      throw { code: '57P03', message: 'the database system is starting up' }
    })
    await expect(waitForDbReady({ attempts: 3, delayMs: 0, ping, sleep })).rejects.toThrow(/not ready/i)
    expect(ping).toHaveBeenCalledTimes(3)
  })
})
