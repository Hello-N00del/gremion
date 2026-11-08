// src/lib/server/module-switch/preview.ts
// What a council admin is told a module switch-off would delete, and what stays (Module Karenz).
//
// The contract (ModuleDeletionPreview, switch-preview.ts) is Interface I-3. Since the 30-day Karenz
// (phase 2, Task 17) it carries the real semantics: graceDays 30, the final date, recoverable true.
//   deletes   the module's counters (registerDeletionPreviewProvider) and the deletes of its Karenz
//             participant (describe);
//   retained  what the participant keeps (describe) and the sealed copies the module's extractors
//             write at switch-off, named by their retention class.
// A module without a provider, a provider that throws and a provider that returns nothing all degrade
// to ONE item with an unknown count, which the UI renders as "alle Daten dieses Moduls": a count is
// never invented. A participant whose describe throws is logged and contributes nothing.
import { TOGGLEABLE_PAIRS } from '$lib/modules/catalogue-map'
import type { DeletionItem, DeletionPreviewProvider, ModuleDeletionPreview, RetainedItem } from '$lib/modules/switch-preview'
import { karenzParticipantsFor } from '$lib/server/module-karenz/participants'
import { extractorsFor } from '$lib/server/module-karenz/retained/extractors'
import type { TenantContext } from '$lib/server/tenant/context'
import { GRACE_DAYS, retainedBasis, retainedLabel } from './karenz-view'

const providers = new Map<string, DeletionPreviewProvider>()

/** Register the counter of a module (catalogue id). A second registration for the same id replaces the first. */
export function registerDeletionPreviewProvider(catalogueId: string, p: DeletionPreviewProvider): void {
  providers.set(catalogueId, p)
}

/** Test-only. */
export function _clearDeletionPreviewProvidersForTests(): void {
  providers.clear()
}

export interface PreviewDeps {
  now?: () => Date
}

/** `label: count` when the participant counted something, else the bare label. */
const withCount = (label: string, count: number): string => (count > 0 ? `${label}: ${count}` : label)

export async function previewSwitchOff(tenant: TenantContext, catalogueId: string, deps: PreviewDeps = {}): Promise<ModuleDeletionPreview> {
  const pair = TOGGLEABLE_PAIRS.find((p) => p.catalogueId === catalogueId)
  if (!pair) throw new Error(`module ${catalogueId} is not council-switchable`)

  const deletes: DeletionItem[] = []
  const provider = providers.get(catalogueId)
  if (provider) {
    try {
      deletes.push(...(await provider(tenant)))
    } catch (err) {
      console.error(`[module-switch] deletion preview provider for ${catalogueId} failed:`, err instanceof Error ? err.message : err)
    }
  }

  const retained: RetainedItem[] = []
  // the sealed copies come first: they are written for sure at switch-off
  for (const e of extractorsFor(catalogueId)) {
    retained.push({ key: `extractor:${e.id}`, label: retainedLabel(e.retentionClass), basis: retainedBasis(e.retentionClass) })
  }
  for (const participant of karenzParticipantsFor(catalogueId)) {
    if (!participant.describe) continue
    try {
      const d = await participant.describe(tenant)
      d.deletes.forEach((item, i) => deletes.push({ key: `participant:${i}`, label: item.label, count: item.count, unit: '' }))
      d.retained.forEach((item, i) =>
        retained.push({ key: `participant:${i}`, label: withCount(item.label, item.count), basis: item.retentionClass ? retainedBasis(item.retentionClass) : '' }),
      )
    } catch (err) {
      console.error(`[module-switch] the Karenz description of ${catalogueId} failed:`, err instanceof Error ? err.message : err)
    }
  }

  const now = (deps.now ?? (() => new Date()))()
  const finalDeletionAt = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return {
    moduleId: catalogueId,
    moduleLabel: pair.label,
    confirmPhrase: pair.label,
    deletes: deletes.length > 0 ? deletes : [{ key: 'all', label: `${pair.label}-Daten`, count: null, unit: '' }],
    retained,
    graceDays: GRACE_DAYS,
    finalDeletionAt,
    recoverable: true,
  }
}
