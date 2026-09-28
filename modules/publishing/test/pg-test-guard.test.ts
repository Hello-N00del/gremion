/**
 * Negative-proof UNIT tests for the newsletter leaf's integration-harness PG guard
 * (test/support/pg-test-guard.ts). PG-free — runs in the unit suite. Proves the
 * fail-closed posture swept from finance PR #393 (#394): an explicit
 * NEWSLETTER_TEST_PG_URL is REQUIRED, and localhost:5432 (the LIVE staging Postgres
 * on this host) — whether explicit or the implicit default port — is REJECTED
 * before any connection is attempted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const ENV_VAR = 'NEWSLETTER_TEST_PG_URL'
const PREFIX = 'newsletter_test_'
const SAFE_URL = 'postgres://postgres@localhost:55434/postgres'

let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_VAR]
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = savedEnv
})

describe('requireEphemeralTestPgUrl — env is REQUIRED (no localhost:5432 default)', () => {
  it('throws when the env var is unset', () => {
    delete process.env[ENV_VAR]
    expect(() => requireEphemeralTestPgUrl()).toThrow(/REQUIRED/)
  })

  it('throws when the env var is empty', () => {
    process.env[ENV_VAR] = ''
    expect(() => requireEphemeralTestPgUrl()).toThrow(/REQUIRED/)
  })

  it('never silently returns a localhost:5432 default', () => {
    delete process.env[ENV_VAR]
    let returned: string | undefined
    try {
      returned = requireEphemeralTestPgUrl()
    } catch {
      returned = undefined
    }
    // Must have thrown (fail-closed) rather than returning any default URL.
    expect(returned).toBeUndefined()
  })

  it('returns the URL verbatim when explicitly set to a non-5432 throwaway', () => {
    process.env[ENV_VAR] = SAFE_URL
    expect(requireEphemeralTestPgUrl()).toBe(SAFE_URL)
  })
})

describe('assertSafeTestEnv — REJECTS port 5432 / implicit default before any connection', () => {
  it('rejects an explicit localhost:5432', () => {
    expect(() => assertSafeTestEnv('postgres://postgres@localhost:5432/postgres', PREFIX)).toThrow(
      /SAFETY VIOLATION[\s\S]*5432/,
    )
  })

  it('rejects an explicit 127.0.0.1:5432', () => {
    expect(() => assertSafeTestEnv('postgres://postgres@127.0.0.1:5432/postgres', PREFIX)).toThrow(
      /SAFETY VIOLATION[\s\S]*5432/,
    )
  })

  it('rejects the implicit default port (no port → resolves to 5432)', () => {
    expect(() => assertSafeTestEnv('postgres://postgres@localhost/postgres', PREFIX)).toThrow(
      /implicit default 5432/,
    )
  })

  it('rejects a non-localhost host', () => {
    expect(() => assertSafeTestEnv('postgres://postgres@db.example.com:55434/postgres', PREFIX)).toThrow(
      /non-localhost host/,
    )
  })

  it('rejects a non-postgres scheme', () => {
    expect(() => assertSafeTestEnv('mysql://root@localhost:55434/postgres', PREFIX)).toThrow(/scheme/)
  })

  it('rejects a malformed URL', () => {
    expect(() => assertSafeTestEnv('not a url', PREFIX)).toThrow(/malformed/)
  })

  it('rejects a dbPrefix that is not a _test_ namespace', () => {
    expect(() => assertSafeTestEnv(SAFE_URL, 'newsletter_')).toThrow(/dbPrefix/)
    expect(() => assertSafeTestEnv(SAFE_URL, 'newsletter_prod_')).toThrow(/dbPrefix/)
  })

  it('accepts a localhost non-5432 throwaway with a _test_ prefix', () => {
    expect(() => assertSafeTestEnv(SAFE_URL, PREFIX)).not.toThrow()
    expect(() => assertSafeTestEnv('postgres://postgres@127.0.0.1:55434/postgres', PREFIX)).not.toThrow()
    expect(() => assertSafeTestEnv('postgresql://postgres@localhost:55434/postgres', PREFIX)).not.toThrow()
  })
})
