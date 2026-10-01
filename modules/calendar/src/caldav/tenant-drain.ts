// modules/calendar/src/caldav/tenant-drain.ts
//
// F1-FIX-08-K / H06: the per-tenant CalDAV drain. Before this, every tenant's
// drain built the SAME env-fixed pusher, so all tenants' events landed in one
// Nextcloud collection. The target is now resolved PER TENANT (target.ts) and the
// drain REFUSES - pushes nothing, queue untouched - when no per-tenant target is
// configured. Refusal is loud once per (tenant, reason), not once per 30 s tick.

import type { Sql, TenantRef } from '../tenant-store.js'
import { drainCaldavQueue } from './sync.js'
import { createCalDavPusher, type CalDavPusher } from './pusher.js'
import { resolveCaldavTarget, type CaldavTarget } from './target.js'

export type DrainEnv = Record<string, string | undefined>

export interface TenantDrainDeps {
  env?: DrainEnv
  /** Injectable pusher factory (tests). Defaults to the env-backed direct pusher. */
  makePusher?: (target: CaldavTarget) => CalDavPusher
}

export interface TenantDrainResult {
  succeeded: number
  failed: number
  /** Set (and nothing was pushed) when the drain refused to run for this tenant. */
  refused?: string
}

const _warned = new Set<string>()

/** Test-only: forget which refusals were already logged. */
export function _resetTenantDrainWarnings(): void {
  _warned.clear()
}

function refuse(tenant: Pick<TenantRef, 'slug'>, reason: string): TenantDrainResult {
  const key = `${tenant.slug}::${reason}`
  if (!_warned.has(key)) {
    _warned.add(key)
    console.error(`[calendar] CalDAV drain REFUSED for tenant ${tenant.slug}: ${reason}. Nothing is pushed until it is fixed.`)
  }
  return { succeeded: 0, failed: 0, refused: reason }
}

export async function drainCaldavForTenant(
  sql: Sql,
  tenant: Pick<TenantRef, 'slug'>,
  deps: TenantDrainDeps = {},
): Promise<TenantDrainResult> {
  const env = deps.env ?? process.env

  const resolved = resolveCaldavTarget(tenant, env)
  if (!resolved.ok) return refuse(tenant, resolved.reason)

  // An empty admin password used to fall back to '' and fail every PUT as an
  // opaque 401 (K5#29 / S4#18, calendar side).
  if (!deps.makePusher && !(env.NEXTCLOUD_ADMIN_PASSWORD ?? '').trim()) {
    return refuse(tenant, 'NEXTCLOUD_ADMIN_PASSWORD is empty or unset')
  }

  const pusher = deps.makePusher
    ? deps.makePusher(resolved.target)
    : createCalDavPusher({
        adminUser: env.NEXTCLOUD_ADMIN_USER,
        adminPassword: env.NEXTCLOUD_ADMIN_PASSWORD,
        nextcloudUrl: env.NEXTCLOUD_URL,
        sharedUser: resolved.target.user,
        sharedCalendar: resolved.target.calendar,
      })

  return drainCaldavQueue(sql, pusher)
}
