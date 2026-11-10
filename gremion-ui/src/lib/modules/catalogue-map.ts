// Catalogue id <-> manifest id map for the council module switch (Karenz phase 1).
//
// Two vocabularies meet here. The PLATFORM knows catalogue ids (plt.module,
// modules/<id>/module.json): `calendar`, `elections`, `votes`, `messaging`,
// `publishing`, ... The APP knows manifest ids (config.modules keys,
// MODULE_MANIFESTS): `calendar`, `elections`, `votes`, `messages`, `newsletter`, ...
// A switch request carries the catalogue id; applying the result flips the
// manifest id in config.modules. manifestIdOf / catalogueIdOf are the ONLY place
// the two are related.
//
// The council-switchable set is an explicit, pinned list, not "every toggleable
// manifest": files, messages and newsletter also carry toggleable manifests, but
// switching them off is a product decision with its own Karenz work (Open
// Decision 8 of the plan), so they are HELD BACK and refused MODULE_NOT_SWITCHABLE.
// catalogue-map.test.ts fails when a new toggleable manifest or shipped module is
// not classified as exactly one of the two.
//
// Client-safe: no server imports.
import { MODULE_MANIFESTS } from './manifests'

/**
 * Catalogue ids refused by name for every enable path: board (not tenant-isolated
 * yet) and vault (stays off for the pilot). A copy of @gremion/provisioning
 * DEFAULT_DENY, kept local so client code never imports the provisioning library;
 * the unit test pins the two lists equal.
 */
export const DENIED_BY_NAME: ReadonlySet<string> = new Set(['board', 'vault'])

/**
 * Catalogue ids a council admin may switch. Each owns a toggleable manifest of
 * the same id (no renames in phase 1) and declares `status.label`.
 */
export const SWITCHABLE_CATALOGUE_IDS: ReadonlySet<string> = new Set(['calendar', 'elections', 'votes'])

/**
 * Shipped catalogue ids that a council admin may NOT switch, with the reason.
 * Together with SWITCHABLE_CATALOGUE_IDS this covers every shipped module; the
 * test pins it against modules/<id>/module.json.
 */
export const HELD_BACK_CATALOGUE_IDS: Readonly<Record<string, string>> = Object.freeze({
  board: 'denied by name: not tenant-isolated yet',
  content: 'held back: switching it off needs its own retention and Karenz work before a council may do it',
  files: 'held back: switching it off needs its own retention and Karenz work before a council may do it',
  messaging: 'held back: switching it off needs its own retention and Karenz work before a council may do it',
  publishing: 'held back: switching it off needs its own retention and Karenz work before a council may do it',
  handover: 'held back: it owns no toggleable manifest, so there is nothing to switch',
})

/** The manifest id (config.modules key) of a switchable catalogue id, else null. */
export function manifestIdOf(catalogueId: string): string | null {
  if (!SWITCHABLE_CATALOGUE_IDS.has(catalogueId)) return null
  return MODULE_MANIFESTS.some((m) => m.id === catalogueId && m.toggleable) ? catalogueId : null
}

/** The catalogue id of a switchable manifest id, else null. Inverse of manifestIdOf. */
export function catalogueIdOf(manifestId: string): string | null {
  if (!SWITCHABLE_CATALOGUE_IDS.has(manifestId)) return null
  return manifestIdOf(manifestId) === manifestId ? manifestId : null
}

export interface TogglePair {
  catalogueId: string
  manifestId: string
  /** The module's own status.label: what the admin sees AND the confirmation phrase. */
  label: string
}

/**
 * One entry per switchable module, with the label its own manifest declares. A
 * switchable manifest without status.label is a build-time bug (the unit test
 * fails); here it would fall back to the raw id, which the test refuses.
 */
export const TOGGLEABLE_PAIRS: readonly TogglePair[] = MODULE_MANIFESTS.filter((m) => m.toggleable)
  .map((m) => ({ m, catalogueId: catalogueIdOf(m.id) }))
  .filter((x): x is { m: (typeof MODULE_MANIFESTS)[number]; catalogueId: string } => x.catalogueId !== null)
  .map(({ m, catalogueId }) => ({ catalogueId, manifestId: m.id, label: m.status?.label ?? m.id }))

/**
 * The typed-name confirmation rule (Tasks 11 and 12): NFC-exact. Case-sensitive,
 * no trimming, no folding of look-alikes. A decomposed umlaut equals the composed
 * one (a keyboard may produce either); everything else must match as typed.
 */
export function confirmationMatches(typed: unknown, label: string): boolean {
  if (typeof typed !== 'string' || typed.length === 0) return false
  return typed.normalize('NFC') === label.normalize('NFC')
}
