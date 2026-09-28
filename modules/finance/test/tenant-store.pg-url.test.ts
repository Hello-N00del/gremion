/**
 * finance tenant-store — FINANCE_PG_URL is REQUIRED (fail-closed).
 *
 * The finance leaf used to resolve its runtime Postgres URL as
 *
 *     options.pgUrl ?? process.env.FINANCE_PG_URL ?? 'postgres://postgres@localhost:5432/postgres'
 *
 * On the staging host port 5432 is the LIVE kernel Postgres, so a finance
 * container booted without FINANCE_PG_URL did not fail — it silently pointed
 * `CREATE DATABASE finance_<slug>` and the control DB at the kernel's server.
 * calendar / content / newsletter already fail closed here (#394
 * require-explicit-env posture); this pins the same posture for finance.
 *
 * PG-free by construction: every assertion below is about REFUSING to resolve a
 * URL, so no connection is ever attempted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireRuntimePgUrl, storeFor, listTenants } from '../src/tenant-store.ts'

const TENANT = { id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' }
const TEST_DB_PREFIX = 'finance_test_'

let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env.FINANCE_PG_URL
  delete process.env.FINANCE_PG_URL
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.FINANCE_PG_URL
  else process.env.FINANCE_PG_URL = savedEnv
})

describe('requireRuntimePgUrl — no implicit localhost:5432 fallback', () => {
  it('throws naming FINANCE_PG_URL when neither an explicit URL nor the env var is set', () => {
    expect(() => requireRuntimePgUrl(undefined, 'FINANCE_PG_URL')).toThrow(/FINANCE_PG_URL/)
  })

  it('throws when the env var is present but empty', () => {
    process.env.FINANCE_PG_URL = ''
    expect(() => requireRuntimePgUrl(undefined, 'FINANCE_PG_URL')).toThrow(/FINANCE_PG_URL/)
  })

  it('never returns a default URL instead of throwing', () => {
    let returned: string | undefined
    try {
      returned = requireRuntimePgUrl(undefined, 'FINANCE_PG_URL')
    } catch {
      returned = undefined
    }
    expect(returned).toBeUndefined()
  })

  it('returns an explicitly passed URL verbatim', () => {
    const url = 'postgres://postgres@localhost:55434/finance_test'
    expect(requireRuntimePgUrl(url, 'FINANCE_PG_URL')).toBe(url)
  })

  it('falls back to the env var when no explicit URL is passed', () => {
    process.env.FINANCE_PG_URL = 'postgres://postgres@localhost:55435/finance_env'
    expect(requireRuntimePgUrl(undefined, 'FINANCE_PG_URL')).toBe(
      'postgres://postgres@localhost:55435/finance_env',
    )
  })
})

describe('the store refuses to run without FINANCE_PG_URL', () => {
  it('storeFor rejects naming FINANCE_PG_URL, before any CREATE DATABASE', async () => {
    await expect(storeFor(TENANT, { dbPrefix: TEST_DB_PREFIX })).rejects.toThrow(/FINANCE_PG_URL/)
  })

  it('listTenants rejects naming FINANCE_PG_URL', async () => {
    await expect(listTenants({ dbPrefix: TEST_DB_PREFIX })).rejects.toThrow(/FINANCE_PG_URL/)
  })
})
