import { describe, expect, it } from 'vitest'
import { assertNotPooler, MigrationRunnerError } from './runner.js'

/** A fake reserved connection: `announced` is the BackendKeyData pid, `actual` pg_backend_pid(). */
function fake({ announced, actual, show }: { announced: number | null; actual: number; show: () => unknown }) {
  const tag = (async () => Object.assign([{ pid: actual }], { state: { pid: announced } })) as unknown as Record<string, unknown>
  tag.unsafe = async () => show()
  return tag as never
}
const unknownParam = () => {
  throw Object.assign(new Error('unrecognized configuration parameter "pool_mode"'), { code: '42704' })
}

describe('assertNotPooler (Q3)', () => {
  it('refuses a pooler whose handshake pid differs from pg_backend_pid() (PgBouncer forwards SHOW pool_mode, so 42704 alone proves nothing)', async () => {
    const err = await assertNotPooler(fake({ announced: 1380295466, actual: 72, show: unknownParam })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('POOLER_TARGET')
  })

  it('refuses when the handshake pid is unknown', async () => {
    await expect(assertNotPooler(fake({ announced: null, actual: 72, show: unknownParam }))).rejects.toThrow(/not a direct Postgres connection/)
  })

  it('refuses a target that answers SHOW pool_mode', async () => {
    const err = await assertNotPooler(fake({ announced: 72, actual: 72, show: () => [{ pool_mode: 'transaction' }] })).catch((e: unknown) => e)
    expect((err as MigrationRunnerError).code).toBe('POOLER_TARGET')
  })

  it('accepts direct Postgres: same pid, and SHOW pool_mode unknown (42704)', async () => {
    await expect(assertNotPooler(fake({ announced: 74, actual: 74, show: unknownParam }))).resolves.toBeUndefined()
  })

  it('rethrows any other SHOW error instead of guessing', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    await expect(assertNotPooler(fake({ announced: 74, actual: 74, show: () => { throw boom } }))).rejects.toBe(boom)
  })
})

describe('runMigrations pool size', () => {
  it('refuses a pool of fewer than 2 connections (the terminate path needs a second one)', async () => {
    const { runMigrations } = await import('./runner.js')
    let reserved = 0
    const sql = { options: { max: 1 }, reserve: async () => (reserved++, {}) } as never
    await expect(runMigrations({ sql, dir: '/nonexistent', log: () => {} })).rejects.toThrow(/at least 2 connections/)
    expect(reserved).toBe(0)
  })
})
