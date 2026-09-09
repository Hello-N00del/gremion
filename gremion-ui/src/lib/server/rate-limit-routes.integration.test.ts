// T3.1 (G-010) — verify the rate-limit tiers documented in
// `gremion-ui/docs/rate-limit.md` actually enforce their advertised ceilings.
//
// Scope: this file exercises the rate-limit *gate* contract (the helper that
// every guarded route ultimately funnels through), not the route handlers
// themselves.
//
// gremion#22 finding 3: the finance-mutation tier (and the hook-contract
// block that tested `financeRateLimitGuard`'s pattern match) were removed —
// this kernel ships no `/api/finance/**` route and no such hook; that
// coverage was carve residue for a helper that had no call site. See
// `rate-limit.ts` for the removal rationale.

import { vi } from 'vitest'
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => (globalThis as { __rlTenant?: string }).__rlTenant ?? 'default',
  runWithTenant: <T,>(id: string, fn: () => T) => {
    const g = globalThis as { __rlTenant?: string }
    const prev = g.__rlTenant
    g.__rlTenant = id
    try { return fn() } finally { g.__rlTenant = prev }
  },
}))

import { describe, it, expect, beforeEach } from 'vitest'
import {
  RATE_LIMITS,
  __resetRateLimits,
  checkAndIncrement,
  requireSetupRateLimit,
  requireUnsubscribeRateLimit,
  requireNewsletterSendNowRateLimit,
} from './rate-limit'
// The vi.mock above replaces runWithTenant with a string-keyed test double
// `(id: string, fn) => T`; the real export is `(ctx: TenantContext, fn) => T`.
// Type the local binding to the mock's shape so the tenant-isolation cases
// below typecheck against what actually runs.
import { runWithTenant as _runWithTenant } from '$lib/server/tenant/context'
const runWithTenant = _runWithTenant as unknown as <T>(id: string, fn: () => T) => T

beforeEach(() => __resetRateLimits())

// Drain `n` calls and return the responses (null = allowed). Used to assert
// both "first N succeed" and "(N+1)th fails" in one helper.
function drain(fn: () => Response | null, n: number): Array<Response | null> {
  const out: Array<Response | null> = []
  for (let i = 0; i < n; i++) out.push(fn())
  return out
}

describe('T3.1 rate-limit tiers', () => {
  describe('config table', () => {
    it('publishes the three documented tiers with matching limits', () => {
      // The table in docs/rate-limit.md is the contract; if these change,
      // the doc must change too. The numeric values are intentionally
      // hard-coded here rather than re-imported from RATE_LIMITS — that
      // makes a silent rewrite of the constants louder in code review.
      expect(RATE_LIMITS.setup.limit).toBe(5)
      expect(RATE_LIMITS.unsubscribe.limit).toBe(10)
      expect(RATE_LIMITS.newsletterSendNow.limit).toBe(3)
      // All tiers share a 1-hour window.
      const oneHour = 60 * 60 * 1000
      expect(RATE_LIMITS.setup.windowMs).toBe(oneHour)
      expect(RATE_LIMITS.unsubscribe.windowMs).toBe(oneHour)
      expect(RATE_LIMITS.newsletterSendNow.windowMs).toBe(oneHour)
    })
  })

  describe('Tier 1 — setup (5/hour, IP-keyed)', () => {
    it('allows the first 5 calls from one IP, then 429s the 6th', async () => {
      const ip = '10.0.0.1'
      const results = drain(() => requireSetupRateLimit(ip), 5)
      for (const r of results) expect(r).toBeNull()
      const blocked = requireSetupRateLimit(ip)
      expect(blocked).not.toBeNull()
      expect(blocked!.status).toBe(429)
      const body = await blocked!.json()
      expect(body).toMatchObject({ success: false, error: 'Rate limit exceeded' })
      expect(blocked!.headers.get('Retry-After')).toBe('60')
    })

    it('tracks IPs independently', () => {
      const a = '10.0.0.1'
      const b = '10.0.0.2'
      drain(() => requireSetupRateLimit(a), 5)
      // A is now exhausted, but B should still be fresh.
      expect(requireSetupRateLimit(a)).not.toBeNull()
      expect(requireSetupRateLimit(b)).toBeNull()
    })
  })

  describe('Tier 2 — public unsubscribe (10/hour, IP-keyed)', () => {
    it('allows 10 calls from one IP, then 429s the 11th', async () => {
      const ip = '10.0.0.3'
      const results = drain(() => requireUnsubscribeRateLimit(ip), 10)
      for (const r of results) expect(r).toBeNull()
      const blocked = requireUnsubscribeRateLimit(ip)
      expect(blocked).not.toBeNull()
      expect(blocked!.status).toBe(429)
    })

    it('does not collide with the setup tier on the same IP', () => {
      // Each tier has its own namespace prefix in the key; exhausting one
      // must not affect the other (a single corporate IP that already used
      // 5 setup calls in one hour should still be able to unsubscribe).
      const ip = '10.0.0.4'
      drain(() => requireSetupRateLimit(ip), 5)
      expect(requireSetupRateLimit(ip)).not.toBeNull()
      expect(requireUnsubscribeRateLimit(ip)).toBeNull()
    })
  })

  describe('Tier 3 — newsletter send-now (3/hour, user-id-keyed)', () => {
    it('allows 3 calls for one user, then 429s the 4th', async () => {
      const userId = 'admin-1'
      const results = drain(() => requireNewsletterSendNowRateLimit(userId), 3)
      for (const r of results) expect(r).toBeNull()
      const blocked = requireNewsletterSendNowRateLimit(userId)
      expect(blocked).not.toBeNull()
      expect(blocked!.status).toBe(429)
    })

    it('does not collide with the setup tier for the same key namespace', () => {
      // Different namespace keys must not share a bucket even if a caller
      // happens to reuse the same raw id/IP string across tiers.
      const id = 'admin-2'
      drain(() => requireNewsletterSendNowRateLimit(id), 3)
      expect(requireNewsletterSendNowRateLimit(id)).not.toBeNull()
      expect(requireSetupRateLimit(id)).toBeNull()
    })
  })

  describe('window expiry', () => {
    it('lets a key through again after its bucket expires', () => {
      // checkAndIncrement takes an injected `now` — we drive a synthetic
      // window with explicit timestamps so the test is fully deterministic
      // (no sleeps, no fake timers, no busy-wait). This exercises the
      // "bucket.resetAt <= now" branch directly.
      const key = 'test:expiry'
      const windowMs = 1000
      // First call at t=0 opens the bucket (resetAt = 1000) → allowed.
      expect(checkAndIncrement(key, 1, windowMs, 0)).toBe(true)
      // Second call at t=500 is inside the window and the limit (1) is
      // already hit → blocked.
      expect(checkAndIncrement(key, 1, windowMs, 500)).toBe(false)
      // Call at t=1000 reaches resetAt (resetAt <= now) → fresh window,
      // allowed again.
      expect(checkAndIncrement(key, 1, windowMs, 1000)).toBe(true)
    })
  })
})

describe('per-tenant bucket isolation', () => {
  beforeEach(() => __resetRateLimits())

  it('does not share the IP-keyed setup bucket across tenants', () => {
    const ip = '203.0.113.7'
    runWithTenant('a', () => drain(() => requireSetupRateLimit(ip), 5))
    runWithTenant('a', () => expect(requireSetupRateLimit(ip)).not.toBeNull())
    runWithTenant('b', () => expect(requireSetupRateLimit(ip)).toBeNull())
  })
  it('does not share the PUBLIC unsubscribe bucket across tenants (pre-auth path)', () => {
    const ip = '203.0.113.8'
    runWithTenant('a', () => drain(() => requireUnsubscribeRateLimit(ip), 10))
    runWithTenant('a', () => expect(requireUnsubscribeRateLimit(ip)).not.toBeNull())
    runWithTenant('b', () => expect(requireUnsubscribeRateLimit(ip)).toBeNull())
  })
  it('does not share the user-keyed newsletter send-now bucket across tenants', () => {
    const userId = 'u-shared'
    runWithTenant('a', () => drain(() => requireNewsletterSendNowRateLimit(userId), 3))
    runWithTenant('a', () => expect(requireNewsletterSendNowRateLimit(userId)).not.toBeNull())
    runWithTenant('b', () => expect(requireNewsletterSendNowRateLimit(userId)).toBeNull())
  })
})
