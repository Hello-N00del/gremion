// src/lib/server/module-switch/guards.ts
// Module Karenz (phase 2, Task 8): switch-off guards.
//
// A module registers a guard for its catalogue id when switching it off must be refused while
// something is still running (an open election: Helios offers no way to pause it, Task 14). The
// council switch service (Task 17) asks switchOffBlockedReason before it queues a disable and answers
// SWITCH_OFF_BLOCKED with the reason. Defined here, not in Task 17, so a module task does not depend
// on the service.
//
// First non-null reason wins and later guards are not asked. A guard that throws or rejects BLOCKS
// (fail closed): not knowing whether it is safe to switch a module off is not permission to do it.
import type { TenantContext } from '$lib/server/tenant/context'

export type SwitchOffGuard = (tenant: TenantContext) => Promise<string | null>

/** What the council sees when a guard itself failed. The cause is in the operator log only. */
export const GUARD_FAILED_REASON = 'Die Prüfung vor dem Abschalten konnte nicht ausgeführt werden. Das Modul wurde nicht abgeschaltet; bitte später erneut versuchen.'

const guards = new Map<string, SwitchOffGuard[]>()

/** Register a guard for a catalogue id. Several guards per id are allowed and asked in registration order. */
export function registerSwitchOffGuard(catalogueId: string, guard: SwitchOffGuard): void {
  const list = guards.get(catalogueId) ?? []
  list.push(guard)
  guards.set(catalogueId, list)
}

/** The reason switching `catalogueId` off is refused right now, or null when nothing objects. */
export async function switchOffBlockedReason(tenant: TenantContext, catalogueId: string): Promise<string | null> {
  for (const guard of guards.get(catalogueId) ?? []) {
    try {
      const reason = await guard(tenant)
      if (reason !== null) return reason
    } catch (err) {
      console.error(`[module-switch] the switch-off guard of ${catalogueId} failed for ${tenant.slug}; the switch-off is refused (fail closed):`, err instanceof Error ? err.message : err)
      return GUARD_FAILED_REASON
    }
  }
  return null
}

/** Test-only: drop every registered guard. */
export function _clearSwitchOffGuardsForTests(): void {
  guards.clear()
}
