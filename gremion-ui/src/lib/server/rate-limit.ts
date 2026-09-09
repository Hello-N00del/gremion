import { json } from '@sveltejs/kit'
import { currentTenantId } from '$lib/server/tenant/context'

/**
 * Simple in-memory rate limiter. Not shared across processes — sufficient
 * for single-instance deployments. Keyed by arbitrary string (typically user id).
 */
const buckets = new Map<string, { count: number; resetAt: number }>()

const ONE_HOUR_MS = 60 * 60 * 1000

// #262 D3: the Map only overwrote a bucket when the SAME key returned after
// expiry, so a key that never recurs (e.g. a one-shot scanner IP on the public
// unsubscribe endpoint) leaked its entry forever — monotonic memory growth. We
// now run an occasional full sweep that deletes every bucket whose window has
// already elapsed. The sweep is amortised: it runs at most once per
// SWEEP_INTERVAL_MS of wall-clock progression (driven by the same `now` the
// limiter already receives), so the hot path stays O(1) and the limit-check
// semantics are untouched — only entries that can no longer deny a request are
// removed.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
let lastSweepAt = 0

function sweepExpired(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/**
 * Per-tier limits — see `gremion-ui/docs/rate-limit.md` for the policy table.
 *
 * Exposed as named constants so tests and handlers stay in lockstep when a
 * limit is tuned: there is exactly one source of truth.
 *
 * gremion#22 finding 3: the finance-mutation tier (and its
 * `requireFinanceRateLimit` helper + the `financeRateLimitGuard` hook that
 * called it) were removed here. Finance is a leaf microservice, not part of
 * this governance kernel — the kernel ships no `/api/finance/**` route for
 * the guard to protect, so the tier was carve residue, not an active gate.
 * A finance vertical re-attaching that surface should add its own rate limit
 * at the leaf (or a new tier here, scoped to whatever route it actually owns).
 */
export const RATE_LIMITS = {
  /** `/api/setup/{config,admins}` — IP-keyed, 5/hour. */
  setup: { limit: 5, windowMs: ONE_HOUR_MS },
  /** `/api/newsletter/unsubscribe` — IP-keyed, 10/hour. */
  unsubscribe: { limit: 10, windowMs: ONE_HOUR_MS },
  /** `/api/newsletter/[id]/send-now` — user-id-keyed, 3/hour. */
  newsletterSendNow: { limit: 3, windowMs: ONE_HOUR_MS },
} as const

/**
 * Check whether `key` is under `limit` requests in the rolling `windowMs`
 * window, and atomically increment the counter. Returns true when the call
 * is allowed, false when the limit is exhausted.
 *
 * `now` defaults to the wall clock but can be injected so callers (notably
 * tests) can drive window expiry with explicit timestamps instead of sleeping.
 */
export function checkAndIncrement(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  sweepExpired(now)
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

/**
 * Build a uniform 429 response for handlers that hit a rate-limit ceiling.
 *
 * Matches the JSON envelope used by existing handlers (`{ success: false, error }`)
 * so consumers see a consistent shape. `Retry-After` is a conservative fixed
 * hint — we deliberately do not leak the bucket reset time per-key.
 */
function tooManyRequests(retryAfterSec = 60): Response {
  return json(
    { success: false, error: 'Rate limit exceeded' },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
    },
  )
}

/**
 * Setup config/admins gate — keyed on the requesting IP.
 *
 * Setup endpoints are only reachable with a fresh setup token, but the token
 * itself is bearer-style and brute-forceable. The IP-keyed limiter caps the
 * blast radius. Call BEFORE token validation so wrong-token attempts still
 * count.
 */
export function requireSetupRateLimit(ip: string): Response | null {
  const { limit, windowMs } = RATE_LIMITS.setup
  if (!checkAndIncrement(`${currentTenantId()}|setup:${ip}`, limit, windowMs)) {
    return tooManyRequests()
  }
  return null
}

/**
 * Public unsubscribe gate — keyed on the requesting IP.
 *
 * The endpoint is unauthenticated by design (one-click email links), so the
 * IP is the only stable identity available. Call BEFORE the token lookup
 * so failed token attempts still count.
 */
// PUBLIC pre-auth path: tenantResolveHandle (sequence element 0) MUST run before
// any rate-limit guard so currentTenantId() is set even here (spec §7.2).
export function requireUnsubscribeRateLimit(ip: string): Response | null {
  const { limit, windowMs } = RATE_LIMITS.unsubscribe
  if (!checkAndIncrement(`${currentTenantId()}|unsubscribe:${ip}`, limit, windowMs)) {
    return tooManyRequests()
  }
  return null
}

/**
 * Newsletter send-now gate — keyed on the authenticated user's id.
 *
 * Even with admin role, runaway send-now triggers can flood subscribers; the
 * 3/hour ceiling forces a deliberate sending rhythm. Call AFTER the role
 * gate so the bucket only tracks real admins.
 */
export function requireNewsletterSendNowRateLimit(userId: string): Response | null {
  const { limit, windowMs } = RATE_LIMITS.newsletterSendNow
  if (!checkAndIncrement(`${currentTenantId()}|newsletter:send:${userId}`, limit, windowMs)) {
    return tooManyRequests()
  }
  return null
}

/** Test-only helper to clear all buckets. */
export function __resetRateLimits(): void {
  buckets.clear()
  lastSweepAt = 0
}
