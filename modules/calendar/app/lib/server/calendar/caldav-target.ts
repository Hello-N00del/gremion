// gremion-ui/src/lib/server/calendar/caldav-target.ts
//
// F1-FIX-08 (H06 / K4#30), in-process twin of modules/calendar/src/caldav/target.ts (the leaf is a separate
// process, so the rules are mirrored, not shared).
//
// KERNEL RULES (TASK-205a, replacing the source file that kept a "legacy pair" for one default tenant):
// under TASK-042 no tenant is special, so every tenant resolves its OWN collection and nothing is implied
// for any slug.
//   CALDAV_TENANT_CALENDARS   JSON object { "<tenant-slug>": "<calendar name>" }; an explicit mapping, wins
//                             over the template.
//   CALDAV_CALENDAR_TEMPLATE  a name containing "{slug}", e.g. "stura-{slug}".
//   CALDAV_SHARED_USER        the Nextcloud account that owns the collections (defaults to
//                             NEXTCLOUD_ADMIN_USER).
// Resolution FAILS CLOSED: unparseable config, a path-shaped calendar name, two tenants on one collection,
// or no mapping for the tenant all refuse, because each of them silently re-creates the shared-collection
// leak. A lone CALDAV_SHARED_CALENDAR is NOT a configuration (it would mix tenants).

import { serviceEnv } from '$lib/server/env/service-env'

export interface CaldavTarget {
  readonly user: string
  readonly calendar: string
}

export type CaldavTargetResult =
  | { readonly ok: true; readonly target: CaldavTarget }
  | { readonly ok: false; readonly reason: string }

type Env = Record<string, string | undefined>

/** A calendar collection name is one safe path segment. */
const CALENDAR_NAME = /^[A-Za-z0-9._-]{1,64}$/

function fail(reason: string): CaldavTargetResult {
  return { ok: false, reason }
}

function parseMap(raw: string): { ok: true; map: Map<string, string> } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'CALDAV_TENANT_CALENDARS is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'CALDAV_TENANT_CALENDARS must be a JSON object of slug -> calendar name' }
  }
  const map = new Map<string, string>()
  for (const [slug, name] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name !== 'string' || !CALENDAR_NAME.test(name)) {
      return { ok: false, reason: `CALDAV_TENANT_CALENDARS entry for "${slug}" is not a safe calendar name` }
    }
    map.set(slug, name)
  }
  // Two tenants on one collection is the very leak this exists to prevent.
  if (new Set(map.values()).size !== map.size) {
    return { ok: false, reason: 'CALDAV_TENANT_CALENDARS maps two tenants to the same calendar' }
  }
  return { ok: true, map }
}

/**
 * The configuration this resolver reads in production: the two service-account names through the
 * service-endpoint seam (CALDAV_SHARED_USER and NEXTCLOUD_ADMIN_USER are per-tenant-classed under TASK-042,
 * so they never come from a bare process.env read), the two CalDAV maps straight from the process.
 */
export function serviceCaldavVars(): Env {
  return {
    CALDAV_SHARED_USER: serviceEnv('CALDAV_SHARED_USER'),
    NEXTCLOUD_ADMIN_USER: serviceEnv('NEXTCLOUD_ADMIN_USER'),
    CALDAV_TENANT_CALENDARS: process.env.CALDAV_TENANT_CALENDARS,
    CALDAV_CALENDAR_TEMPLATE: process.env.CALDAV_CALENDAR_TEMPLATE,
  }
}

export function resolveCaldavTarget(tenant: { readonly slug: string }, vars: Env = serviceCaldavVars()): CaldavTargetResult {
  const user = (vars.CALDAV_SHARED_USER || vars.NEXTCLOUD_ADMIN_USER || 'admin').trim() || 'admin'

  const rawMap = vars.CALDAV_TENANT_CALENDARS?.trim()
  if (rawMap) {
    const parsed = parseMap(rawMap)
    if (!parsed.ok) return fail(parsed.reason)
    const mapped = parsed.map.get(tenant.slug)
    if (mapped) return { ok: true, target: { user, calendar: mapped } }
  }

  const template = vars.CALDAV_CALENDAR_TEMPLATE?.trim()
  if (template) {
    if (!template.includes('{slug}')) {
      return fail('CALDAV_CALENDAR_TEMPLATE must contain {slug}; without it every tenant shares one collection')
    }
    const name = template.split('{slug}').join(tenant.slug)
    if (!CALENDAR_NAME.test(name)) {
      return fail(`CALDAV_CALENDAR_TEMPLATE yields an unsafe calendar name for tenant ${tenant.slug}`)
    }
    return { ok: true, target: { user, calendar: name } }
  }

  return fail(
    `no CalDAV target configured for tenant '${tenant.slug}' (set CALDAV_TENANT_CALENDARS or CALDAV_CALENDAR_TEMPLATE; ` +
      "a single shared CALDAV_SHARED_CALENDAR would mix tenants and is not accepted); refusing to push into another tenant's calendar",
  )
}
