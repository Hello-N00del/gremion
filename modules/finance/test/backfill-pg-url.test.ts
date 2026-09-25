/**
 * backfill.ts must NOT fall open to localhost:5432.
 *
 * `runBackfill` resolved both endpoints with a trailing
 * `?? 'postgres://postgres@localhost:5432/postgres'`. On the staging host that
 * port is the LIVE kernel Postgres, so a backfill launched with neither
 * FINANCE_PG_URL nor FINANCE_TEST_PG_URL set would silently point at it — the
 * copy path WRITES, which makes an unconfigured run a wrong-database-write.
 * src/tenant-store.ts already fails closed here (#394 require-explicit-env,
 * requireRuntimePgUrl); this pins the same posture for the script.
 *
 * PG-free: the guard fires before any postgres() handle is opened, so nothing
 * here can dial a database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runBackfill } from '../scripts/backfill.ts'

const SAVED = {
  pg: process.env.FINANCE_PG_URL,
  test: process.env.FINANCE_TEST_PG_URL,
}

beforeEach(() => {
  delete process.env.FINANCE_PG_URL
  delete process.env.FINANCE_TEST_PG_URL
})

afterEach(() => {
  if (SAVED.pg === undefined) delete process.env.FINANCE_PG_URL
  else process.env.FINANCE_PG_URL = SAVED.pg
  if (SAVED.test === undefined) delete process.env.FINANCE_TEST_PG_URL
  else process.env.FINANCE_TEST_PG_URL = SAVED.test
})

describe('runBackfill — no implicit localhost:5432 fallback', () => {
  it('throws naming FINANCE_PG_URL when nothing is configured', async () => {
    await expect(runBackfill({ tenant: 'demo', log: () => {} })).rejects.toThrow(/FINANCE_PG_URL/)
  })

  it('refuses to default to localhost:5432 (the live kernel Postgres)', async () => {
    await expect(runBackfill({ tenant: 'demo', log: () => {} })).rejects.toThrow(/localhost:5432/)
  })

  it('still fails closed when only the TARGET url is supplied', async () => {
    // A half-configured run must not silently read from localhost:5432 either:
    // the SOURCE is the kernel DB and reading the wrong one produces a
    // plausible-looking but wrong backfill.
    await expect(
      runBackfill({
        tenant: 'demo',
        pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
        log: () => {},
      }),
    ).rejects.toThrow(/FINANCE_PG_URL/)
  })

  it('names the SOURCE option, not the target one, on a half-configured run', async () => {
    // The operator has ALREADY passed pgUrl on this path, so 'or pass options.pgUrl'
    // points at the knob they just turned. The option that actually satisfies
    // the SOURCE resolution is sourcePgUrl (or FINANCE_TEST_PG_URL).
    await expect(
      runBackfill({
        tenant: 'demo',
        pgUrl: 'postgres://u:p@127.0.0.1:59999/postgres',
        log: () => {},
      }),
    ).rejects.toThrow(/sourcePgUrl/)
  })
})
