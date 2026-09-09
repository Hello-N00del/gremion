// src/lib/server/tenant/rate-limit.ts
import { env } from '$env/dynamic/private'

/**
 * P2.1b T10 (§7.6, D-RATE): per-tenant token bucket at the resolution seam.
 *
 * tenantResolveHandle calls this with the CANONICAL tenant id right after
 * resolution + readiness, before any downstream work, so one tenant's flood
 * 429s only that tenant. Distinct from lib/server/rate-limit.ts (per-user/IP
 * fixed-window ENDPOINT limits): this is the per-TENANT fairness limit at the
 * seam (spec §7.6).
 *
 * DEFAULT OFF: with TENANT_RATE_LIMIT_RPS unset (or empty) there is no
 * limiting and no bucket state — tenant #1 stays byte-identical to today.
 * Enforcement defaults arrive with P2.1c provisioning. Process-wide env knobs
 * for now; per-tenant overrides are a registry (`conn_profile`-style) concern
 * for P2.1c.
 *
 *  - TENANT_RATE_LIMIT_RPS    sustained refill rate, tokens/second (> 0;
 *                             fractional OK). Unset/invalid ⇒ limiter OFF
 *                             (invalid warns once — misconfig must be loud,
 *                             but a typo must not take every tenant down).
 *  - TENANT_RATE_LIMIT_BURST  bucket capacity (≥ 1). Unset/invalid ⇒
 *                             ceil(RPS), i.e. one second of budget.
 *
 * Clock-injectable (`now` param, ms epoch) per the #219 lesson — tests drive
 * window expiry with explicit timestamps, never sleeps or fake timers. The
 * env is re-read per call (cheap) so ops can flip the knob without code paths
 * caching a stale config; in-memory only, per-process (matches the existing
 * limiter's single-instance posture).
 */

interface Bucket {
  /** tokens currently available (fractional during refill) */
  tokens: number
  /** injected-clock timestamp (ms) of the last refill */
  lastMs: number
}

export type TenantRateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number }

const buckets = new Map<string, Bucket>()

/** warn-once latch per distinct misconfig message (per process). */
const warned = new Set<string>()
function warnOnce(msg: string): void {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}

/** null = limiter OFF (the default). */
function readConfig(): { rps: number; burst: number } | null {
  const rawRps = env.TENANT_RATE_LIMIT_RPS
  if (rawRps === undefined || rawRps === '') return null // default OFF
  const rps = Number(rawRps)
  if (!Number.isFinite(rps) || rps <= 0) {
    warnOnce(
      `[tenant-rate-limit] invalid TENANT_RATE_LIMIT_RPS=${JSON.stringify(rawRps)} — limiter stays OFF`,
    )
    return null
  }
  let burst = Math.max(1, Math.ceil(rps))
  const rawBurst = env.TENANT_RATE_LIMIT_BURST
  if (rawBurst !== undefined && rawBurst !== '') {
    const b = Number(rawBurst)
    if (Number.isFinite(b) && b >= 1) {
      burst = Math.floor(b)
    } else {
      warnOnce(
        `[tenant-rate-limit] invalid TENANT_RATE_LIMIT_BURST=${JSON.stringify(rawBurst)} — using default burst ${burst}`,
      )
    }
  }
  return { rps, burst }
}

/**
 * Take one token from `tenantId`'s bucket. Returns `{ allowed: true }` when the
 * request may proceed, or `{ allowed: false, retryAfterSec }` (whole seconds,
 * ≥ 1 — sized so ONE full token has refilled) when the tenant is over budget.
 *
 * `now` defaults to the wall clock; tests inject explicit timestamps. A clock
 * that moves backwards is clamped (no negative refill, no throw).
 */
export function checkTenantRateLimit(tenantId: string, now: number = Date.now()): TenantRateLimitResult {
  const cfg = readConfig()
  if (!cfg) return { allowed: true }
  const { rps, burst } = cfg

  let bucket = buckets.get(tenantId)
  if (!bucket) {
    bucket = { tokens: burst, lastMs: now }
    buckets.set(tenantId, bucket)
  } else {
    const elapsedMs = Math.max(0, now - bucket.lastMs) // backwards clock ⇒ no refill
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsedMs / 1000) * rps)
    bucket.lastMs = now
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { allowed: true }
  }
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / rps)) }
}

/** Test-only: clear all buckets and warn-once latches. */
export function __resetTenantRateLimit(): void {
  buckets.clear()
  warned.clear()
}
