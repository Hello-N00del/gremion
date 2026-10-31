// What a council admin is shown before a module is switched OFF, and what is shown after a request
// was queued (Karenz phase 1, Task 11; Interface I-3 for phase 2).
//
// Client-safe: types only, no server imports. The server side (preview.ts) builds a
// ModuleDeletionPreview; ModuleOffWarning.svelte renders one. Phase 1 never reaches the
// destructive path: graceDays stays null ("switch-off not available"), and the component then
// renders a neutral notice instead of any sentence that promises removal.
import type { TenantContext } from '$lib/server/tenant/context'

export interface DeletionItem {
  key: string
  label: string
  /** null = unknown, rendered as "alle Daten dieses Moduls". */
  count: number | null
  unit: string
}

export interface RetainedItem {
  key: string
  label: string
  basis: string
}

export interface ModuleDeletionPreview {
  /** Catalogue id. */
  moduleId: string
  /** Shown AND the confirmation phrase. */
  moduleLabel: string
  /** == moduleLabel in phase 1. */
  confirmPhrase: string
  deletes: DeletionItem[]
  /** Empty in phase 1. */
  retained: RetainedItem[]
  /** null = switch-off not available (phase 1); 30 in phase 2. */
  graceDays: number | null
  /** ISO date; null in phase 1. */
  finalDeletionAt: string | null
  /** false in phase 1. */
  recoverable: boolean
}

export type DeletionPreviewProvider = (tenant: TenantContext) => Promise<DeletionItem[]>

/** One switchable module as the settings page lists it. */
export interface ModuleOverviewItem {
  moduleId: string
  label: string
  enabled: boolean
  /** true: a platform enablement row exists and is the truth; false: the module follows config.modules. */
  managed: boolean
  dpiaRecorded: boolean
  /** The deny reason when the module is refused by name, else null. */
  denied: string | null
  pending: { requestId: string; action: 'enable' | 'disable'; state: SwitchStateName }[]
  lastFailure: string | null
}

export type SwitchStateName = 'queued' | 'succeeded' | 'applying' | 'applied' | 'failed' | 'refused' | 'expired' | 'dead'

export interface ModuleOverview {
  modules: ModuleOverviewItem[]
  disableAvailable: boolean
  problem: string | null
}
