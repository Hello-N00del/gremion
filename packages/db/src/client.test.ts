import { describe, it, expect, vi } from 'vitest'

const { postgresSpy } = vi.hoisted(() => ({ postgresSpy: vi.fn(() => ({ end: vi.fn() })) }))
vi.mock('postgres', () => ({ default: postgresSpy }))

import { createDb, type DbProfile } from './client'

describe('createDb(profile)', () => {
  it('passes url, max and prepare through to postgres()', () => {
    const profile: DbProfile = { url: 'postgres://t1', max: 3, prepare: true }
    createDb(profile)
    expect(postgresSpy).toHaveBeenCalledTimes(1)
    expect(postgresSpy).toHaveBeenCalledWith('postgres://t1', {
      max: 3, prepare: true, idle_timeout: 20, connect_timeout: 10,
    })
  })
  it('cuts the default per-client pool size to 3 (was 10)', () => {
    createDb({ url: 'postgres://t1', max: 3, prepare: true })
    const opts = postgresSpy.mock.calls.at(-1)![1] as { max: number }
    expect(opts.max).toBe(3)
    expect(opts.max).toBeLessThanOrEqual(4)
  })
})
