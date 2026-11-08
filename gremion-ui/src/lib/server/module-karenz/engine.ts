// src/lib/server/module-karenz/engine.ts
// Module Karenz (phase 2, Task 8): the per-tenant pass.
//
// The platform row (plt.module_karenz) is the clock; everything that needs the tenant (mail, Matrix,
// Polls, Helios, Nextcloud, sealed records, erasure) runs here, in gremion-ui, as an IDEMPOTENT pass
// that pulls its work from the platform rows (platform.ts), drives the registered participants
// (participants.ts), keeps a step ledger in the tenant database (store.ts) and reports step results
// back as append-only platform events. A crash at any point is resumed, not repeated: a step that is
// done is never run again.
//
// Per live row, by the row's state:
//   open        started (audit), notice:switchoff, retained, publish:*, every participant's switchOff,
//               then the day-23 and day-29 reminders when due. Past final_at: in dry mode the
//               participants' finalize(dryRun) is reported as ONE info line per 24 h and nothing is
//               deleted; with no mode recorded yet (or a live mode the platform job has not acted on
//               yet) the pass waits for the platform job.
//   restoring   every participant's restore, then the 'restored' mark, only when all of them are done.
//               More than an hour in this state is an error event of its own.
//   finalizing  (set by the platform job, so the mode is live) every participant's finalize(live) and
//               the 'tenant_done' mark, but ONLY once the retained copies exist (step `retained` done,
//               no failed `publish:*` step): without them the pass refuses and says so. The retained
//               and publish stages are retried first, on every pass: the platform job flips the row at
//               final_at without reading this ledger, so a stage still failing then must recover here.
//
// Failure handling: a failing step is recorded failed, reported once as an error event (again after 6
// hours, at once when the text changes), and the NEXT step still runs. The platform sees the error
// class and a count, never a message: external clients put paths and names into their messages. A
// success after a failure reports info. Reports are advisory (plan Open Decision 8); nothing
// destructive on the platform side depends on them.
//
// Stage slots: notice, retained copies, publishing and reminders belong to Tasks 9, 10 and 11, which
// register their stage with registerKarenzStages(). A stage that is not registered leaves its step
// unmarked, so the finalize guard refuses until the retained copies really exist (fail closed). The
// retained stage is registered here for every catalogue id and itself fails closed: a catalogue id with
// neither a retention extractor nor a registerNoRetention() declaration fails the step.
import type { Sql } from '@gremion/db'
import { writeAuditEntry, type AuditEntry } from '$lib/server/audit-db'
import { safeFailureReason } from '$lib/server/erasure/orchestrator'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import { listSwitches, type SwitchRow } from '$lib/server/module-switch/store'
import type { TenantContext } from '$lib/server/tenant/context'
import { KarenzPartialError, karenzParticipantsFor, type KarenzContext, type KarenzParticipant } from './participants'
import { listKarenz, reportKarenz, type KarenzReport, type KarenzRowView } from './platform'
import { reminderDue } from './mail'
import { createNoticeStages } from './notices'
import { writeRetainedCopies } from './retained/write'
import * as realStore from './store'
import type { ItemState, KarenzItem, KarenzItemRow, StepPatch, StepRow } from './store'

/** How often register.server.ts runs a pass per active tenant. */
export const KARENZ_PASS_INTERVAL_MS = 5 * 60_000

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** An unchanged failure is reported again after this long. */
const FAILURE_REPORT_INTERVAL_MS = 6 * HOUR
/** The dry run's "would delete" line is reported at most this often. */
const DRY_REPORT_INTERVAL_MS = 24 * HOUR
/** A restore that has not finished this long after the switch-on is an error. */
const RESTORE_STUCK_MS = HOUR
/** The "no council pool" message with a Karenz on record is logged at most this often per tenant. */
const NOT_CONFIGURED_LOG_INTERVAL_MS = 10 * 60_000
/** The Karenz length, for the "is there local evidence of a live Karenz" check. */
const KARENZ_WINDOW_MS = 31 * DAY

/** The author of audit entries the pass writes when no council request names a person (an operator-origin switch-off). */
export const KARENZ_SERVICE_USER = 'karenz-service'

/** The step names of the ledger and of the platform event log (^[a-z][a-z0-9:_-]{0,59}$). */
export const STEP = {
  started: 'started',
  noticeSwitchoff: 'notice:switchoff',
  retained: 'retained',
  participant: (id: string, phase: 'switchoff' | 'restore' | 'final') => `participant:${id}:${phase}`,
  noticeT23: 'notice:t23',
  noticeT29: 'notice:t29',
  publish: (sinkId: string, recordId: string) => `publish:${sinkId}:${recordId}`,
  /** Building the publish list itself failed (a sink lookup, not one publication). */
  publishList: 'publish:list',
  /** The completion step of a restore: reports the `restored` mark. */
  restore: 'restore',
  restoreStuck: 'restore:stuck',
  /** The tenant-side dry run of the final day (one info line per 24 h). */
  finalDry: 'final:dry',
  /** The completion step of the final day: reports the `tenant_done` mark; also where a refused finalize is recorded. */
  final: 'final',
} as const

/** The tenant-database store the pass uses (store.ts is the production implementation). */
export interface KarenzStepStore {
  getStep(db: Sql, karenzId: string, step: string): Promise<StepRow | null>
  listSteps(db: Sql, karenzId: string): Promise<StepRow[]>
  markStep(db: Sql, karenzId: string, step: string, patch: StepPatch): Promise<StepRow>
  upsertItem(db: Sql, item: KarenzItem): Promise<KarenzItemRow>
  listItems(db: Sql, karenzId: string, kind?: string): Promise<KarenzItemRow[]>
  setItemState(db: Sql, itemId: string, state: ItemState, detail?: string): Promise<boolean>
}

/**
 * The work of Tasks 9, 10 and 11, plugged in by registration so the engine does not change when they
 * land. Each runs inside a ledger step; a rejection fails the step, which is retried on the next pass.
 */
export interface KarenzStages {
  /** Task 9: the info mail at switch-off. May return a one-line summary ("sent 3, skipped 1"); it is the info event of step notice:switchoff. */
  noticeSwitchoff?: (ctx: KarenzContext) => Promise<string | void>
  /** Task 9: the day-23 / day-29 reminder, run when due. Same summary contract; the event is notice:t23 / notice:t29. */
  reminder?: (ctx: KarenzContext, kind: 't23' | 't29') => Promise<string | void>
  /** Task 10: seal the retained copies. A step that is not done blocks the final deletion. */
  retained?: (ctx: KarenzContext) => Promise<void>
  /** Task 11: one named step per (retained record, sink) that is available. A failed one blocks the final deletion and is retried. */
  publish?: (ctx: KarenzContext) => Promise<Array<{ step: string; run: () => Promise<void> }>>
}

/**
 * The engine's own stages are there without any registration: Task 9's info mail and reminders, and
 * Task 10's `retained` stage, the sealed-copy writer. The writer lives here (not in a module) because
 * every module's extractors register into retained/extractors.ts and the writer runs for all of them.
 */
const defaultStages = (): KarenzStages => ({
  ...createNoticeStages(),
  retained: async (ctx) => {
    const { records, lines } = await writeRetainedCopies(ctx)
    ctx.log(`retained: ${records} record(s), ${lines} line(s) written in this pass`)
  },
})

let registeredStages: KarenzStages = defaultStages()

/** Register (merge) the stages of Tasks 9 to 11. A second registration of the same stage replaces it. */
export function registerKarenzStages(s: KarenzStages): void {
  registeredStages = { ...registeredStages, ...s }
}

/** Test-only: drop every registered stage, the defaults included. */
export function _clearKarenzStagesForTests(): void {
  registeredStages = {}
}

/** Test-only: back to the stages a fresh process has. */
export function _resetKarenzStagesToDefaultsForTests(): void {
  registeredStages = defaultStages()
}

/** Test-only: what is registered right now. */
export function _registeredStagesForTests(): Readonly<KarenzStages> {
  return { ...registeredStages }
}

export interface KarenzPassDeps {
  listKarenz: (customerId: string) => Promise<KarenzRowView[]>
  reportKarenz: (customerId: string, karenzId: string, e: KarenzReport) => Promise<void>
  participantsFor: (catalogueId: string) => readonly KarenzParticipant[]
  stages: () => KarenzStages
  store: KarenzStepStore
  writeAudit: (entry: AuditEntry) => Promise<void>
  /** The user id that switched the module off (from module_switch_request), or null when there is none (an operator-origin switch-off). */
  startedActor: (tenant: TenantContext, catalogueId: string, switchedOffAt: Date) => Promise<string | null>
  /** True when the tenant holds local evidence of a live Karenz (used only when the council pool is not configured). */
  hasLocalEvidence: (tenant: TenantContext) => Promise<boolean>
  now: () => Date
}

export interface KarenzPassResult {
  /** Step bodies executed in this pass (a step that was already done is not counted). */
  steps: number
  /** Steps (and refusals) that ended in failure in this pass. */
  failed: number
}

/** The request states a tenant switch request can be in while its platform row already exists (the reconciler marks it applied later). */
const ACTOR_REQUEST_STATES: ReadonlySet<string> = new Set(['queued', 'succeeded', 'applying', 'applied'])
/** A council disable is submitted before the platform row exists (the council round, then retries). */
const ACTOR_LEAD_MS = 6 * HOUR
/** The tenant and the platform database are on one host, but their clocks are read separately. */
const ACTOR_CLOCK_SLACK_MS = 5 * 60_000

/**
 * The person who switched the module off, for the audit entry of THIS row: the newest request of the
 * module (any action, any state that can still be live) submitted no later than the platform row, and
 * only when that request is a disable made shortly before the row. So a pass that runs before the
 * reconciler has marked the request applied still finds it, and an operator-origin disable (which has
 * no request of its own) is not credited to an older council disable, or to one that a switch-on has
 * since undone. null: no council person (the audit entry names the service).
 */
export function pickStartedActor(rows: readonly SwitchRow[], catalogueId: string, switchedOffAt: Date): string | null {
  const at = switchedOffAt.getTime()
  const newest = rows
    .filter((r) => r.moduleId === catalogueId && ACTOR_REQUEST_STATES.has(r.state) && r.submittedAt.getTime() <= at + ACTOR_CLOCK_SLACK_MS)
    .toSorted((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())[0]
  if (!newest || newest.action !== 'disable') return null
  if (at - newest.submittedAt.getTime() > ACTOR_LEAD_MS) return null
  return newest.actorUserId
}

async function defaultStartedActor(tenant: TenantContext, catalogueId: string, switchedOffAt: Date): Promise<string | null> {
  return pickStartedActor(await listSwitches(tenant.db, 200), catalogueId, switchedOffAt)
}

/** Exported for the test: `now` is the clock. */
export async function defaultHasLocalEvidence(tenant: TenantContext, nowDate: Date = new Date()): Promise<boolean> {
  try {
    // A pending or failed step counts only while a Karenz could still be live: a step that failed and
    // was never closed (a notice failure, then a restore) must not keep the error line up for ever.
    const open = await tenant.db<{ updated_at: Date }[]>`
      SELECT updated_at FROM module_karenz_step WHERE state IN ('pending', 'failed') ORDER BY updated_at DESC LIMIT 1`
    if (open[0] && nowDate.getTime() - open[0].updated_at.getTime() < KARENZ_WINDOW_MS) return true
    const now = nowDate.getTime()
    const newest = new Map<string, { action: string; at: number }>()
    for (const r of await listSwitches(tenant.db, 200)) {
      if (r.state !== 'applied' || newest.has(r.moduleId)) continue
      newest.set(r.moduleId, { action: r.action, at: (r.appliedAt ?? r.submittedAt).getTime() })
    }
    return [...newest.values()].some((x) => x.action === 'disable' && now - x.at < KARENZ_WINDOW_MS)
  } catch {
    // cannot tell: say it loudly rather than not at all
    return true
  }
}

function defaults(): KarenzPassDeps {
  return {
    listKarenz: (customerId) => listKarenz(customerId),
    reportKarenz,
    participantsFor: karenzParticipantsFor,
    stages: () => registeredStages,
    store: realStore,
    writeAudit: (entry) => writeAuditEntry(entry),
    startedActor: defaultStartedActor,
    hasLocalEvidence: defaultHasLocalEvidence,
    now: () => new Date(),
  }
}

const inflight = new Map<string, Promise<KarenzPassResult>>()
const notConfiguredLoggedAt = new Map<string, number>()

/** Test-only: forget the single-flight and the log rate limit. */
export function _resetKarenzPassForTests(): void {
  inflight.clear()
  notConfiguredLoggedAt.clear()
}

interface RowEnv {
  tenant: TenantContext
  d: KarenzPassDeps
  row: KarenzRowView
  ctx: KarenzContext
  counters: KarenzPassResult
}

const LIVE_STATES: ReadonlySet<string> = new Set(['open', 'restoring', 'finalizing'])

/** What may reach the platform and the ledger about a failure: the class and the count, never a message. */
function describeFailure(err: unknown): string {
  if (err instanceof KarenzPartialError) return `KarenzPartialError (${err.failures.length} item(s))`
  return safeFailureReason(err)
}

function logFailure(env: RowEnv, step: string, err: unknown): void {
  const detail = err instanceof KarenzPartialError ? err.failures.join('; ') : err
  console.error(`[module-karenz] ${env.tenant.slug}: step ${step} of Karenz ${env.row.karenzId} (${env.row.catalogueId}) failed:`, detail)
}

function makeContext(tenant: TenantContext, d: KarenzPassDeps, row: KarenzRowView): KarenzContext {
  const db = tenant.db
  return {
    tenant,
    karenzId: row.karenzId,
    catalogueId: row.catalogueId,
    manifestId: row.manifestId,
    switchedOffAt: row.switchedOffAt,
    finalAt: row.finalAt,
    now: () => d.now(),
    items: {
      list: (kind) => d.store.listItems(db, row.karenzId, kind),
      upsert: (i) => d.store.upsertItem(db, { ...i, karenzId: row.karenzId }),
      setState: async (itemId, state, detail) => {
        if (!(await d.store.setItemState(db, itemId, state, detail))) throw new Error(`Karenz item ${itemId} no longer exists`)
      },
    },
    log: (line) => console.info(`[module-karenz] ${tenant.slug} ${row.catalogueId}: ${line}`),
  }
}

/** Post one event; a platform that cannot be reached is logged and answered with false (the step is then reported again later). */
async function safeReport(env: RowEnv, e: KarenzReport): Promise<boolean> {
  try {
    await env.d.reportKarenz(env.tenant.id, env.row.karenzId, e)
    return true
  } catch (err) {
    console.error(`[module-karenz] ${env.tenant.slug}: reporting step ${e.step} of Karenz ${env.row.karenzId} failed (retried on the next pass):`, err instanceof Error ? err.message : err)
    return false
  }
}

/** Record a failed step; report it once (6 h for an unchanged text, at once for a new one). */
async function recordFailure(env: RowEnv, step: string, message: string, prev: StepRow | null): Promise<void> {
  env.counters.failed++
  const now = env.d.now().getTime()
  const due =
    !prev || prev.state !== 'failed' || prev.lastError !== message || prev.lastReportedAt === null || now - prev.lastReportedAt.getTime() >= FAILURE_REPORT_INTERVAL_MS
  const reported = due ? await safeReport(env, { step, level: 'error', message }) : false
  await env.d.store.markStep(env.tenant.db, env.row.karenzId, step, { state: 'failed', error: message, reported })
}

/**
 * Run one ledger step: skip it when done, otherwise run it and record the result. `reportsItself`
 * is for a step whose body IS a report (a mark, a notice summary): its success needs no second line.
 */
async function runStep(env: RowEnv, step: string, fn: () => Promise<void>, opts: { reportsItself?: boolean } = {}): Promise<'done' | 'skipped' | 'failed'> {
  const { d, row } = env
  const prev = await d.store.getStep(env.tenant.db, row.karenzId, step)
  if (prev?.state === 'done' || prev?.state === 'skipped') return 'skipped'
  env.counters.steps++
  try {
    await fn()
  } catch (err) {
    logFailure(env, step, err)
    await recordFailure(env, step, describeFailure(err), prev)
    return 'failed'
  }
  await d.store.markStep(env.tenant.db, row.karenzId, step, { state: 'done' })
  if (prev?.state === 'failed' && !opts.reportsItself) {
    await safeReport(env, { step, level: 'info', message: `recovered after ${prev.attempts} attempt(s)` })
  }
  return 'done'
}

/** The report that completes a step, as the step's body: a platform that refuses it leaves the step open. */
async function report(env: RowEnv, e: KarenzReport): Promise<void> {
  await env.d.reportKarenz(env.tenant.id, env.row.karenzId, e)
}

/**
 * The retained copies (Task 10) and their publication (Task 11), each through the ledger: a step that
 * is done is skipped, one that failed is run again. Called on an open row AND on a finalizing one: the
 * platform job moves a row to finalizing at final_at without looking at this ledger (the report channel
 * is advisory), so a stage that was still failing on day 30 must keep being retried there, or the
 * finalize guard would refuse for ever.
 */
async function runRetentionStages(env: RowEnv): Promise<void> {
  const { tenant, d, row, ctx } = env
  const stages = d.stages()
  if (stages.retained) {
    const retained = stages.retained
    await runStep(env, STEP.retained, () => retained(ctx))
  }
  if (stages.publish) {
    let publishSteps: Array<{ step: string; run: () => Promise<void> }> = []
    let listed = false
    try {
      publishSteps = await stages.publish(ctx)
      listed = true
    } catch (err) {
      // the list itself could not be built: recorded under a step of its own so it is visible and retried
      const prev = await d.store.getStep(tenant.db, row.karenzId, STEP.publishList)
      logFailure(env, STEP.publishList, err)
      await recordFailure(env, STEP.publishList, describeFailure(err), prev)
    }
    if (listed) {
      // a list that builds again clears an earlier failure of the list: nothing else ever would, and the
      // finalize guard refuses on any failed publish:* step
      const prev = await d.store.getStep(tenant.db, row.karenzId, STEP.publishList)
      if (prev?.state === 'failed') {
        await d.store.markStep(tenant.db, row.karenzId, STEP.publishList, { state: 'done' })
        await safeReport(env, { step: STEP.publishList, level: 'info', message: `recovered after ${prev.attempts} attempt(s)` })
      }
    }
    for (const p of publishSteps) await runStep(env, p.step, p.run)
  }
}

const REMINDER_STEPS = [
  ['t23', STEP.noticeT23],
  ['t29', STEP.noticeT29],
] as const

/**
 * A reminder that was never sent is not sent after the final day ("deleted tomorrow" after the deletion
 * would be false), but it is not silent either: an error event of its own step, so the failed gauge and
 * the log see it. Called for an open row past final_at AND for a finalizing one: in live mode the
 * platform job moves the row to finalizing at final_at, so the window in which the row is still open is
 * only as long as the gap to that job's next run.
 */
async function reportMissedReminders(env: RowEnv): Promise<void> {
  if (!env.d.stages().reminder) return
  for (const [kind, step] of REMINDER_STEPS) {
    const prev = await env.d.store.getStep(env.tenant.db, env.row.karenzId, step)
    if (prev?.state === 'done' || prev?.state === 'skipped') continue
    env.counters.steps++
    await recordFailure(env, step, `the ${kind} reminder was not sent before the final day`, prev)
  }
}

async function processOpen(env: RowEnv): Promise<void> {
  const { tenant, d, row, ctx } = env
  const stages = d.stages()
  const participants = d.participantsFor(row.catalogueId)

  await runStep(env, STEP.started, async () => {
    const actor = await d.startedActor(tenant, row.catalogueId, row.switchedOffAt)
    // The actor is audit-only: it is never put in a mail, a report or a response.
    await d.writeAudit({
      userId: actor ?? KARENZ_SERVICE_USER,
      field: 'module.karenz.started',
      oldValue: null,
      newValue: `module=${row.catalogueId} karenz=${row.karenzId} final_at=${row.finalAt.toISOString()}`,
    })
  })

  if (stages.noticeSwitchoff) {
    const notice = stages.noticeSwitchoff
    await runStep(env, STEP.noticeSwitchoff, async () => report(env, { step: STEP.noticeSwitchoff, level: 'info', message: (await notice(ctx)) || 'done' }), { reportsItself: true })
  }
  await runRetentionStages(env)
  for (const p of participants) {
    await runStep(env, STEP.participant(p.catalogueId, 'switchoff'), () => p.switchOff(ctx))
  }

  const now = d.now().getTime()
  if (now >= row.finalAt.getTime()) {
    await reportMissedReminders(env)
    if (row.finalMode === 'dry') await dryRunFinal(env, participants)
    // finalMode null: the platform job has not looked at the row yet; 'live': it is about to move the row to finalizing. Either way, wait.
    return
  }
  if (stages.reminder) {
    const reminder = stages.reminder
    for (const [kind, step] of REMINDER_STEPS) {
      if (now >= reminderDue(kind, row.finalAt).getTime()) {
        await runStep(env, step, async () => report(env, { step, level: 'info', message: (await reminder(ctx, kind)) || 'done' }), { reportsItself: true })
      }
    }
  }
}

/** The tenant-side half of the deletion switch being off: say what WOULD be deleted, once per 24 h, and delete nothing. */
async function dryRunFinal(env: RowEnv, participants: readonly KarenzParticipant[]): Promise<void> {
  const { tenant, d, row, ctx } = env
  const prev = await d.store.getStep(tenant.db, row.karenzId, STEP.finalDry)
  if (prev?.state === 'pending' && prev.lastReportedAt && d.now().getTime() - prev.lastReportedAt.getTime() < DRY_REPORT_INTERVAL_MS) return
  env.counters.steps++
  const would: string[] = []
  const failures: string[] = []
  for (const p of participants) {
    try {
      const r = await p.finalize(ctx, { dryRun: true })
      for (const [key, n] of Object.entries(r.deleted)) if (n > 0) would.push(`${p.catalogueId}.${key}=${n}`)
    } catch (err) {
      logFailure(env, `${STEP.finalDry}:${p.catalogueId}`, err)
      failures.push(`${p.catalogueId}: ${describeFailure(err)}`)
    }
  }
  if (failures.length > 0) {
    await recordFailure(env, STEP.finalDry, `deletion off: the dry run failed (${failures.join('; ')})`, prev)
    return
  }
  const reported = await safeReport(env, { step: STEP.finalDry, level: 'info', message: `deletion off: would delete: ${would.length > 0 ? would.join(', ') : 'nothing'}` })
  await d.store.markStep(tenant.db, row.karenzId, STEP.finalDry, { state: 'pending', reported })
}

async function processRestoring(env: RowEnv): Promise<void> {
  const { tenant, d, row, ctx } = env
  const participants = d.participantsFor(row.catalogueId)
  for (const p of participants) {
    await runStep(env, STEP.participant(p.catalogueId, 'restore'), () => p.restore(ctx))
  }
  const steps = await d.store.listSteps(tenant.db, row.karenzId)
  const doneNames = new Set(steps.filter((s) => s.state === 'done').map((s) => s.step))
  const missing = participants.map((p) => STEP.participant(p.catalogueId, 'restore')).filter((s) => !doneNames.has(s))
  if (missing.length === 0) {
    const out = await runStep(env, STEP.restore, () => report(env, { step: STEP.restore, level: 'info', message: 'every restore step is done', mark: 'restored' }), { reportsItself: true })
    if (out === 'done' && steps.some((s) => s.step === STEP.restoreStuck && s.state === 'failed')) {
      await d.store.markStep(tenant.db, row.karenzId, STEP.restoreStuck, { state: 'done' })
    }
    if (out !== 'failed') return
  }
  // not finished: a restore that takes more than an hour is an error of its own (the lock on a poll or election is still on)
  const requested = row.restoreRequestedAt
  if (requested && d.now().getTime() - requested.getTime() >= RESTORE_STUCK_MS) {
    const prev = steps.find((s) => s.step === STEP.restoreStuck) ?? null
    const open = missing.length > 0 ? `${missing.length} restore step(s) not done` : 'the restored mark was not accepted'
    await recordFailure(env, STEP.restoreStuck, `restoring since ${requested.toISOString()}: ${open}`, prev)
  }
}

async function processFinalizing(env: RowEnv): Promise<void> {
  const { tenant, d, row, ctx } = env
  const participants = d.participantsFor(row.catalogueId)
  // The retained copies and their publication are retried here as well: the platform job flips the row
  // at final_at whatever this ledger says, and the guard below only reads the ledger.
  await reportMissedReminders(env)
  await runRetentionStages(env)
  const steps = await d.store.listSteps(tenant.db, row.karenzId)
  const prev = steps.find((s) => s.step === STEP.final) ?? null

  // Refuse, loudly, whatever the platform says: deleting before the retained copies exist cannot be undone.
  const refusal =
    row.finalMode !== 'live'
      ? 'finalize refused: the row is finalizing but its deletion mode is not live'
      : !steps.some((s) => s.step === STEP.retained && s.state === 'done')
        ? 'finalize refused: the retained copies are not recorded as done (step retained)'
        : steps.some((s) => s.step === STEP.publishList && s.state === 'failed')
          ? 'finalize refused: the list of publish steps for the retained copies could not be built'
          : steps.some((s) => s.step.startsWith('publish:') && s.state === 'failed')
            ? 'finalize refused: a publish step of the retained copies has failed'
            : null
  if (refusal !== null) {
    console.error(`[module-karenz] ${tenant.slug}: Karenz ${row.karenzId} (${row.catalogueId}): ${refusal}`)
    await recordFailure(env, STEP.final, refusal, prev)
    return
  }

  // The counts of THIS pass only: a participant finished in an earlier pass adds nothing (the line is advisory).
  const deleted: string[] = []
  for (const p of participants) {
    await runStep(env, STEP.participant(p.catalogueId, 'final'), async () => {
      const r = await p.finalize(ctx, { dryRun: false })
      for (const [key, n] of Object.entries(r.deleted)) if (n > 0) deleted.push(`${p.catalogueId}.${key}=${n}`)
    })
  }
  const after = await d.store.listSteps(tenant.db, row.karenzId)
  const done = new Set(after.filter((s) => s.state === 'done').map((s) => s.step))
  if (participants.every((p) => done.has(STEP.participant(p.catalogueId, 'final')))) {
    await runStep(
      env,
      STEP.final,
      () =>
        report(env, {
          step: STEP.final,
          level: 'info',
          // a module with no registered participant has nothing to delete here: say that, so a participant that failed to load shows in the event log
          message: `tenant side done${participants.length === 0 ? `: no participant registered for ${row.catalogueId}` : deleted.length > 0 ? `: deleted ${deleted.join(', ')}` : ''}`,
          mark: 'tenant_done',
        }),
      { reportsItself: true },
    )
  }
}

async function processRow(tenant: TenantContext, d: KarenzPassDeps, row: KarenzRowView, counters: KarenzPassResult): Promise<void> {
  const env: RowEnv = { tenant, d, row, ctx: makeContext(tenant, d, row), counters }
  if (row.state === 'open') await processOpen(env)
  else if (row.state === 'restoring') await processRestoring(env)
  else if (row.state === 'finalizing') await processFinalizing(env)
}

async function pass(tenant: TenantContext, d: KarenzPassDeps): Promise<KarenzPassResult> {
  const counters: KarenzPassResult = { steps: 0, failed: 0 }
  let rows: KarenzRowView[]
  try {
    rows = await d.listKarenz(tenant.id)
  } catch (err) {
    if (!(err instanceof CouncilNotConfigured)) throw err
    // Nothing can be read or reported. A tenant with no Karenz has nothing to lose; one with a Karenz on
    // record has a clock nobody is watching, so it is an error in the log (the platform stale gauge pages).
    if (await d.hasLocalEvidence(tenant)) {
      const last = notConfiguredLoggedAt.get(tenant.id)
      const now = d.now().getTime()
      if (last === undefined || now - last >= NOT_CONFIGURED_LOG_INTERVAL_MS) {
        notConfiguredLoggedAt.set(tenant.id, now)
        console.error(
          `[module-karenz] ${tenant.slug}: a module switch-off is on record but PLATFORM_MODULES_DATABASE_URL is not configured - ` +
            'the Karenz pass cannot read or report anything (reminders, restore and the final day are not running)',
        )
      }
    } else {
      console.info(`[module-karenz] ${tenant.slug}: PLATFORM_MODULES_DATABASE_URL not set - nothing to do`)
    }
    return counters
  }
  const live = rows.filter((r) => LIVE_STATES.has(r.state)).toSorted((a, b) => a.switchedOffAt.getTime() - b.switchedOffAt.getTime())
  for (const row of live) {
    try {
      await processRow(tenant, d, row, counters)
    } catch (err) {
      // A store failure on one row (the tenant database) never stops the next row.
      counters.failed++
      console.error(`[module-karenz] ${tenant.slug}: the pass for Karenz ${row.karenzId} (${row.catalogueId}) stopped:`, err instanceof Error ? err.message : err)
    }
  }
  return counters
}

/**
 * One pass for one tenant. Single-flight per tenant in this process: a call while a pass is running
 * returns that pass's result and starts nothing. (Blue and green both run a pass; every phase is
 * idempotent, and the step ledger keeps a repeat from redoing finished work.)
 */
export function runKarenzPass(tenant: TenantContext, deps: Partial<KarenzPassDeps> = {}): Promise<KarenzPassResult> {
  const running = inflight.get(tenant.id)
  if (running) return running
  const p = pass(tenant, { ...defaults(), ...deps }).finally(() => {
    inflight.delete(tenant.id)
  })
  inflight.set(tenant.id, p)
  return p
}
