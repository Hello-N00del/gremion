// src/lib/server/module-switch/direct-writes.ts
// Karenz: the settings routes that write config.modules directly (PATCH /api/settings and the
// settings reset) must not switch a council-switchable module ON.
//
// A council-switchable module comes back only through the council switch: the platform request, the
// DPIA decision of a first enable and, after a restore, the Art. 17 replay of every erasure recorded
// while the module was off (a pre-apply hook of the reconciler). A direct write has none of these, so
// it would turn the module on over unreplayed erasures and ahead of the platform's own state. Switching
// a module OFF, and every module the council cannot switch, stays a plain config write.
import { SWITCHABLE_CATALOGUE_IDS, manifestIdOf } from '$lib/modules/catalogue-map'

/**
 * The manifest ids of council-switchable modules that `update` would turn from off to on. A module
 * that is already on (or has no stored value yet, which reads as on) is not a change.
 */
export function councilSwitchEnablesIn(update: Readonly<Record<string, boolean>> | undefined, current: Readonly<Record<string, boolean>> | undefined): string[] {
  const out: string[] = []
  for (const catalogueId of SWITCHABLE_CATALOGUE_IDS) {
    const manifestId = manifestIdOf(catalogueId)
    if (manifestId === null) continue
    if (update?.[manifestId] === true && current?.[manifestId] === false) out.push(manifestId)
  }
  return out
}
