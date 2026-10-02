// gremion-ui/src/lib/server/calendar/caldav-target.ts
//
// F1-FIX-08 (H06 / K4#30), in-process twin of services/calendar/src/caldav/target.ts
// (byte-equivalent rules; the leaf is a separate process, so the code is mirrored).
//
// The in-process drain used to push every ACTIVE tenant's events into one
// env-fixed collection. Each tenant now resolves its OWN collection:
//   CALDAV_TENANT_CALENDARS     `slug=calendar` or `slug=user/calendar` entries
//   CALDAV_DEFAULT_TENANT_SLUG  the ONE tenant that keeps the legacy pair
//                               CALDAV_SHARED_USER / CALDAV_SHARED_CALENDAR
//                               (default slug `default`, calendar `stura`)
// User part defaults to CALDAV_SHARED_USER, else NEXTCLOUD_ADMIN_USER, else
// `admin`. An unconfigured tenant, or two tenants on one collection, is refused.

export interface CaldavTarget {
  readonly user: string
  readonly calendar: string
}

export type CaldavTargetResult =
  | { readonly ok: true; readonly target: CaldavTarget }
  | { readonly ok: false; readonly reason: string }

type Env = Record<string, string | undefined>

const DEFAULT_TENANT_SLUG = 'default'
const DEFAULT_CALENDAR = 'stura'

function defaultUser(env: Env): string {
  return env.CALDAV_SHARED_USER || env.NEXTCLOUD_ADMIN_USER || 'admin'
}

export function configuredCaldavTargets(env: Env): Map<string, CaldavTarget> {
  const map = new Map<string, CaldavTarget>()
  const legacySlug = (env.CALDAV_DEFAULT_TENANT_SLUG ?? DEFAULT_TENANT_SLUG).trim()
  if (legacySlug) {
    map.set(legacySlug, { user: defaultUser(env), calendar: env.CALDAV_SHARED_CALENDAR || DEFAULT_CALENDAR })
  }
  for (const raw of (env.CALDAV_TENANT_CALENDARS ?? '').split(/[\s,]+/)) {
    const entry = raw.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0 || eq === entry.length - 1) continue
    const slug = entry.slice(0, eq)
    const value = entry.slice(eq + 1)
    const slash = value.indexOf('/')
    const target =
      slash > 0 && slash < value.length - 1
        ? { user: value.slice(0, slash), calendar: value.slice(slash + 1) }
        : { user: defaultUser(env), calendar: value }
    map.set(slug, target)
  }
  return map
}

export function resolveCaldavTarget(tenant: { readonly slug: string }, env: Env = process.env): CaldavTargetResult {
  const all = configuredCaldavTargets(env)
  const target = all.get(tenant.slug)
  if (!target) {
    return {
      ok: false,
      reason:
        `no CalDAV target configured for tenant '${tenant.slug}' ` +
        '(add it to CALDAV_TENANT_CALENDARS); refusing to push into another tenant\'s calendar',
    }
  }
  for (const [slug, other] of all) {
    if (slug !== tenant.slug && other.user === target.user && other.calendar === target.calendar) {
      return {
        ok: false,
        reason:
          `CalDAV collection ${target.user}/${target.calendar} is shared by tenants ` +
          `'${tenant.slug}' and '${slug}'; refusing to drain either`,
      }
    }
  }
  return { ok: true, target }
}
