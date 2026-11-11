// Guard for the catalogue id <-> manifest id map the council module switch uses
// (Karenz phase 1, Task 10). The platform knows catalogue ids (plt.module), the
// app knows manifest ids (config.modules keys). This map is the single place
// that relates them, and the council-switchable set is an explicit, pinned list.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { DEFAULT_DENY } from '@gremion/provisioning'
import { MODULE_MANIFESTS } from './registry'
import {
  DENIED_BY_NAME,
  HELD_BACK_CATALOGUE_IDS,
  SWITCHABLE_CATALOGUE_IDS,
  TOGGLEABLE_PAIRS,
  catalogueIdOf,
  confirmationMatches,
  manifestIdOf,
} from './catalogue-map'

const MODULES_DIR = resolve(__dirname, '../../../../modules')

/** Catalogue ids the repo ships: modules/<id>/module.json, minus modules/disabled.json. */
function shippedCatalogueIds(): string[] {
  const disabled = new Set(
    (JSON.parse(readFileSync(resolve(MODULES_DIR, 'disabled.json'), 'utf8')) as { disabled: { id: string }[] }).disabled.map((d) => d.id),
  )
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(MODULES_DIR, e.name, 'module.json')))
    .map((e) => (JSON.parse(readFileSync(resolve(MODULES_DIR, e.name, 'module.json'), 'utf8')) as { id: string }).id)
    .filter((id) => !disabled.has(id))
    .sort()
}

/** The manifest id each HELD-BACK catalogue id registers under (they differ for two). */
const HELD_BACK_MANIFEST_IDS: Readonly<Record<string, string>> = {
  content: 'content',
  files: 'files',
  messaging: 'messages',
  publishing: 'newsletter',
  board: 'board',
}

describe('SWITCHABLE_CATALOGUE_IDS', () => {
  it('is exactly calendar, elections, votes', () => {
    expect([...SWITCHABLE_CATALOGUE_IDS].sort()).toEqual(['calendar', 'elections', 'votes'])
  })

  it('every switchable id owns a toggleable manifest of the same id and is not denied', () => {
    for (const id of SWITCHABLE_CATALOGUE_IDS) {
      const m = MODULE_MANIFESTS.find((x) => x.id === id)
      expect(m, `no manifest for ${id}`).toBeDefined()
      expect(m!.toggleable, `${id} manifest must be toggleable`).toBe(true)
      expect(DEFAULT_DENY.has(id)).toBe(false)
    }
  })

  it('the local deny copy equals the provisioning deny list (no drift)', () => {
    expect([...DENIED_BY_NAME].sort()).toEqual([...DEFAULT_DENY].sort())
  })
})

describe('manifestIdOf / catalogueIdOf', () => {
  it('maps each switchable id to itself and back', () => {
    for (const id of SWITCHABLE_CATALOGUE_IDS) {
      expect(manifestIdOf(id)).toBe(id)
      expect(catalogueIdOf(id)).toBe(id)
    }
  })

  it('content, publishing, messaging, files, handover and board are not switchable and map to null', () => {
    for (const id of ['content', 'publishing', 'messaging', 'files', 'handover', 'board']) {
      expect(SWITCHABLE_CATALOGUE_IDS.has(id)).toBe(false)
      expect(manifestIdOf(id)).toBeNull()
    }
  })

  it('the manifest ids newsletter, messages, files and board have no catalogue id here (no renames in phase 1)', () => {
    for (const id of ['newsletter', 'messages', 'files', 'board', 'core', 'governance', 'nope']) {
      expect(catalogueIdOf(id)).toBeNull()
    }
  })

  it('every toggleable manifest is either switchable or explicitly held back (a new toggleable manifest must be classified)', () => {
    const toggleable = MODULE_MANIFESTS.filter((m) => m.toggleable).map((m) => m.id)
    const heldManifestIds = new Set(Object.values(HELD_BACK_MANIFEST_IDS))
    for (const id of toggleable) {
      const switchable = SWITCHABLE_CATALOGUE_IDS.has(id)
      const held = heldManifestIds.has(id)
      expect(switchable !== held, `toggleable manifest ${id} must be exactly one of switchable or held back`).toBe(true)
    }
  })

  it('every shipped (not disabled) module.json id is exactly one of switchable or held back, and the lists pin the repo tree', () => {
    for (const id of shippedCatalogueIds()) {
      const switchable = SWITCHABLE_CATALOGUE_IDS.has(id)
      const held = id in HELD_BACK_CATALOGUE_IDS
      expect(switchable !== held, `catalogue id ${id} must be exactly one of switchable or held back`).toBe(true)
    }
    // the held-back list names no id the repo does not ship (a stale entry hides a rename)
    const shipped = new Set(shippedCatalogueIds())
    for (const id of Object.keys(HELD_BACK_CATALOGUE_IDS)) {
      expect(shipped.has(id) || DEFAULT_DENY.has(id), `held-back id ${id} is not shipped`).toBe(true)
    }
  })

  it('every held-back id carries a reason', () => {
    for (const [id, reason] of Object.entries(HELD_BACK_CATALOGUE_IDS)) {
      expect(reason.length, id).toBeGreaterThan(20)
    }
  })
})

describe('TOGGLEABLE_PAIRS', () => {
  it('has one entry per switchable id and carries the manifest status.label, never the raw id', () => {
    expect(TOGGLEABLE_PAIRS.map((p) => p.catalogueId).sort()).toEqual(['calendar', 'elections', 'votes'])
    const byId = Object.fromEntries(TOGGLEABLE_PAIRS.map((p) => [p.catalogueId, p]))
    expect(byId.votes!.label).toBe('Abstimmungen')
    expect(byId.elections!.label).toBe('Wahlen')
    expect(byId.calendar!.label).toBe('Kalender')
    for (const p of TOGGLEABLE_PAIRS) expect(p.label).not.toBe(p.catalogueId)
  })

  it('every switchable manifest declares status.label', () => {
    for (const id of SWITCHABLE_CATALOGUE_IDS) {
      const m = MODULE_MANIFESTS.find((x) => x.id === manifestIdOf(id)!)!
      expect(m.status?.label, `${id} manifest needs status.label`).toBeTruthy()
    }
  })

  it('manifest ids in the pairs equal manifestIdOf', () => {
    for (const p of TOGGLEABLE_PAIRS) expect(p.manifestId).toBe(manifestIdOf(p.catalogueId))
  })
})

describe('confirmationMatches (NFC-exact)', () => {
  it('a decomposed-umlaut input equals the composed label', () => {
    const composed = 'Prüfung'
    const decomposed = 'Prüfung'
    expect(composed).not.toBe(decomposed)
    expect(confirmationMatches(decomposed, composed)).toBe(true)
    expect(confirmationMatches(composed, decomposed)).toBe(true)
  })

  it('a case change, a padded blank, an empty value or a Cyrillic look-alike does not match', () => {
    expect(confirmationMatches('Wahlen', 'Wahlen')).toBe(true)
    expect(confirmationMatches('wahlen', 'Wahlen')).toBe(false)
    expect(confirmationMatches(' Wahlen', 'Wahlen')).toBe(false)
    expect(confirmationMatches('Wahlen ', 'Wahlen')).toBe(false)
    expect(confirmationMatches('', 'Wahlen')).toBe(false)
    // Cyrillic a (U+0430) instead of Latin a
    expect(confirmationMatches('Wаhlen', 'Wahlen')).toBe(false)
  })

  it('a non-string input never matches', () => {
    expect(confirmationMatches(undefined as unknown as string, 'Wahlen')).toBe(false)
    expect(confirmationMatches(null as unknown as string, 'Wahlen')).toBe(false)
  })
})
