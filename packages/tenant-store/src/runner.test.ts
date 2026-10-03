import { fileURLToPath } from 'node:url'
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

/**
 * A scripted pool + reserved connection that walks runMigrations over the
 * committed fixture chain with no database: every migration body throws
 * `bodyError` (when given), and pg_advisory_unlock answers `unlockOk`.
 */
function scripted({ bodyError, unlockOk }: { bodyError?: Error; unlockOk: boolean }) {
  const calls: string[] = []
  const answer = (q: string): unknown[] => {
    if (q.includes('pg_catalog.pg_locks')) return [{ ok: true }]
    if (q.includes('pg_backend_pid() AS pid')) return [{ pid: 4242 }]
    if (q.includes('pg_try_advisory_lock')) return [{ ok: true }]
    if (q.includes('to_regclass')) return [{ present: false }]
    if (q.includes('pg_current_xact_id')) return [{ xid: '100' }]
    if (q.includes('pg_advisory_unlock')) return [{ ok: unlockOk }]
    return []
  }
  const reserved = ((strings: TemplateStringsArray) => {
    const q = strings.join('?')
    calls.push(q)
    return Promise.resolve(Object.assign(answer(q), { state: { pid: 4242 } }))
  }) as unknown as Record<string, unknown>
  reserved.unsafe = async (text: string) => {
    calls.push(text)
    if (text === 'SHOW pool_mode') throw Object.assign(new Error('unrecognized configuration parameter "pool_mode"'), { code: '42704' })
    if (/^(?:BEGIN|COMMIT|ROLLBACK|RESET)\b/.test(text.trim())) return []
    if (text.startsWith('CREATE TABLE public.schema_migrations')) return []
    if (bodyError) throw bodyError
    return []
  }
  reserved.release = () => {
    calls.push('release')
  }
  const pool = ((strings: TemplateStringsArray) => {
    const q = strings.join('?')
    calls.push(`pool: ${q}`)
    return Promise.resolve(q.includes('pg_terminate_backend') ? [{ ok: true }] : [])
  }) as unknown as Record<string, unknown>
  pool.options = { max: 4 }
  pool.reserve = async () => reserved
  return { sql: pool as never, calls }
}

const FIXTURE_CHAIN = fileURLToPath(new URL('../test/fixtures/migrations/fixture/', import.meta.url))
// TASK-075: every run names its release (ledger release_ref) and the fixture
// chain, headerless, is an expand chain (as test/harness/migrations.ts says).
const FIXTURE_RUN = { releaseRef: 'dist-v0.0.1', phaseFor: () => ({ phase: 'expand' as const }) }

// F1-FIX-02-K (sweep tool item T5): the runner's `finally` releases the lock
// and the connection. Whatever it does there must never replace or swallow the
// error the run itself raised: a migration that failed must fail the run.
describe('runMigrations error propagation through finally (T5)', () => {
  it('an error thrown inside a migration body propagates as APPLY_FAILED with that error as its cause', async () => {
    const { runMigrations } = await import('./runner.js')
    const boom = new Error('relation "nope" does not exist')
    const { sql, calls } = scripted({ bodyError: boom, unlockOk: true })
    const err = await runMigrations({ sql, dir: FIXTURE_CHAIN, ...FIXTURE_RUN, log: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('APPLY_FAILED')
    expect((err as MigrationRunnerError).cause).toBe(boom)
    expect(calls).toContain('ROLLBACK')
    expect(calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true)
    expect(calls.at(-1)).toBe('release')
  })

  it('the body error still propagates when the unlock in finally fails too (the backend is terminated, the error is not replaced)', async () => {
    const { runMigrations } = await import('./runner.js')
    const boom = new Error('syntax error at or near "CREAT"')
    const { sql, calls } = scripted({ bodyError: boom, unlockOk: false })
    const err = await runMigrations({ sql, dir: FIXTURE_CHAIN, ...FIXTURE_RUN, log: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('APPLY_FAILED')
    expect((err as MigrationRunnerError).cause).toBe(boom)
    expect(calls.some((c) => c.includes('pg_terminate_backend'))).toBe(true)
    expect(calls.at(-1)).toBe('release')
  })

  it('a failed unlock after a clean run is not swallowed either: UNLOCK_FAILED', async () => {
    const { runMigrations } = await import('./runner.js')
    const { sql, calls } = scripted({ unlockOk: false })
    const err = await runMigrations({ sql, dir: FIXTURE_CHAIN, ...FIXTURE_RUN, log: () => {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationRunnerError)
    expect((err as MigrationRunnerError).code).toBe('UNLOCK_FAILED')
    expect(calls.some((c) => c.includes('pg_terminate_backend'))).toBe(true)
    expect(calls.at(-1)).toBe('release')
  })
})

describe('runMigrations pool size', () => {
  it('refuses a pool of fewer than 2 connections (the terminate path needs a second one)', async () => {
    const { runMigrations } = await import('./runner.js')
    let reserved = 0
    const sql = { options: { max: 1 }, reserve: async () => (reserved++, {}) } as never
    await expect(runMigrations({ sql, dir: '/nonexistent', releaseRef: 'dist-v0.0.1', log: () => {} })).rejects.toThrow(/at least 2 connections/)
    expect(reserved).toBe(0)
  })

  it('TASK-075: refuses a run without a releaseRef (1-64 characters) before reserving anything', async () => {
    const { runMigrations } = await import('./runner.js')
    let reserved = 0
    const sql = { options: { max: 2 }, reserve: async () => (reserved++, {}) } as never
    for (const releaseRef of [undefined, '', 'x'.repeat(65), 'a\nb']) {
      await expect(runMigrations({ sql, dir: '/nonexistent', releaseRef: releaseRef as never, log: () => {} })).rejects.toThrow(/needs releaseRef/)
    }
    expect(reserved).toBe(0)
  })
})
