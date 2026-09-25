import type { RequestHandler } from './$types'
import { RESOLUTION_CACHE_TTL_MS, resolveTenantByHost } from '$lib/server/tenant/registry'
import { normaliseHost } from '$lib/server/tenant/host'

/**
 * GET /healthz — the byte-stable liveness marker (TASK-023, B-05 option 1).
 *
 * Always 200 with `{"ok":true,"tenant":<slug|null>,"colour":"<COLOUR>"}`, keys in
 * exactly that order. It needs no host header, no proxy-trust header and no
 * tenant row, and it answers during boot: the path is on the closed
 * BOOT_AND_RESOLVE_EXEMPT_PATHS list, so neither the tenant resolver nor the
 * boot 503 runs in front of it.
 *
 * LIVENESS, NOT READINESS (Q5): a process whose boot is still running, or has
 * failed, also answers 200 here. /api/health stays the boot probe; a switch gate
 * must read it too (hand-off to TASK-040/086).
 *
 * `tenant` is the slug registered for the asked `x-forwarded-host`, or null for
 * no header, a malformed or unknown host, or a registry that is down or slower
 * than _HEALTHZ_LOOKUP_TIMEOUT_MS. It is what makes the body host-discriminating
 * for gremion-verify. Q6 (accepted, documented disclosure): anyone who can reach
 * this path can ask whether a host is a registered tenant and learn its slug.
 * Lookups go through the registry's cached host resolution; misses are memoised
 * here (bounded), and concurrent probes for one host share a single lookup, so
 * repeated probes of a host never cost one database query each. A never-seen
 * host costs one lookup, exactly as it does on the tenant resolver.
 */

/** Read once at module load (B-05). Set per colour by the deployment; '' until then. */
const COLOUR = process.env.COLOUR ?? ''

/** A registry lookup slower than this answers `tenant: null` (the probe itself never waits longer). */
export const _HEALTHZ_LOOKUP_TIMEOUT_MS = 2_000
/** Upper bound on memoised misses, so a stream of random hosts cannot grow memory. */
export const _HEALTHZ_NEGATIVE_CACHE_MAX = 256
/** A registry error or timeout is memoised for a shorter time than a genuine miss. */
const ERROR_MEMO_TTL_MS = 5_000

/** normalised host -> expiry (ms epoch) of a remembered null answer. */
const _negative = new Map<string, number>()
/** normalised host -> the lookup already in flight for it (single-flight). */
const _inflight = new Map<string, Promise<string | null>>()
/** Registry-failure warnings are rate-limited to one per ERROR_MEMO_TTL_MS window. */
let _lastWarnAt = 0
let _suppressedWarns = 0

function warnLookupFailed(reason: string): void {
  const now = Date.now()
  if (now - _lastWarnAt < ERROR_MEMO_TTL_MS) {
    _suppressedWarns++
    return
  }
  const suppressed = _suppressedWarns ? ` (${_suppressedWarns} more suppressed)` : ''
  _lastWarnAt = now
  _suppressedWarns = 0
  console.warn(`[healthz] tenant lookup failed; answering tenant=null: ${reason}${suppressed}`)
}

export function _negativeCacheSizeForTests(): number {
  return _negative.size
}

function rememberNull(host: string, ttlMs: number): void {
  _negative.delete(host)
  while (_negative.size >= _HEALTHZ_NEGATIVE_CACHE_MAX) {
    const oldest = _negative.keys().next().value
    if (oldest === undefined) break
    _negative.delete(oldest)
  }
  _negative.set(host, Date.now() + ttlMs)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lookup timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function lookupSlug(host: string): Promise<string | null> {
  try {
    const ctx = await withTimeout(resolveTenantByHost(host), _HEALTHZ_LOOKUP_TIMEOUT_MS)
    if (ctx) return ctx.slug
    rememberNull(host, RESOLUTION_CACHE_TTL_MS)
    return null
  } catch (err) {
    // The marker must stay 200 while the registry is unreachable or slow (during
    // boot, or a control-DB outage): answer null, remember it briefly, and say
    // why in the log.
    warnLookupFailed(err instanceof Error ? err.message : String(err))
    rememberNull(host, ERROR_MEMO_TTL_MS)
    return null
  }
}

function tenantSlugFor(rawHost: string | null): Promise<string | null> {
  const host = normaliseHost(rawHost)
  if (!host) return Promise.resolve(null)
  const until = _negative.get(host)
  if (until !== undefined) {
    if (until > Date.now()) return Promise.resolve(null)
    _negative.delete(host)
  }
  const pending = _inflight.get(host)
  if (pending) return pending
  const lookup = lookupSlug(host).finally(() => _inflight.delete(host))
  _inflight.set(host, lookup)
  return lookup
}

export const GET: RequestHandler = async ({ request }) => {
  const tenant = await tenantSlugFor(request.headers.get('x-forwarded-host'))
  return new Response(JSON.stringify({ ok: true, tenant, colour: COLOUR }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
