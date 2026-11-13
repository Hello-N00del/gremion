// src/lib/server/module-switch/operator-modules.ts
//
// Settings > Module lists every module the customer has, not only the ones the council may switch. The
// switchable ones come from loadModuleOverview (service.ts), with their switches and their 30 days. The rest
// are the operator's: content, files, messaging, publishing and the board. They are listed here with their
// state and NO control, so the page never claims less than the app does (the sidebar shows them) and never
// offers a switch the server would refuse.
//
// This file only READS. It does not touch what a council may switch: SWITCHABLE_CATALOGUE_IDS, manifestIdOf,
// catalogueIdOf, TOGGLEABLE_PAIRS, the deny lists and the step-up flow stay exactly as they are, and a switch
// or a preview of one of these modules is still refused MODULE_NOT_SWITCHABLE.
//
// A module is listed when it is ON by the two sources the app itself gates on, and read the way
// loadModuleOverview reads them: config.modules says on (an absent key reads as on, the default of every
// toggleable manifest) AND the platform enablement row, when there is one, says enabled. When either says off
// the module is not listed: a module the customer does not have is not offered, and nothing here claims "on"
// that one of the two sources denies. Held-off modules (elections) and modules without a registered manifest
// (handover, vault) are never listed.
import { HELD_BACK_MANIFEST_IDS, SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { isHeldOffModule } from '$lib/modules/held-off'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import type { OperatorModuleItem } from '$lib/modules/switch-preview'
import { readConfig } from '$lib/server/config'
import type { TenantContext } from '$lib/server/tenant/context'
import { getCouncilDb } from './council-db'

/**
 * The names the page shows, by manifest id, matching the navigation. Not in the manifests' status.label on
 * purpose: that label also feeds the Systemstatus catalogue, the processing record and the Karenz notices.
 * A manifest without an entry falls back to its status.label and then to its id, never to an invented name.
 */
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  board: 'Aufgaben',
  content: 'Inhalte',
  files: 'Dokumente',
  messages: 'Chat',
  newsletter: 'Newsletter',
})

/** What the page needs of a platform row: the state and whether the platform manages the module at all. */
export interface PlatformModuleState {
  state: string
  has_row: boolean
}

/**
 * The operator-managed modules this customer has on, sorted by name.
 * `state` is keyed by catalogue id (plt.council_module_state), `modules` is config.modules (manifest ids).
 */
export function buildOperatorModules(
  state: ReadonlyMap<string, PlatformModuleState>,
  modules: Record<string, boolean> | undefined,
): OperatorModuleItem[] {
  const items: OperatorModuleItem[] = []
  for (const [catalogueId, manifestId] of Object.entries(HELD_BACK_MANIFEST_IDS)) {
    if (SWITCHABLE_CATALOGUE_IDS.has(catalogueId) || isHeldOffModule(manifestId)) continue
    const manifest = MODULE_MANIFESTS.find((m) => m.id === manifestId)
    if (!manifest?.toggleable) continue
    const row = state.get(catalogueId)
    const platformOn = row?.has_row !== true || row.state === 'enabled'
    if (!platformOn || modules?.[manifestId] === false) continue
    items.push({ moduleId: catalogueId, label: LABELS[manifestId] ?? manifest.status?.label ?? manifestId })
  }
  return items.sort((a, b) => a.label.localeCompare(b.label, 'de'))
}

/** Reads the platform state of the customer and the tenant config. Throws CouncilNotConfigured, like the overview. */
export async function loadOperatorModules(tenant: TenantContext): Promise<OperatorModuleItem[]> {
  const platform = getCouncilDb()
  const rows = await platform<(PlatformModuleState & { module_key: string })[]>`SELECT module_key, state, has_row FROM plt.council_module_state(${tenant.id}::uuid)`
  return buildOperatorModules(new Map(rows.map((r) => [r.module_key, r])), readConfig(tenant).modules)
}
