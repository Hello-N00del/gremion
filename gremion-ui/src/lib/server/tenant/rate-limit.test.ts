// P2.1b T10 (§7.6, D-RATE): per-tenant token bucket at the resolution seam.
// Every test drives the bucket with an EXPLICIT injected clock (`now` param) —
// never wall time, never sleeps (#219 lesson: no flaky time tests). Tenant
// identity is an explicit parameter here (the seam calls the limiter with the
// canonical ctx.id BEFORE entering runWithTenant), so no ALS default applies.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// $env/dynamic/private snapshots process.env at module init — swap it for a
// mutable mock so each test can toggle the limiter env without re-importing.
const envMock = vi.hoisted(() => ({}) as Record<string, string | undefined>)
vi.mock('$env/dynamic/private', () => ({ env: envMock }))

const { checkTenantRateLimit, __resetTenantRateLimit } = await import('./rate-limit')

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k]
  __resetTenantRateLimit()
})

describe('checkTenantRateLimit — default OFF (tenant #1 byte-identical pin)', () => {
  it('allows EVERY call when TENANT_RATE_LIMIT_RPS is unset — no limiting, ever', () => {
    for (let i = 0; i < 500; i++) {
      expect(checkTenantRateLimit('tid-default', 0)).toEqual({ allowed: true })
    }
  })

  it('stays OFF for an empty-string RPS', () => {
    envMock.TENANT_RATE_LIMIT_RPS = ''
    for (let i = 0; i < 50; i++) {
      expect(checkTenantRateLimit('tid-default', 0)).toEqual({ allowed: true })
    }
  })

  it('stays OFF (one loud warn, never a throw) for an unparseable or non-positive RPS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of ['abc', '0', '-3', 'NaN']) {
        envMock.TENANT_RATE_LIMIT_RPS = bad
        expect(checkTenantRateLimit('tid-default', 0)).toEqual({ allowed: true })
        expect(checkTenantRateLimit('tid-default', 0)).toEqual({ allowed: true })
      }
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('checkTenantRateLimit — enabled token bucket', () => {
  it('throttles tenant A at the burst ceiling while tenant B is UNAFFECTED', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '1'
    envMock.TENANT_RATE_LIMIT_BURST = '2'
    expect(checkTenantRateLimit('tid-a', 0)).toEqual({ allowed: true })
    expect(checkTenantRateLimit('tid-a', 0)).toEqual({ allowed: true })
    const third = checkTenantRateLimit('tid-a', 0)
    expect(third.allowed).toBe(false)
    if (!third.allowed) expect(third.retryAfterSec).toBeGreaterThanOrEqual(1)
    // tenant B at the SAME instant: its own bucket, full burst available.
    expect(checkTenantRateLimit('tid-b', 0)).toEqual({ allowed: true })
    expect(checkTenantRateLimit('tid-b', 0)).toEqual({ allowed: true })
    // and tenant A is STILL throttled afterwards (B's spend never drains A).
    expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(false)
  })

  it('refills at RPS under the injected clock (no sleeping, no fake timers)', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '1'
    envMock.TENANT_RATE_LIMIT_BURST = '1'
    expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(true)
    expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(false) // bucket empty
    expect(checkTenantRateLimit('tid-a', 500).allowed).toBe(false) // 0.5 token — not yet
    expect(checkTenantRateLimit('tid-a', 1500).allowed).toBe(true) // ≥1 full token refilled
    expect(checkTenantRateLimit('tid-a', 1500).allowed).toBe(false) // spent again
  })

  it('caps the refill at the burst ceiling (a long idle gap never banks extra tokens)', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '1'
    envMock.TENANT_RATE_LIMIT_BURST = '2'
    // drain the bucket at t=0
    checkTenantRateLimit('tid-a', 0)
    checkTenantRateLimit('tid-a', 0)
    // one hour idle ⇒ refill clamps to burst (2), NOT 3600 tokens
    expect(checkTenantRateLimit('tid-a', 3_600_000).allowed).toBe(true)
    expect(checkTenantRateLimit('tid-a', 3_600_000).allowed).toBe(true)
    expect(checkTenantRateLimit('tid-a', 3_600_000).allowed).toBe(false)
  })

  it('defaults the burst to ceil(RPS) when TENANT_RATE_LIMIT_BURST is unset', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '5'
    for (let i = 0; i < 5; i++) {
      expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(true)
    }
    expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(false)
  })

  it('reports a Retry-After that covers a full token at fractional RPS', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '0.5' // one token every 2s
    envMock.TENANT_RATE_LIMIT_BURST = '1'
    expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(true)
    const denied = checkTenantRateLimit('tid-a', 0)
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) expect(denied.retryAfterSec).toBe(2)
  })

  it('never refills on a clock that moves BACKWARDS (clamped, not thrown)', () => {
    envMock.TENANT_RATE_LIMIT_RPS = '1'
    envMock.TENANT_RATE_LIMIT_BURST = '1'
    expect(checkTenantRateLimit('tid-a', 1000).allowed).toBe(true)
    expect(checkTenantRateLimit('tid-a', 1000).allowed).toBe(false)
    expect(checkTenantRateLimit('tid-a', 500).allowed).toBe(false) // regression ⇒ no refill
  })

  it('falls back to the default burst (loud warn) when BURST is unparseable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      envMock.TENANT_RATE_LIMIT_RPS = '1'
      envMock.TENANT_RATE_LIMIT_BURST = 'lots'
      expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(true) // burst = ceil(1) = 1
      expect(checkTenantRateLimit('tid-a', 0).allowed).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
