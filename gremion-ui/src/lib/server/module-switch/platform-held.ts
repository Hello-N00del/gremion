// src/lib/server/module-switch/platform-held.ts
// The modules the PLATFORM currently holds off for a tenant (a platform disable of a module the council
// cannot switch, e.g. the board), as the reconciler last saw it. The reconciler writes it; the direct
// settings writes (PATCH /api/settings, the settings reset) read it, so a tenant admin cannot turn such a
// module back on while the platform still says disabled.
//
// Kept in its own small module so the settings routes do not pull in the reconciler and its database
// access. Process-local, like the reconciler's own state: it is rebuilt by the first alignment pass.
import { getTenant } from '$lib/server/tenant/context'

const held = new Map<string, Set<string>>()

/** Record, for one tenant, whether the platform holds a module (manifest id) off. */
export function rememberPlatformHeld(tenantId: string, manifestId: string, heldOff: boolean): void {
  let set = held.get(tenantId)
  if (!set) {
    set = new Set()
    held.set(tenantId, set)
  }
  if (heldOff) set.add(manifestId)
  else set.delete(manifestId)
}

/** The manifest ids the platform holds off for this tenant. */
export function platformHeldOffModules(tenantId: string): string[] {
  return [...(held.get(tenantId) ?? [])]
}

/**
 * The same for the tenant of the current request. Outside a tenant scope nothing is held (the settings
 * routes cannot run there anyway: reading the config needs the tenant).
 */
export function platformHeldOffForCurrentTenant(): string[] {
  try {
    return platformHeldOffModules(getTenant().id)
  } catch {
    return []
  }
}

/** Test-only. */
export function _clearPlatformHeldForTests(): void {
  held.clear()
}
