// src/lib/server/module-switch/leaf-guards.ts
// Switch-off guards for modules whose data lives in a leaf service's own database.
//
// A council switch-off runs the Karenz: export, block, 30 days, delete. The platform does that to the
// database the module enable gate created for the module (t_<hex>__<module>). A leaf service creates
// and fills a database of its own (calendar_<slug>), so for a leaf-backed module the export would be
// empty and the data it promises to hold and delete would be neither exported nor deleted. Until the
// two are reconciled the council switch-off is refused for such a module (guards.ts: a guard that
// answers a reason refuses, one that throws refuses too).
//
// The backend is the same environment value the module's own backend selector reads. Anything but
// "unset" and the explicit in-process value counts as a leaf (fail closed): a value this file does not
// know is the selector's problem to throw on, not a licence to switch off.
import type { SwitchOffGuard } from './guards'

/** What the council sees. German like the rest of the switch answers; no host, no database name. */
export const LEAF_BACKED_SWITCH_OFF_REASON =
  'Der Kalender läuft in dieser Installation als eigener Dienst mit eigener Datenbank. Das Ausschalten ist dafür noch nicht freigegeben, damit kein leerer Export entsteht und die Kalenderdaten nicht unberührt zurückbleiben.'

/** True when the value names anything other than the in-process backend. */
export function runsAsLeaf(backend: string | undefined): boolean {
  const v = (backend ?? '').trim().toLowerCase()
  return v !== '' && v !== 'inprocess'
}

/** The calendar's guard; `env` is injectable for tests. */
export function calendarLeafSwitchOffGuard(env: Record<string, string | undefined> = process.env): SwitchOffGuard {
  return async () => (runsAsLeaf(env.CALENDAR_BACKEND) ? LEAF_BACKED_SWITCH_OFF_REASON : null)
}
