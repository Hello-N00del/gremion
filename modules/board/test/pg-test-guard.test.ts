/**
 * Negative-proof UNIT tests for the board leaf's integration-harness PG guard
 * (test/support/pg-test-guard.ts). PG-free — runs in the unit suite. Proves the
 * fail-closed posture swept from finance PR #393 (#394): an explicit
 * BOARD_TEST_PG_URL is REQUIRED, and localhost:5432 (the LIVE staging Postgres
 * on this host) — whether explicit or the implicit default port — is REJECTED
 * before any connection is attempted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireEphemeralTestPgUrl, assertSafeTestEnv, assertScratchTenantDb, SCRATCH_TENANT_DBS } from './support/pg-test-guard.ts'
import { TENANT_A, TENANT_B, TENANT_C } from './support/tenants.ts'

const ENV_VAR = 'BOARD_TEST_PG_URL'
const PREFIX = 'board_test_'
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
    expect(() => assertSafeTestEnv(SAFE_URL, 'board_')).toThrow(/dbPrefix/)
    expect(() => assertSafeTestEnv(SAFE_URL, 'board_prod_')).toThrow(/dbPrefix/)
  })

  it('accepts a localhost non-5432 throwaway with a _test_ prefix', () => {
    expect(() => assertSafeTestEnv(SAFE_URL, PREFIX)).not.toThrow()
    expect(() => assertSafeTestEnv('postgres://postgres@127.0.0.1:55434/postgres', PREFIX)).not.toThrow()
    expect(() => assertSafeTestEnv('postgresql://postgres@localhost:55434/postgres', PREFIX)).not.toThrow()
  })
})

describe('assertScratchTenantDb — a destructive suite may address only the three fixture tenant databases', () => {
  it('the fixture tenants are fixed canonical UUIDv7 ids', () => {
    for (const t of [TENANT_A, TENANT_B, TENANT_C]) {
      expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set([TENANT_A.id, TENANT_B.id, TENANT_C.id]).size).toBe(3)
  })

  it('lists exactly the three fixture (tenant, board) databases', () => {
    expect([...SCRATCH_TENANT_DBS].sort()).toEqual([
      't_0192000000007000800000000000000a__board',
      't_0192000000007000800000000000000b__board',
      't_0192000000007000800000000000000c__board',
    ])
  })

  it('accepts each fixture name', () => {
    for (const name of SCRATCH_TENANT_DBS) expect(() => assertScratchTenantDb(name)).not.toThrow()
  })

  it('rejects any other t_* name, even a well-formed (tenant, board) one', () => {
    expect(() => assertScratchTenantDb('t_0192000000007000800000000000000d__board')).toThrow(/SAFETY VIOLATION/)
    expect(() => assertScratchTenantDb('t_01999999999970008000123456789abc__board')).toThrow(/SAFETY VIOLATION/)
  })

  it("rejects a fixture tenant's database of another module (its kernel database included)", () => {
    expect(() => assertScratchTenantDb('t_0192000000007000800000000000000a__calendar')).toThrow(/SAFETY VIOLATION/)
    expect(() => assertScratchTenantDb('t_0192000000007000800000000000000a__kernel')).toThrow(/SAFETY VIOLATION/)
  })

  it('rejects platform, maintenance and legacy names, and non-strings', () => {
    for (const name of ['postgres', 'gremion_platform', 'control', 'gremion', 'stura_kernel', 'template1', '', 't_*']) {
      expect(() => assertScratchTenantDb(name), name).toThrow(/SAFETY VIOLATION/)
    }
    expect(() => assertScratchTenantDb(undefined as unknown as string)).toThrow(/SAFETY VIOLATION/)
  })
})
