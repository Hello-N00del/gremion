import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

// Calendar is a toggleable module that owns the /calendar page segment and its
// route prefixes. Split out of core.ts (Task 0) so the calendar data plane can
// be extracted to the leaf service (feat/calendar-service-l4). toggleable:true
// allows per-tenant calendar disable; the flag defaults ON (defaultModulesConfig
// sources toggleable ids from MODULE_MANIFESTS and sets each true by default).
//
// DELIBERATELY no `migrations` key (#372): calendar_events
// (migrations/003_calendar_schema.sql) stays KERNEL-applied. 008_public_portal.sql
// is a cross-cutting kernel migration (attributed to no manifest, therefore
// always applied) that UNCONDITIONALLY runs
// `ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_public ...`, so gating
// 003 behind the calendar toggle breaks a FRESH calendar-OFF init (relation
// "calendar_events" does not exist → migration txn aborts → the stack cannot
// boot). Re-gating is pinned OFF by calendar.test.ts, module-migrations.test.ts
// and migration-ownership.test.ts.
export const calendarManifest: ModuleManifest = {
  id: 'calendar',
  order: 70,
  toggleable: true,
  pages: [{ segment: 'calendar', minRole: Role.Guest }],
  routePrefixes: ['/calendar', '/api/calendar'],
}
