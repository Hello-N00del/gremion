// src/lib/server/module-karenz/participants.ts
// Module Karenz (phase 2, Task 8): the participant registry.
//
// A module that holds state outside the tenant database (Nextcloud Polls deadlines, Helios elections,
// Matrix rooms, the Nextcloud binding) registers ONE participant for its catalogue id. The per-tenant
// pass (engine.ts) drives it: switchOff when the module is switched off, restore when it is switched
// back on inside the Karenz, finalize on the final day. The kernel owns this file and never imports a
// module; a module registers into it from its own register.server.ts.
//
// Contract of every phase: IDEMPOTENT. The pass runs again after a crash, after a partial failure and
// after a restart, and the step ledger only skips a phase that finished. A participant that handles
// several items processes ALL of them and then throws a KarenzPartialError naming what failed, so one
// bad item never leaves the others untouched. What a failure names is a short label of the item
// (a kind and an external id), never a person's name or address: the engine reports only the error
// class and the count to the platform and logs the texts for the operator.
import type { TenantContext } from '$lib/server/tenant/context'
import type { ItemState, KarenzItem as KarenzItemInput, KarenzItemRow } from './store'

/** One thing a final deletion would remove (a label and a count, no content). */
export interface DeletionItem {
  label: string
  count: number
}

/** One thing that stays after the final day (a sealed copy), with the class that keeps it. */
export interface RetainedItem {
  label: string
  count: number
  retentionClass?: string
}

/** The participant's view of the item list of ONE Karenz row (tenant table module_karenz_item). */
export interface KarenzItems {
  list(kind?: string): Promise<KarenzItemRow[]>
  /** Idempotent per (kind, externalId); a `recorded` upsert never undoes what an earlier pass did to the item. */
  upsert(i: Omit<KarenzItemInput, 'karenzId'>): Promise<KarenzItemRow>
  /** Rejects when the item no longer exists: a participant that records a result must know it was recorded. */
  setState(itemId: string, s: ItemState, detail?: string): Promise<void>
}

export interface KarenzContext {
  tenant: TenantContext
  /** The platform row id (plt.module_karenz.karenz_id). */
  karenzId: string
  /** The catalogue id the platform knows (what the participant registered under). */
  catalogueId: string
  /** The config.modules key, or null when the module is not council-switchable. */
  manifestId: string | null
  switchedOffAt: Date
  finalAt: Date
  now(): Date
  items: KarenzItems
  /** One line into the operator log, prefixed with the tenant and the participant. */
  log(line: string): void
}

/**
 * Thrown by a participant AFTER it processed all of its items, when some of them failed. `failures` are
 * short item labels for the operator log; the platform sees only the class name and the count.
 */
export class KarenzPartialError extends Error {
  readonly failures: string[]
  constructor(failures: string[]) {
    super(`${failures.length} item(s) failed`)
    this.name = 'KarenzPartialError'
    this.failures = failures
  }
}

export interface KarenzParticipant {
  catalogueId: string
  /** The module was switched off: freeze, archive, lock. Idempotent. */
  switchOff(ctx: KarenzContext): Promise<void>
  /** The module was switched back on inside the Karenz: put back what switchOff changed. Idempotent. */
  restore(ctx: KarenzContext): Promise<void>
  /** The final day. `dryRun` reports what would be deleted and deletes nothing. Idempotent. */
  finalize(ctx: KarenzContext, opts: { dryRun: boolean }): Promise<{ deleted: Record<string, number> }>
  /** What the module would lose and what it keeps, for the warning before a switch-off (Task 17). */
  describe?(tenant: TenantContext): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }>
}

const registry = new Map<string, KarenzParticipant>()

/** Register a participant under its catalogue id. A second registration for one id replaces the first (a module re-import is not a duplicate). */
export function registerKarenzParticipant(p: KarenzParticipant): void {
  registry.set(p.catalogueId, p)
}

/** The participants of one catalogue id: none or one. Exact match on the id. */
export function karenzParticipantsFor(catalogueId: string): readonly KarenzParticipant[] {
  const p = registry.get(catalogueId)
  return p ? [p] : []
}

/** Test-only: drop every registered participant. */
export function _clearKarenzParticipantsForTests(): void {
  registry.clear()
}
