// src/lib/server/tenant/conn-profile.test.ts
// P2.1b T11 — the conn_profile.perTenantMax budget clamp (pure unit contract).
//
// getPoolForTenant sizes each tenant's pool from the operator-controlled
// registry `conn_profile.perTenantMax`, so a single oversized row could
// overrun the pinned Postgres max_connections no matter what the asserted
// worst-case budget says. clampConnProfile is the WRITE-side guard: every
// registry write of conn_profile routes through it (registerTenant today,
// any future update path) so no persisted row can exceed TENANT_DB_MAX_LIMIT.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { clampConnProfile } from './conn-profile'
import {
  POOL_REGISTRY_MAX,
  ADMIN_RESERVE,
  MAX_CONNECTIONS,
  DEFAULT_DB_MAX,
  TENANT_DB_MAX_LIMIT,
} from '$lib/server/db/pool-registry'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T11 — TENANT_DB_MAX_LIMIT budget derivation', () => {
  it('worst case (every LRU slot at the clamp limit) + admin reserve fits the pinned max_connections', () => {
    expect(POOL_REGISTRY_MAX * TENANT_DB_MAX_LIMIT + ADMIN_RESERVE).toBeLessThanOrEqual(MAX_CONNECTIONS)
  })
  it('admits the default per-tenant pool size (tenant #1 byte-identical: 4 never clamps)', () => {
    expect(TENANT_DB_MAX_LIMIT).toBeGreaterThanOrEqual(DEFAULT_DB_MAX)
  })
})

describe('T11 — clampConnProfile', () => {
  it('passes the default tenant profile through UNTOUCHED (same object identity — byte-identical pin)', () => {
    const profile = { perTenantMax: 4, prepare: true }
    const out = clampConnProfile(profile, 'default')
    expect(out).toBe(profile)
    expect(out).toEqual({ perTenantMax: 4, prepare: true })
  })

  it('passes a value AT the limit through untouched and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const profile = { perTenantMax: TENANT_DB_MAX_LIMIT }
    expect(clampConnProfile(profile, 'alpha')).toBe(profile)
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves an ABSENT perTenantMax alone (resolver defaults it to DEFAULT_DB_MAX at read time)', () => {
    const profile = { prepare: false }
    expect(clampConnProfile(profile, 'alpha')).toBe(profile)
  })

  it('treats an explicit null like absent (read site falls back to the default)', () => {
    const profile = { perTenantMax: null, prepare: true }
    expect(clampConnProfile(profile, 'alpha')).toBe(profile)
  })

  it('CLAMPS an over-budget value to TENANT_DB_MAX_LIMIT and warns loudly, naming the tenant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = clampConnProfile({ perTenantMax: 64, prepare: true }, 'big-tenant')
    expect(out).toEqual({ perTenantMax: TENANT_DB_MAX_LIMIT, prepare: true })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('big-tenant')
    expect(String(warn.mock.calls[0][0])).toContain('64')
  })

  it('preserves unrelated conn_profile keys when clamping', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = clampConnProfile({ perTenantMax: 999, prepare: false, custom: 'x' }, 'alpha')
    expect(out).toEqual({ perTenantMax: TENANT_DB_MAX_LIMIT, prepare: false, custom: 'x' })
  })

  it('does NOT mutate the input profile when clamping', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const profile = { perTenantMax: 999 }
    clampConnProfile(profile, 'alpha')
    expect(profile.perTenantMax).toBe(999)
  })

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['non-integer', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', '8'],
    ['boolean', true],
  ])('REJECTS a malformed perTenantMax (%s) — a bad write is a bug, fail loud at write time', (_label, bad) => {
    expect(() => clampConnProfile({ perTenantMax: bad }, 'alpha')).toThrow(/perTenantMax/)
  })
})
