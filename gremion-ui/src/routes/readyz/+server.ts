import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { getBootStatus } from '../../hooks.server'
import { getControlDb } from '$lib/server/tenant/control-db'
import { constantTimeEqual } from '$lib/server/internal-fetch'
import { getTenantReadinessCounts } from '$lib/server/tenant/readiness'

/**
 * GET /readyz — the readiness probe.
 *
 * /healthz is liveness: a still-booting or boot-failed process also answers 200.
 * This is the probe a release gate can believe. `ready` means: boot has finished
 * AND the control database answers a ping. The tenant state is NOT part of it
 * (a customer whose tenant is failed would otherwise fail every
 * release for a reason the release did not cause); the internal answer carries
 * the counts so the caller can compare them with the live colour instead.
 *
 * Two answers, one path:
 *  - ANONYMOUS (any caller, through any customer host: the path is on the closed
 *    boot-and-resolve exempt list, so no resolver, session or boot 503 runs in
 *    front of it): exactly `{"ready":true}` (200) or `{"ready":false}` (503).
 *    Nothing else: no colour, release, counts or reasons.
 *  - INTERNAL (a request carrying `Authorization: Bearer <INTERNAL_PUSH_SECRET>`,
 *    compared in constant time; the release tool reads the secret by docker exec
 *    inside the container, so it never travels the edge):
 *    `{"ready","colour","release","tenants":{"total","notReady"},"reasons":[]}`
 *    with reasons from `boot` | `control_db`. Counts only, never a slug, a host,
 *    an address or an error message.
 *  A wrong, empty or differently sized bearer, an unset or short secret, and any
 *  unexpected error all get the anonymous answer: nothing tells them apart.
 *
 * Cost: the control ping is memoised for 5 s (success and failure alike) and
 * shared by every caller, so a flood of anonymous requests is at most one ping
 * per 5 s. Before boot completes no ping is made at all. The handler makes no
 * other outbound call: no tenant database, no registry, no module service, no
 * Matrix.
 */

/** A ping answer, success or failure, is reused for this long. */
export const _READYZ_PING_MEMO_MS = 5_000
/** A ping that has not answered by then counts as failed. */
export const _READYZ_PING_TIMEOUT_MS = 3_000
/** Same floor as the evict route: a shorter configured secret is refused. */
const MIN_SECRET_LEN = 16

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const

let _memo: { until: number; result: Promise<boolean> } | null = null

async function pingControlOnce(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), _READYZ_PING_TIMEOUT_MS)
    })
    // Rejected promises are settled by the race below; a late answer of the
    // losing side is swallowed, never unhandled.
    const ping = Promise.resolve(getControlDb()`SELECT 1`)
    ping.catch(() => {})
    await Promise.race([ping, timeout])
    return true
  } catch (err) {
    // Class only: the message of a database error can name a host or a role.
    console.warn(`[readyz] control database ping failed (${err instanceof Error ? err.name : 'error'})`)
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The control ping, memoised: one real ping per window whatever the request rate. */
function controlPing(): Promise<boolean> {
  const now = Date.now()
  if (_memo && now < _memo.until) return _memo.result
  const result = pingControlOnce()
  _memo = { until: now + _READYZ_PING_MEMO_MS, result }
  return result
}

function isInternalCaller(request: Request): boolean {
  const secret = env.INTERNAL_PUSH_SECRET ?? process.env.INTERNAL_PUSH_SECRET
  if (!secret || secret.length < MIN_SECRET_LEN) return false
  const got = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? ''
  return got !== '' && constantTimeEqual(got, secret)
}

function answer(body: Record<string, unknown>, ready: boolean): Response {
  return new Response(JSON.stringify(body), { status: ready ? 200 : 503, headers: HEADERS })
}

export const GET: RequestHandler = async ({ request }) => {
  try {
    const bootComplete = getBootStatus().complete
    const controlOk = bootComplete ? await controlPing() : false
    const ready = bootComplete && controlOk
    if (!isInternalCaller(request)) return answer({ ready }, ready)

    const reasons: string[] = []
    if (!bootComplete) reasons.push('boot')
    else if (!controlOk) reasons.push('control_db')
    return answer(
      {
        ready,
        colour: process.env.COLOUR ?? '',
        release: process.env.GREMION_RELEASE_REF ?? '',
        tenants: getTenantReadinessCounts(),
        reasons,
      },
      ready,
    )
  } catch {
    // Never an error page and never a different shape: the bare "not ready".
    return answer({ ready: false }, false)
  }
}
