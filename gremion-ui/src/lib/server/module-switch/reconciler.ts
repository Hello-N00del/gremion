// src/lib/server/module-switch/reconciler.ts
// Karenz phase 1 (Task 13): turn the platform's answer to a council module request into the tenant's
// own state.
//
// The request runs on the host (executor) and finishes in the platform queue. Nothing in the app learns
// of that on its own, so this reconciler, ticked per active tenant by register.server.ts, reads the
// slug's council requests (plt.council_module_requests), copies a final state into the tenant-side
// record (module_switch_request), applies a succeeded request to config.modules (plus the module
// migration catch-up for an enable) and tells the listeners once. A request that did not succeed
// changes no config; its outcome text is stored so the settings page can show why.
//
// Blue and green both load register.server.ts, so two reconcilers race on the same rows by design.
// The two racing transitions use ONLY the store's atomic claims (claimTransition, claimNotification),
// never a read-then-update: one instance applies a request, one instance notifies. A pass that dies
// mid-apply leaves the row `applying`; it is re-claimed after the lease (120 s) and completed.
//
// Source of truth for "is a module on": the platform enablement WHERE a platform row exists. Modules
// with no row ("unmanaged": default-on in config.modules, every pre-existing council) keep following
// config.modules; the one-time alignment below never touches them.
import { manifestIdOf, SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { readConfig, writeConfig } from '$lib/server/config'
import type { TenantContext } from '$lib/server/tenant/context'
import { notifyModuleSwitchListeners, type ModuleSwitchEvent } from './listeners'
import * as realStore from './store'
import type { SwitchRow } from './store'

/** How often register.server.ts runs a pass per active tenant. Without a pending row a pass makes a platform call only every SWEEP_INTERVAL_MS. */
export const MODULE_SWITCH_INTERVAL_MS = 10_000

/** plt.council_module_requests allows 1..100. */
const REQUEST_LIMIT = 100
/** How many tenant-side rows are compared against the platform list when adopting (the table is tiny). */
const KNOWN_LIMIT = 200
/**
 * With nothing pending the platform list is still read this often per tenant: a request whose tenant-side
 * insert failed while the process runs has no row to make it pending, and only this read adopts it.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000
/** After a failed alignment (the write or its migration catch-up) the next attempt waits this long (the pass itself keeps running). */
const ALIGN_RETRY_MS = 60_000
/** The stored outcome text is capped; the executor text can be long. */
const OUTCOME_MAX = 500

/** A row of plt.council_module_requests. */
export interface CouncilRequestRow {
  request_id: string
  kind: string
  module: string | null
  state: string
  outcome: string | null
  actor: string | null
  created_at: Date
  finished_at: Date | null
}

/** The columns of plt.council_module_state the reconciler reads. */
export interface CouncilStateRow {
  module_key: string
  state: string
  has_row: boolean
}

/** The platform reads of the council requester role, as a seam the tests replace. */
export interface CouncilPort {
  requests(slug: string, limit: number): Promise<CouncilRequestRow[]>
  state(tenantId: string): Promise<CouncilStateRow[]>
}

/** The store functions the reconciler uses (store.ts is the production implementation). */
export interface ReconcilerStore {
  insertSwitch: typeof realStore.insertSwitch
  listSwitches: typeof realStore.listSwitches
  pendingSwitches: typeof realStore.pendingSwitches
  updateSwitch: typeof realStore.updateSwitch
  claimTransition: typeof realStore.claimTransition
  claimNotification: typeof realStore.claimNotification
}

/** What one process remembers between passes (blue and green each have their own). */
export interface ReconcilerState {
  /** Tenants whose config.modules was aligned to the platform state. */
  aligned: Set<string>
  /** Tenant id -> clock time of the last platform request-list read (every read also adopts unknown requests). */
  sweptAt: Map<string, number>
  /** Tenant id -> clock time before which a failed alignment is not retried. */
  alignRetryAt: Map<string, number>
  /** Tenants whose alignment turned a module on but whose migration catch-up has not succeeded yet. */
  migrateOwed: Set<string>
}

export interface ReconcilerDeps {
  council: () => CouncilPort
  store: ReconcilerStore
  state: ReconcilerState
  readConfig: (tenant: TenantContext) => { modules?: Record<string, boolean> }
  writeConfig: (update: { modules: Record<string, boolean> }, tenant: TenantContext) => unknown
  /** The module-migration catch-up of an enable (fleet.ts migrateTenant: never throws, the failure travels in the outcome). */
  migrate: (tenant: { id: string; slug: string }) => Promise<{ ok: boolean; error?: string }>
  now: () => number
}

const processState: ReconcilerState = { aligned: new Set(), sweptAt: new Map(), alignRetryAt: new Map(), migrateOwed: new Set() }

/** Test-only: forget what this process remembers. */
export function _resetModuleSwitchReconcilerForTests(): void {
  processState.aligned.clear()
  processState.sweptAt.clear()
  processState.alignRetryAt.clear()
  processState.migrateOwed.clear()
}

/**
 * Karenz phase 2 (Task 8): work that must be finished BEFORE an enabled module comes back, run for
 * `action === 'enable'` after the platform request succeeded and before config.modules is written (the
 * erasure replay of Task 12 is the first user). The event has no outcome and no time: the request has
 * not been applied yet. A hook that rejects leaves the request `applying` with the error in
 * config_error, config.modules untouched, and the next pass retries it; hooks after the failing one
 * are not run. A hook must be idempotent.
 */
export type PreApplyHook = (e: Omit<ModuleSwitchEvent, 'outcome' | 'at'>) => Promise<void>

const preApplyHooks: PreApplyHook[] = []

/** Register a pre-apply hook; called in registration order. */
export function registerPreApplyHook(h: PreApplyHook): void {
  preApplyHooks.push(h)
}

/** Run every pre-apply hook in registration order; the first rejection propagates and the later hooks do not run. */
async function runPreApplyHooks(pre: Omit<ModuleSwitchEvent, 'outcome' | 'at'>): Promise<void> {
  for (const hook of preApplyHooks) await hook(pre)
}

/** Test-only: drop every registered pre-apply hook. */
export function _clearPreApplyHooksForTests(): void {
  preApplyHooks.length = 0
}

/** The production council port: the three functions of the gremion_ui_modules role, nothing else. */
function defaultCouncil(): CouncilPort {
  const platform = async () => (await import('./council-db')).getCouncilDb()
  return {
    requests: async (slug, limit) =>
      (await platform())<CouncilRequestRow[]>`
        SELECT request_id, kind, module, state, outcome, actor, created_at, finished_at
          FROM plt.council_module_requests(${slug}, ${limit})`,
    state: async (tenantId) =>
      (await platform())<CouncilStateRow[]>`
        SELECT module_key, state, has_row FROM plt.council_module_state(${tenantId}::uuid)`,
  }
}

function defaults(): ReconcilerDeps {
  return {
    council: defaultCouncil,
    store: realStore,
    state: processState,
    readConfig: (tenant) => readConfig(tenant),
    writeConfig: (update, tenant) => writeConfig(update, tenant),
    // Dynamic: fleet.ts pulls in the migration runner and the tenant registry; a pass that has nothing to migrate never loads them.
    migrate: async (ref) => (await import('$lib/server/tenant/fleet')).migrateTenant(ref),
    now: () => Date.now(),
  }
}

type FinalFailure = 'failed' | 'refused' | 'expired' | 'dead'

const FAILURE_TEXT: Record<FinalFailure, string> = {
  failed: 'Die Anfrage ist fehlgeschlagen. Die Einstellungen der App wurden nicht geändert.',
  refused: 'Die Anfrage wurde abgelehnt. Die Einstellungen der App wurden nicht geändert.',
  expired: 'Die Anfrage wurde nicht rechtzeitig ausgeführt und ist abgelaufen. Die Einstellungen der App wurden nicht geändert.',
  dead: 'Die Anfrage wurde beim Ausführen abgebrochen und nicht abgeschlossen. Die Einstellungen der App wurden nicht geändert.',
}

const NOT_SWITCHABLE_TEXT = 'not switchable: Dieses Modul kann von der Gremiumsverwaltung nicht geschaltet werden. Es wurde nichts geändert.'

const isFinalFailure = (s: string): s is FinalFailure => s === 'failed' || s === 'refused' || s === 'expired' || s === 'dead'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const clip = (s: string): string => (s.length > OUTCOME_MAX ? `${s.slice(0, OUTCOME_MAX - 1)}…` : s)

const switchable = (catalogueId: string | null): catalogueId is string => catalogueId !== null && SWITCHABLE_CATALOGUE_IDS.has(catalogueId) && manifestIdOf(catalogueId) !== null

/**
 * Step 0, once per tenant per process: align config.modules to the platform state, ONLY for switchable
 * modules that have a platform row. Platform enabled + config off -> on; platform row not enabled +
 * config on -> off. A module with no row is left alone (aligning "no row" to "off" would switch off
 * every existing council's default-on modules). A module turned ON here first runs the pre-apply hooks
 * (the Karenz erasure replay), exactly like an applied enable; one whose hooks fail stays off and is
 * retried after the backoff while the other modules are still aligned. A failed write is logged and
 * retried after a backoff; it never stops the pass.
 */
async function alignOnce(tenant: TenantContext, d: ReconcilerDeps, council: CouncilPort): Promise<void> {
  if (d.state.aligned.has(tenant.id)) return
  const retryAt = d.state.alignRetryAt.get(tenant.id)
  if (retryAt !== undefined && d.now() < retryAt) return
  try {
    const rows = await council.state(tenant.id)
    const byKey = new Map(rows.map((r) => [r.module_key, r]))
    const configured = d.readConfig(tenant).modules ?? {}
    const diff: Record<string, boolean> = {}
    /** manifest id -> catalogue id, for the modules this alignment would turn ON. */
    const turningOn = new Map<string, string>()
    for (const catalogueId of SWITCHABLE_CATALOGUE_IDS) {
      const manifestId = manifestIdOf(catalogueId)
      const row = byKey.get(catalogueId)
      if (manifestId === null || !row?.has_row) continue
      const platformOn = row.state === 'enabled'
      if (platformOn !== (configured[manifestId] !== false)) {
        diff[manifestId] = platformOn
        if (platformOn) turningOn.set(manifestId, catalogueId)
      }
    }
    // A module coming back on through alignment must pass the same pre-apply work as an applied enable
    // (the Art. 17 replay of a Karenz restore): a platform enablement that reached the platform before a
    // restart, with apply() never having run, must not switch the module on over unreplayed erasures. A
    // module whose hooks fail stays OFF (left out of the diff) and the alignment is retried after the backoff.
    let blocked = false
    for (const [manifestId, catalogueId] of turningOn) {
      try {
        await runPreApplyHooks({
          requestId: 'alignment',
          tenantId: tenant.id,
          slug: tenant.slug,
          moduleId: catalogueId,
          manifestId,
          action: 'enable',
          actorUserId: 'system',
          detail: null,
        })
      } catch (err) {
        delete diff[manifestId]
        blocked = true
        console.error(`[module-switch] ${tenant.slug}: ${catalogueId} stays off at alignment, its pre-apply work failed (retried later):`, errText(err))
      }
    }
    if (Object.keys(diff).length > 0) {
      d.writeConfig({ modules: diff }, tenant)
      console.info(`[module-switch] ${tenant.slug}: config.modules aligned to the platform state: ${JSON.stringify(diff)}`)
      if (Object.values(diff).some(Boolean)) d.state.migrateOwed.add(tenant.id)
    }
    // Owed until it succeeds: the config diff is gone on a retry, so the debt is remembered separately.
    if (d.state.migrateOwed.has(tenant.id)) {
      const m = await d.migrate({ id: tenant.id, slug: tenant.slug })
      if (!m.ok) {
        d.state.alignRetryAt.set(tenant.id, d.now() + ALIGN_RETRY_MS)
        console.error(`[module-switch] ${tenant.slug}: module migration catch-up after alignment failed (retried later):`, m.error ?? '')
        return
      }
      d.state.migrateOwed.delete(tenant.id)
    }
    if (blocked) {
      // Not aligned yet: the held-back module is retried (hooks run again) after the backoff.
      d.state.alignRetryAt.set(tenant.id, d.now() + ALIGN_RETRY_MS)
      return
    }
    d.state.aligned.add(tenant.id)
  } catch (err) {
    d.state.alignRetryAt.set(tenant.id, d.now() + ALIGN_RETRY_MS)
    console.error(`[module-switch] ${tenant.slug}: aligning config.modules to the platform state failed (retried later):`, errText(err))
  }
}

/** Insert platform requests the tenant table does not know (a failed tenant-side insert after the platform accepted). */
async function adopt(tenant: TenantContext, d: ReconcilerDeps, requests: readonly CouncilRequestRow[]): Promise<number> {
  const known = new Set((await d.store.listSwitches(tenant.db, KNOWN_LIMIT)).map((r) => r.requestId))
  let adopted = 0
  for (const p of requests) {
    if (known.has(p.request_id)) continue
    const action = p.kind === 'disable_module' ? 'disable' : 'enable'
    const ok = switchable(p.module)
    try {
      await d.store.insertSwitch(tenant.db, {
        requestId: p.request_id,
        moduleId: p.module ?? 'unknown',
        action,
        actorUserId: p.actor ?? 'unknown',
        state: ok ? 'queued' : 'refused',
        // The platform's creation time, so rows are applied oldest first (the DB default would stamp the adoption time).
        submittedAt: p.created_at,
      })
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === '23505') continue // another reconciler adopted it first
      console.error(`[module-switch] ${tenant.slug}: adopting request ${p.request_id} failed:`, errText(err))
      continue
    }
    adopted++
    if (ok) {
      console.warn(`[module-switch] ${tenant.slug}: adopted request ${p.request_id} (${action} ${p.module}, platform state ${p.state}) that the tenant table did not know`)
    } else {
      // Never reachable through the service (it refuses non-switchable ids first). Recorded, never applied.
      console.warn(`[module-switch] ${tenant.slug}: adopted request ${p.request_id} for non-switchable module ${p.module ?? '(none)'} as refused`)
      const written = await d.store.updateSwitch(tenant.db, p.request_id, { outcome: NOT_SWITCHABLE_TEXT, finishedAt: p.finished_at ?? new Date(d.now()) })
      if (!written) console.error(`[module-switch] ${tenant.slug}: the outcome of adopted request ${p.request_id} was lost (its record vanished)`)
    }
  }
  return adopted
}

function eventOf(tenant: TenantContext, row: SwitchRow, outcome: ModuleSwitchEvent['outcome'], detail: string | null, at: Date): ModuleSwitchEvent {
  return {
    requestId: row.requestId,
    tenantId: tenant.id,
    slug: tenant.slug,
    moduleId: row.moduleId,
    manifestId: manifestIdOf(row.moduleId),
    action: row.action,
    outcome,
    actorUserId: row.actorUserId,
    at,
    detail,
  }
}

/**
 * One reconciler pass for one tenant. See the file header. Resolves the counts of this pass:
 * `applied` requests whose result now stands in config.modules, `failed` requests that ended without
 * being applied (a final failure, or an apply that threw and will be retried), `adopted` unknown requests.
 */
export async function runModuleSwitchPass(tenant: TenantContext, deps: Partial<ReconcilerDeps> = {}): Promise<{ applied: number; failed: number; adopted: number }> {
  const d: ReconcilerDeps = { ...defaults(), ...deps }
  const out = { applied: 0, failed: 0, adopted: 0 }
  const db = tenant.db
  const council = d.council()

  await alignOnce(tenant, d, council)

  let pending = await d.store.pendingSwitches(db)
  const lastSweep = d.state.sweptAt.get(tenant.id)
  const sweepDue = lastSweep === undefined || d.now() - lastSweep >= SWEEP_INTERVAL_MS
  // Cadence: nothing pending means no platform call, except the read at boot and then every SWEEP_INTERVAL_MS, which also adopts.
  if (pending.length === 0 && !sweepDue) return out

  const requests = await council.requests(tenant.slug, REQUEST_LIMIT)
  d.state.sweptAt.set(tenant.id, d.now())
  out.adopted = await adopt(tenant, d, requests)
  if (out.adopted > 0) pending = await d.store.pendingSwitches(db)

  const byId = new Map(requests.map((p) => [p.request_id, p]))
  for (const row of pending) {
    const p = byId.get(row.requestId)
    if (!p) continue // not (or no longer) in the platform's newest 100: nothing to learn
    if (p.state === 'succeeded') {
      const manifestId = switchable(row.moduleId) ? manifestIdOf(row.moduleId) : null
      if (manifestId === null) {
        await finishFailed(tenant, d, row, p, 'refused', NOT_SWITCHABLE_TEXT, out)
      } else {
        await apply(tenant, d, row, p, manifestId, out)
      }
    } else if (isFinalFailure(p.state)) {
      await finishFailed(tenant, d, row, p, p.state, clip(p.outcome?.trim() || FAILURE_TEXT[p.state]), out)
    }
    // queued / running: the executor has not finished; the row stays pending
  }
  return out
}

/** A request that ended without success: store the outcome, move the row to the final state, tell the listeners once. */
async function finishFailed(
  tenant: TenantContext,
  d: ReconcilerDeps,
  row: SwitchRow,
  p: CouncilRequestRow,
  state: FinalFailure,
  outcome: string,
  out: { applied: number; failed: number; adopted: number },
): Promise<void> {
  const db = tenant.db
  const finishedAt = p.finished_at ?? new Date(d.now())
  // The text first (idempotent: both reconcilers write the same), then the atomic move decides who goes on.
  const stored = await d.store.updateSwitch(db, row.requestId, { outcome, finishedAt })
  if (!stored) console.error(`[module-switch] ${tenant.slug}: the outcome of request ${row.requestId} was lost (its record vanished)`)
  const claimed = await d.store.claimTransition(db, row.requestId, ['queued', 'succeeded'], state)
  if (!claimed) return // another reconciler holds it
  out.failed++
  if (await d.store.claimNotification(db, row.requestId)) {
    await notifyModuleSwitchListeners(eventOf(tenant, row, state, p.outcome?.trim() || null, finishedAt))
  }
}

/** A succeeded request: take the claim, write config.modules, catch up migrations (enable), mark applied, notify once. */
async function apply(
  tenant: TenantContext,
  d: ReconcilerDeps,
  row: SwitchRow,
  p: CouncilRequestRow,
  manifestId: string,
  out: { applied: number; failed: number; adopted: number },
): Promise<void> {
  const db = tenant.db
  // queued -> applying directly: the row may not have been moved to `succeeded` yet. An `applying` row is taken
  // over only when its lease expired (claimTransition). null = another reconciler holds it.
  const claimed = await d.store.claimTransition(db, row.requestId, ['queued', 'succeeded'], 'applying')
  if (!claimed) return

  const enable = row.action === 'enable'
  try {
    if (enable) {
      await runPreApplyHooks({
        requestId: row.requestId,
        tenantId: tenant.id,
        slug: tenant.slug,
        moduleId: row.moduleId,
        manifestId,
        action: row.action,
        actorUserId: row.actorUserId,
        detail: p.outcome?.trim() || null,
      })
    }
    // An explicit, identical value needs no write (and no write permission on config.json).
    if ((d.readConfig(tenant).modules ?? {})[manifestId] !== enable) {
      d.writeConfig({ modules: { [manifestId]: enable } }, tenant)
    }
    if (enable) {
      const m = await d.migrate({ id: tenant.id, slug: tenant.slug })
      if (!m.ok) throw new Error(m.error ?? 'module migration catch-up failed')
    }
  } catch (err) {
    // Stay `applying` with the error visible; the lease expires and the next pass retries. Never "switched".
    const message = clip(errText(err))
    console.error(`[module-switch] ${tenant.slug}: applying request ${row.requestId} (${row.action} ${row.moduleId}) failed, retried after the lease:`, message)
    const recorded = await d.store.updateSwitch(db, row.requestId, { configError: message })
    if (!recorded) console.error(`[module-switch] ${tenant.slug}: the error of request ${row.requestId} could not be recorded (its record vanished)`)
    out.failed++
    return
  }

  const appliedAt = new Date(d.now())
  const finishedAt = p.finished_at ?? appliedAt
  const written = await d.store.updateSwitch(db, row.requestId, {
    state: 'applied',
    appliedAt,
    finishedAt,
    outcome: p.outcome ? clip(p.outcome.trim()) : null,
    configError: null,
  })
  if (!written) console.error(`[module-switch] ${tenant.slug}: request ${row.requestId} was applied but its record vanished`)
  out.applied++
  if (await d.store.claimNotification(db, row.requestId)) {
    await notifyModuleSwitchListeners(eventOf(tenant, row, 'applied', p.outcome?.trim() || null, appliedAt))
  }
}
