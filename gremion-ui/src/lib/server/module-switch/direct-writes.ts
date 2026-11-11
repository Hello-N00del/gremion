// src/lib/server/module-switch/direct-writes.ts
// Karenz: the settings routes that write config.modules directly (PATCH /api/settings and the
// settings reset) must not switch a council-switchable module ON.
//
// A council-switchable module comes back only through the council switch: the platform request, the
// DPIA decision of a first enable and, after a restore, the Art. 17 replay of every erasure recorded
// while the module was off (a pre-apply hook of the reconciler). A direct write has none of these, so
// it would turn the module on over unreplayed erasures and ahead of the platform's own state. Switching
// a module OFF, and every module the council cannot switch and the platform does not hold off, stays a plain config write.
import { SWITCHABLE_CATALOGUE_IDS, manifestIdOf } from '$lib/modules/catalogue-map'

/**
 * The manifest ids of modules that `update` would turn from off to on and that a direct write may not turn on:
 * the council-switchable modules, and every module in `heldOffByPlatform` (the modules the platform currently
 * holds off, see platform-held.ts: a platform disable of the board is not undone by a settings write; the
 * reconciler follows the platform enable). A module that is already on (or has no stored value yet, which
 * reads as on) is not a change.
 */
export function councilSwitchEnablesIn(
  update: Readonly<Record<string, boolean>> | undefined,
  current: Readonly<Record<string, boolean>> | undefined,
  heldOffByPlatform: readonly string[] = [],
): string[] {
  const guarded = new Set<string>(heldOffByPlatform)
  for (const catalogueId of SWITCHABLE_CATALOGUE_IDS) {
    const manifestId = manifestIdOf(catalogueId)
    if (manifestId !== null) guarded.add(manifestId)
  }
  const out: string[] = []
  for (const manifestId of guarded) {
    if (update?.[manifestId] === true && current?.[manifestId] === false) out.push(manifestId)
  }
  return out
}
