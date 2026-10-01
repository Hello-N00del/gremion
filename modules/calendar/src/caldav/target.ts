// modules/calendar/src/caldav/target.ts
//
// F1-FIX-08-K / H06 (K4#30): resolve the Nextcloud CalDAV collection a tenant's
// events are pushed to, PER TENANT.
//
// The old pusher read one env-fixed collection (CALDAV_SHARED_CALENDAR) for every
// tenant, so tenant B's events landed in (and tenant A's clients could read)
// tenant A's calendar. A single shared collection is therefore NO LONGER a valid
// configuration: with only the legacy CALDAV_SHARED_CALENDAR set the drain
// refuses (see tenant-drain.ts) and pushes nothing.
//
// Configuration (env; the compose wiring is the orchestrator's, see the unit's
// residuals):
//   CALDAV_TENANT_CALENDARS   JSON object { "<tenant-slug>": "<calendar name>" }.
//                             An explicit mapping; wins over the template.
//   CALDAV_CALENDAR_TEMPLATE  A name containing "{slug}", e.g. "stura-{slug}".
//   CALDAV_SHARED_USER        The Nextcloud account that owns the collections
//                             (defaults to NEXTCLOUD_ADMIN_USER).
//
// Resolution FAILS CLOSED: unparseable/ambiguous config, a path-shaped calendar
// name, or two tenants mapped to one collection all refuse, because each of them
// silently re-creates the shared-collection leak.

export interface CaldavTarget {
  user: string
  calendar: string
}

export type TargetResolution = { ok: true; target: CaldavTarget } | { ok: false; reason: string }

type Env = Record<string, string | undefined>

/** A calendar collection name is one safe path segment. */
const CALENDAR_NAME = /^[A-Za-z0-9._-]{1,64}$/

function fail(reason: string): TargetResolution {
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

export function resolveCaldavTarget(
  tenant: { slug: string },
  env: Env = process.env,
): TargetResolution {
  const user = (env.CALDAV_SHARED_USER || env.NEXTCLOUD_ADMIN_USER || 'admin').trim() || 'admin'

  const rawMap = env.CALDAV_TENANT_CALENDARS?.trim()
  if (rawMap) {
    const parsed = parseMap(rawMap)
    if (!parsed.ok) return fail(parsed.reason)
    const mapped = parsed.map.get(tenant.slug)
    if (mapped) return { ok: true, target: { user, calendar: mapped } }
  }

  const template = env.CALDAV_CALENDAR_TEMPLATE?.trim()
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
    'no per-tenant CalDAV target configured (set CALDAV_TENANT_CALENDARS or CALDAV_CALENDAR_TEMPLATE; ' +
      'a single shared CALDAV_SHARED_CALENDAR would mix tenants and is not accepted)',
  )
}
