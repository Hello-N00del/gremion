// What a council admin is shown before a module is switched OFF, and what is shown after a request
// was queued (Karenz phase 1, Task 11; Interface I-3 for phase 2).
//
// Client-safe: types only (a type import from the server is erased). The server side (preview.ts)
// builds a ModuleDeletionPreview; ModuleOffWarning.svelte renders one. Since the 30-day Karenz (phase 2)
// graceDays is 30; a null graceDays still renders a neutral "not available" notice instead of any
// sentence that promises removal.
import type { KarenzState } from '$lib/server/module-karenz/platform'
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
  /** == moduleLabel. */
  confirmPhrase: string
  deletes: DeletionItem[]
  /** What stays after the final day: sealed copies and what the participants keep. */
  retained: RetainedItem[]
  /** null = switch-off not available; 30 since phase 2. */
  graceDays: number | null
  /** ISO date of the final deletion (today plus graceDays); null when graceDays is null. */
  finalDeletionAt: string | null
  /** true: switching the module on again within the grace period restores it. */
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
  /** The 30 days of a switch-off that is still running (open, restoring, finalizing), else null. */
  karenz: KarenzView | null
}

/**
 * A module the customer has that the operator controls: the council may not switch it, so the page shows it
 * with its state and no control. Only modules that are ON are listed (a module the customer does not have is
 * not offered, and a held-off one is never named).
 */
export interface OperatorModuleItem {
  /** Catalogue id. */
  moduleId: string
  label: string
}

/**
 * A module in its 30-day Karenz, as the settings page shows it. Built on the server from the platform
 * row (the clock), the tenant step ledger and the sealed copies. It carries counts, step names and ids,
 * never a person: not the one who switched the module off, not a recipient of the mail.
 */
export interface KarenzView {
  karenzId: string
  state: KarenzState
  /** ISO timestamps. */
  switchedOffAt: string
  finalAt: string
  /** Whole days until the final day, rounded up, never negative. */
  daysLeft: number
  /** True only while the Karenz is `open`: switching the module on is then the restore. */
  canRestore: boolean
  /** Counts of the switch-off info mail once its step is done, else null (nothing is claimed before it happened). */
  mail: { recipients: number; failed: number; skippedHolders: number } | null
  /** True when the info mail step failed (nobody could be told yet; it is retried). */
  mailFailed: boolean
  /** Failed steps and refused lock or unlock items, by step name and id only. */
  problems: string[]
  /** The sealed read-only copies of this module, each a download of the settings route. */
  retained: { id: string; label: string; lineCount: number; href: string }[]
  /** Where the backup export of the council's data lives. */
  backupHref: string
}

export type SwitchStateName = 'queued' | 'succeeded' | 'applying' | 'applied' | 'failed' | 'refused' | 'expired' | 'dead'

export interface ModuleOverview {
  modules: ModuleOverviewItem[]
  /** Modules the customer has that the council cannot switch (operator-managed); absent reads as none. */
  operatorModules?: OperatorModuleItem[]
  disableAvailable: boolean
  problem: string | null
}
