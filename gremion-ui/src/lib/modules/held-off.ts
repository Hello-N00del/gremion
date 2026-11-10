// Pilot surface (operator ruling 2026-11-09): manifest ids that are pinned OFF on every read and every write of
// config.modules (config.ts), the mirror of REQUIRED_MODULES. Kept in its own import-free file so the module
// switch (service, reconciler) can refuse them without importing the config store, which tests replace.
//
// Elections only: the Helios election path is not part of the pilot. Lifting the pin is a code change, so the
// council's module switch must not offer it, accept an enable for it or report one as applied.

/** Manifest ids (config.modules keys) pinned false. */
export const HELD_OFF_MODULE_IDS: readonly string[] = Object.freeze(['elections'])

/** True when `id` (a manifest id, which equals the catalogue id for every held-off module) is pinned off. */
export function isHeldOffModule(id: string): boolean {
  return HELD_OFF_MODULE_IDS.includes(id)
}
