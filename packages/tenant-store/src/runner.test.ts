import { describe, expect, it } from 'vitest'
import { assertNotPooler, MigrationRunnerError } from './runner.js'

const fake = (answer: () => unknown) => ({ unsafe: (async () => answer()) as never })

describe('assertNotPooler (Q3)', () => {
  it('refuses a target that answers SHOW pool_mode (PgBouncer)', async () => {
    const err = await assertNotPooler(fake(() => [{ pool_mode: 'transaction' }])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('POOLER_TARGET')
  })

  it('accepts Postgres, which does not know the parameter (42704)', async () => {
    await expect(assertNotPooler(fake(() => { throw Object.assign(new Error('unrecognized configuration parameter'), { code: '42704' }) }))).resolves.toBeUndefined()
  })

  it('rethrows any other error instead of guessing', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    await expect(assertNotPooler(fake(() => { throw boom }))).rejects.toBe(boom)
  })
})
