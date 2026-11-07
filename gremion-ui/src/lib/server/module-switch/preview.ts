// src/lib/server/module-switch/preview.ts
// Karenz phase 1, Task 11: what a council admin is told a module switch-off would delete.
//
// The contract (ModuleDeletionPreview, switch-preview.ts) is Interface I-3 for phase 2. Phase 1 builds
// it with graceDays null ("switch-off not available"), recoverable false and nothing retained; the
// provider registry is the seam a module (or phase 2) fills with real counters. A module without a
// provider, a provider that throws and a provider that returns nothing all degrade to ONE item with an
// unknown count, which the UI renders as "alle Daten dieses Moduls": a count is never invented.
import { TOGGLEABLE_PAIRS } from '$lib/modules/catalogue-map'
import type { DeletionItem, DeletionPreviewProvider, ModuleDeletionPreview } from '$lib/modules/switch-preview'
import type { TenantContext } from '$lib/server/tenant/context'

const providers = new Map<string, DeletionPreviewProvider>()

/** Register the counter of a module (catalogue id). A second registration for the same id replaces the first. */
export function registerDeletionPreviewProvider(catalogueId: string, p: DeletionPreviewProvider): void {
  providers.set(catalogueId, p)
}

/** Test-only. */
export function _clearDeletionPreviewProvidersForTests(): void {
  providers.clear()
}

export async function previewSwitchOff(tenant: TenantContext, catalogueId: string): Promise<ModuleDeletionPreview> {
  const pair = TOGGLEABLE_PAIRS.find((p) => p.catalogueId === catalogueId)
  if (!pair) throw new Error(`module ${catalogueId} is not council-switchable`)
  const unknown: DeletionItem = { key: 'all', label: `${pair.label}-Daten`, count: null, unit: '' }
  let deletes: DeletionItem[] = [unknown]
  const provider = providers.get(catalogueId)
  if (provider) {
    try {
      const items = await provider(tenant)
      if (items.length > 0) deletes = items
    } catch (err) {
      console.error(`[module-switch] deletion preview provider for ${catalogueId} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return {
    moduleId: catalogueId,
    moduleLabel: pair.label,
    confirmPhrase: pair.label,
    deletes,
    retained: [],
    graceDays: null,
    finalDeletionAt: null,
    recoverable: false,
  }
}
