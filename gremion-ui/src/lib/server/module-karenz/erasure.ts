// src/lib/server/module-karenz/erasure.ts
// Module Karenz (phase 2, Task 12): Art. 17 while a module is switched off.
//
// While a module is off its data is not gone: the module database stays alive but blocked, Nextcloud
// Polls and Helios keep their items, the chat rooms are archived. An erasure request must therefore
// still reach that data, and a restore must not bring back a person who was erased in the meantime.
// Three parts:
//
//   at erasure time   the modules with a live Karenz row (open or restoring) are walked like enabled
//                     modules (karenzErasureModules), with the FULL verified subject, while the external
//                     stores (Nextcloud, Matrix) are alive. A hook that needs the blocked module
//                     database reports its own failure or `skipped`.
//   the ledger        module_karenz_erasure keeps the subject ID of every erasure run, and nothing else:
//                     no username, no e-mail. The ledger must not re-collect what an erasure removes.
//   at restore time   replayErasureForRestore calls the module's registered hook once per subject erased
//                     since the switch-off, with an ID-ONLY subject (username and e-mail null), BEFORE
//                     config.modules flips. That reaches id-keyed rows of the module database, which
//                     the restore has unblocked. Username-keyed external data was erased at erasure time.
//                     A hook that skips because the subject has no username is reported `skipped
//                     (id-only)`, never `erased`.
//
// The replay is a pre-apply hook of the module switch reconciler (Task 8): a hook that rejects leaves the
// enable `applying` with the error in config_error, config.modules untouched, and the next pass retries.
import type { Sql } from '@gremion/db'
import { redactIdentifiers } from '$lib/server/erasure/orchestrator'
import { getErasureHook, type KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import type { PreApplyHook } from '$lib/server/module-switch/reconciler'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { resolveTenantBySlug } from '$lib/server/tenant/registry'
import { listKarenz, type KarenzRowView } from './platform'

/** The ids of the ledger are bounded like every subject id the erasure API accepts. */
const SUBJECT_ID_MAX = 512

// --------------------------------------------------------------------------- ledger

/**
 * Remember that an erasure ran for this subject. The SUBJECT ID only. A second run refreshes the time:
 * the replay asks "erased since the switch-off", and the newest run is the one that counts.
 */
export async function recordKarenzErasure(db: Sql, subjectId: string): Promise<void> {
  if (typeof subjectId !== 'string' || subjectId.trim() === '' || subjectId.length > SUBJECT_ID_MAX) {
    throw new Error('recordKarenzErasure: a non-empty subject id is required')
  }
  await db`
    INSERT INTO module_karenz_erasure (subject_id) VALUES (${subjectId})
    ON CONFLICT (subject_id) DO UPDATE SET requested_at = now()`
}

/**
 * Drop the ledger entries no restore can still need: those older than the oldest switch-off that still
 * has a database behind it (null: nothing does, the ledger is emptied). Returns how many went.
 */
export async function pruneKarenzErasure(db: Sql, oldestLiveSwitchOff: Date | null): Promise<number> {
  const res =
    oldestLiveSwitchOff === null
      ? await db`DELETE FROM module_karenz_erasure`
      : await db`DELETE FROM module_karenz_erasure WHERE requested_at < ${oldestLiveSwitchOff}`
  return res.count
}

/**
 * The switch-off that sets how far back the ledger must reach: the oldest of every row that still has a
 * module database behind it. A `restored` row counts too (it stays in the platform listing for its closed
 * window): the pre-apply replay of its enable may still be owed when the restore step finished first. A
 * `finalized` row has no database any more. null: no such row.
 */
export function oldestKeptSwitchOff(rows: readonly Pick<KarenzRowView, 'state' | 'switchedOffAt'>[]): Date | null {
  let oldest: Date | null = null
  for (const r of rows) {
    if (r.state === 'finalized') continue
    if (oldest === null || r.switchedOffAt.getTime() < oldest.getTime()) oldest = r.switchedOffAt
  }
  return oldest
}

// --------------------------------------------------------------------------- at erasure time

/** The pseudo module id under which an unreadable Karenz list is reported in the erasure report. */
export const KARENZ_LIST_UNAVAILABLE_MODULE_ID = 'module-karenz'

class KarenzListUnavailable extends Error {
  constructor() {
    super('the list of switched-off modules could not be read, so their data was not erased')
    this.name = 'KarenzListUnavailable'
  }
}

/**
 * The step that stands in for the modules in Karenz when the list of them cannot be read: it fails, so
 * the report is `incomplete` and says why (the class name only; the append-only report stores no message).
 * An erasure that cannot tell which switched-off modules hold the person must not look complete.
 */
export const karenzListUnavailableHook: KernelErasureHook = {
  moduleId: KARENZ_LIST_UNAVAILABLE_MODULE_ID,
  requiresConnection: false,
  async erase() {
    throw new KarenzListUnavailable()
  },
}

export interface KarenzModulesDeps {
  listKarenz?: (customerId: string, closedWithinDays: number) => Promise<KarenzRowView[]>
  /** True when the tenant holds local evidence of a live Karenz (used only when the council pool is not configured). */
  hasLocalEvidence?: (tenant: TenantContext) => Promise<boolean>
}

/**
 * The id an erasure uses for a Karenz row: the manifest id, else the catalogue id (a module no council can
 * switch, reached by an operator-origin disable). For such a module the catalogue id may not be the id its
 * hook registered under; the report then says "no erasure hook registered" instead of omitting it.
 */
const erasureIdOf = (r: KarenzRowView): string => r.manifestId ?? r.catalogueId

/**
 * The module ids an erasure must walk beyond the enabled ones: every module with a live Karenz row
 * (`open` or `restoring`). `unreadable` is true when the platform could not be asked (or the council pool
 * is not configured while the tenant holds local evidence of a Karenz): the caller then adds the failing
 * KARENZ_LIST_UNAVAILABLE step, so the omission is an error in the report, never silent.
 */
export async function karenzErasureModules(tenant: TenantContext, deps: KarenzModulesDeps = {}): Promise<{ ids: string[]; unreadable: boolean }> {
  const list = deps.listKarenz ?? listKarenz
  try {
    const rows = await list(tenant.id, 0)
    const ids = new Set<string>()
    for (const r of rows) if (r.state === 'open' || r.state === 'restoring') ids.add(erasureIdOf(r))
    return { ids: [...ids], unreadable: false }
  } catch (err) {
    if (err instanceof CouncilNotConfigured) {
      const evidence = deps.hasLocalEvidence ?? (async (t: TenantContext) => (await import('./engine')).defaultHasLocalEvidence(t))
      if (!(await evidence(tenant))) return { ids: [], unreadable: false }
    }
    console.error(`[module-karenz] ${tenant.slug}: the list of switched-off modules could not be read for an erasure:`, err instanceof Error ? err.message : err)
    return { ids: [], unreadable: true }
  }
}

// --------------------------------------------------------------------------- at restore time

export interface ErasureReplayResult {
  /** Subjects erased since the switch-off. */
  subjects: number
  erased: number
  skipped: number
  failed: number
  /** One line per distinct outcome class; a hook's own reason text for a skip, never a subject id. */
  details: string[]
}

export class ErasureReplayError extends Error {
  constructor(counts: string) {
    super(`erasure replay before the restore failed for ${counts} subject(s); the module stays switched off until it succeeds`)
    this.name = 'ErasureReplayError'
  }
}

export interface ReplayDeps {
  hookFor?: (manifestId: string) => KernelErasureHook | undefined
}

/**
 * Before a module comes back: call its registered erasure hook for every subject erased since the
 * switch-off, with the ID-ONLY subject (username and e-mail null). Throws ErasureReplayError AFTER trying
 * every subject when any hook failed, so the switch stays applying and the next pass runs it again (a hook
 * must be idempotent). A module without a hook is `skipped` in the detail: nothing was replayed.
 */
export async function replayErasureForRestore(
  ctx: { tenantId: string; manifestId: string; switchedOffAt: Date; db: Sql },
  deps: ReplayDeps = {},
): Promise<ErasureReplayResult> {
  const rows = await ctx.db<{ subject_id: string }[]>`
    SELECT subject_id FROM module_karenz_erasure
     WHERE requested_at >= ${ctx.switchedOffAt}
     ORDER BY requested_at, subject_id`
  const out: ErasureReplayResult = { subjects: rows.length, erased: 0, skipped: 0, failed: 0, details: [] }
  if (rows.length === 0) return out
  const hook = (deps.hookFor ?? getErasureHook)(ctx.manifestId)
  if (!hook) {
    out.skipped = rows.length
    out.details.push(`no erasure hook registered for ${ctx.manifestId}: nothing was replayed`)
    return out
  }
  const reasons = new Set<string>()
  for (const { subject_id: subjectId } of rows) {
    try {
      const res = await hook.erase({ tenantId: ctx.tenantId, subjectId, subject: { id: subjectId, username: null, email: null }, db: ctx.db })
      if (res.status === 'erased') out.erased++
      else {
        out.skipped++
        reasons.add(res.reason)
      }
    } catch (err) {
      out.failed++
      // the operator log keeps the (redacted) message; the thrown error and config_error carry counts only
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[module-karenz] erasure replay: the ${ctx.manifestId} hook failed:`, redactIdentifiers(message, [subjectId]).slice(0, 500))
    }
  }
  for (const reason of reasons) out.details.push(`skipped (id-only): ${reason}`)
  if (out.failed > 0) throw new ErasureReplayError(`${out.failed} of ${out.subjects}`)
  return out
}

export interface ReplayPreApplyDeps {
  listKarenz?: (customerId: string) => Promise<KarenzRowView[]>
  tenantFor?: (slug: string) => Promise<TenantContext | null>
  withTenant?: <T>(tenant: TenantContext, fn: () => T) => T
  replay?: typeof replayErasureForRestore
}

/**
 * The reconciler hook: for an enable, find the restore (the newest `restoring` or `restored` row of the
 * module) and replay the erasures recorded since its switch-off. No such row (a first enable, or a fresh
 * start after day 30 on an empty database): nothing to replay.
 */
export function createErasureReplayPreApply(deps: ReplayPreApplyDeps = {}): PreApplyHook {
  return async (e) => {
    if (e.manifestId === null) return
    const rows = await (deps.listKarenz ?? listKarenz)(e.tenantId)
    const restore = rows
      .filter((r) => r.catalogueId === e.moduleId && (r.state === 'restoring' || r.state === 'restored'))
      .toSorted((a, b) => (b.restoreRequestedAt ?? b.switchedOffAt).getTime() - (a.restoreRequestedAt ?? a.switchedOffAt).getTime())[0]
    if (!restore) return
    const tenant = await (deps.tenantFor ?? resolveTenantBySlug)(e.slug)
    if (!tenant) throw new Error(`erasure replay: the tenant ${e.slug} could not be resolved`)
    const run = deps.replay ?? replayErasureForRestore
    const manifestId = e.manifestId
    const result = await (deps.withTenant ?? runWithTenant)(tenant, () => run({ tenantId: e.tenantId, manifestId, switchedOffAt: restore.switchedOffAt, db: tenant.db }))
    if (result.subjects > 0) {
      console.info(`[module-karenz] ${e.slug} ${e.moduleId}: erasure replay before the restore: ${result.erased} erased, ${result.skipped} skipped, ${result.details.join('; ')}`)
    }
  }
}

/** The hook the module-karenz boot registers into the reconciler. */
export const erasureReplayPreApply: PreApplyHook = createErasureReplayPreApply()
