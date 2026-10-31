// src/lib/server/module-karenz/platform.ts
// Module Karenz (phase 2, Task 8): the bridge from the tenant pass to the platform rows.
//
// The platform row (plt.module_karenz) is the authoritative clock of one switch-off. The tenant pass
// has two doors to it, both through the shared council pool (getCouncilDb(), role gremion_ui_modules,
// EXECUTE on named functions only, no table privilege):
//   plt.council_karenz_list    the live rows of ONE customer plus the rows closed inside a window.
//                              It returns no actor, no export path and no checksum: the person who
//                              switched lives in the audit log only.
//   plt.council_karenz_report  one advisory event, optionally with a completion mark. The platform
//                              checks the mark against the row (tenant_done only after final_at and
//                              only in live mode; restored only from restoring).
// The report channel is advisory and pool-wide (plan Open Decision 8): nothing destructive on the
// platform side depends on what a council reports.
import { manifestIdOf } from '$lib/modules/catalogue-map'
import { getCouncilDb } from '$lib/server/module-switch/council-db'

export type KarenzState = 'open' | 'restoring' | 'restored' | 'finalizing' | 'finalized'
export type KarenzMark = 'tenant_done' | 'restored'

export interface KarenzRowView {
  karenzId: string
  /** The catalogue id (plt.module.module_key): what participants register under. */
  catalogueId: string
  /** The config.modules key, or null when the module is not council-switchable. */
  manifestId: string | null
  state: KarenzState
  switchedOffAt: Date
  finalAt: Date
  restoreRequestedAt: Date | null
  /** Written only by the platform job (karenz-run); the tenant side never reads its own environment. */
  finalMode: 'dry' | 'live' | null
  platformDoneAt: Date | null
  tenantDoneAt: Date | null
}

export interface KarenzReport {
  /** A step name of the platform event log: ^[a-z][a-z0-9:_-]{0,59}$ (longer names are cut). */
  step: string
  level: 'info' | 'error'
  /** At most 1000 characters (longer text is cut). Nothing that identifies a person. */
  message: string
  mark?: KarenzMark
}

/** The platform's limits (plt.council_karenz_report). */
const STEP_MAX = 60
const MESSAGE_MAX = 1000
const DEFAULT_CLOSED_WINDOW_DAYS = 14

const STATES: ReadonlySet<string> = new Set<KarenzState>(['open', 'restoring', 'restored', 'finalizing', 'finalized'])

interface ListRow {
  karenz_id: string
  module_key: string
  state: string
  switched_off_at: Date
  final_at: Date
  restore_requested_at: Date | null
  final_mode: string | null
  platform_done_at: Date | null
  tenant_done_at: Date | null
  export_kept_until: Date | null
}

/**
 * The live Karenz rows of one customer (open, restoring, finalizing) plus the rows closed inside
 * `closedWithinDays` (0..60). A row with a state this build does not know is dropped and logged,
 * never guessed at. A platform failure rejects: the pass decides what that means.
 */
export async function listKarenz(customerId: string, closedWithinDays = DEFAULT_CLOSED_WINDOW_DAYS): Promise<KarenzRowView[]> {
  const rows = await getCouncilDb()<ListRow[]>`
    SELECT karenz_id, module_key, state, switched_off_at, final_at, restore_requested_at, final_mode,
           platform_done_at, tenant_done_at, export_kept_until
      FROM plt.council_karenz_list(${customerId}::uuid, ${closedWithinDays}::integer)`
  const out: KarenzRowView[] = []
  for (const r of rows) {
    if (!STATES.has(r.state)) {
      console.error(`[module-karenz] Karenz row ${r.karenz_id} has the state '${r.state}', which this build does not know - ignored`)
      continue
    }
    out.push({
      karenzId: r.karenz_id,
      catalogueId: r.module_key,
      manifestId: manifestIdOf(r.module_key),
      state: r.state as KarenzState,
      switchedOffAt: r.switched_off_at,
      finalAt: r.final_at,
      restoreRequestedAt: r.restore_requested_at,
      finalMode: r.final_mode === 'dry' || r.final_mode === 'live' ? r.final_mode : null,
      platformDoneAt: r.platform_done_at,
      tenantDoneAt: r.tenant_done_at,
    })
  }
  return out
}

/**
 * Append one event to the row's platform log, optionally with a completion mark. Rejects when the
 * platform refuses (22023: a mark the row's state or mode does not allow) or cannot be reached: the
 * caller keeps the step open and reports again on the next pass.
 */
export async function reportKarenz(customerId: string, karenzId: string, e: KarenzReport): Promise<void> {
  const step = e.step.slice(0, STEP_MAX)
  // by code point, like the platform's length(): a cut must not split a surrogate pair
  const points = [...e.message]
  const message = points.length > MESSAGE_MAX ? points.slice(0, MESSAGE_MAX).join('') : e.message
  await getCouncilDb()`
    SELECT plt.council_karenz_report(${customerId}::uuid, ${karenzId}::uuid, ${step}, ${e.level}, ${message}, ${e.mark ?? null})`
}
