// Module Karenz (phase 2, Task 19): a tenant whose previous period of one module ran the whole Karenz.
// Shared by the page tests of the votes and elections modules ("retained records shown again after the
// fresh start"). The engine is the real one (runKarenzPass); the platform, the step ledger, the clock and the
// module participant are doubles, and the tenant pool is the in-memory stand-in of fake-db.test-util plus the
// two statements the list and the redaction issue.
//
//   sealAndFinalize()  pass 1 on an open row seals the copy through the real sealLines (the `retained`
//                      stage), pass 2 on the finalizing live row runs the participant's final deletion and
//                      reports tenant_done. After it the module's own data is gone (`moduleDataGone`), the
//                      row is `finalized`, and the tenant pool must still hold the sealed copy.
//   The fake pool throws on any statement it does not know, so a DELETE or UPDATE of retained_record
//   anywhere in the engine would fail the pass; `mutations()` lists such statements for the explicit assert.
import { sealLines } from './crypto'
import { fakeTenantDb } from './fake-db.test-util'
import type { RetainedLine } from './extractors'
import type { TenantContext } from '$lib/server/tenant/context'
import type { KarenzParticipant } from '../participants'
import type { KarenzRowView } from '../platform'
import { _clearKarenzStagesForTests, _resetKarenzPassForTests, registerKarenzStages, runKarenzPass, type KarenzPassDeps, type KarenzStepStore } from '../engine'
import type { StepRow } from '../store'

export const DAY = 24 * 3_600_000

export interface FinalizedPeriodOptions {
  tenantId: string
  slug: string
  catalogueId: string
  extractorId: string
  retentionClass: string
  lines: RetainedLine[]
  secret: string
  karenzId?: string
}

export function finalizedPeriodWorld(o: FinalizedPeriodOptions) {
  const karenzId = o.karenzId ?? '44444444-4444-4444-8444-4444444444aa'
  const t = fakeTenantDb()
  const base = t.db as unknown as ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) & { unsafe: unknown; begin: unknown }
  const erased: string[] = []
  const created = new Date('2026-10-01T10:00:00.000Z')
  const db = Object.assign(
    async (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join('?')
      if (/FROM erasure_report/.test(text)) return erased.map((subject_ref) => ({ subject_ref }))
      if (/FROM retained_record/.test(text) && /ORDER BY/.test(text) && !/WHERE/.test(text)) {
        return t.records().map((r) => ({ id: r.id, catalogue_id: r.catalogue_id, retention_class: r.retention_class, line_count: r.line_count, created_at: created }))
      }
      return base(s, ...v)
    },
    { unsafe: base.unsafe, begin: base.begin },
  )
  const tenant = { id: o.tenantId, slug: o.slug, db } as unknown as TenantContext

  let now = new Date(created)
  const steps = new Map<string, StepRow>()
  const store: KarenzStepStore = {
    async getStep(_db, k, step) {
      const r = steps.get(`${k}|${step}`)
      return r ? { ...r } : null
    },
    async listSteps(_db, k) {
      return [...steps.values()].filter((r) => r.karenzId === k).map((r) => ({ ...r }))
    },
    async markStep(_db, k, step, patch) {
      const prev = steps.get(`${k}|${step}`)
      const row: StepRow = {
        karenzId: k,
        step,
        state: patch.state,
        attempts: (prev?.attempts ?? 0) + 1,
        lastError: patch.error ?? null,
        lastReportedAt: prev?.lastReportedAt ?? null,
        doneAt: patch.state === 'done' ? now : (prev?.doneAt ?? null),
        updatedAt: now,
      }
      steps.set(`${k}|${step}`, row)
      return { ...row }
    },
    async upsertItem() {
      throw new Error('the participant of this world keeps no items')
    },
    async listItems() {
      return []
    },
    async setItemState() {
      return false
    },
  }

  let moduleDataGone = false
  const participant: KarenzParticipant = {
    catalogueId: o.catalogueId,
    async switchOff() {},
    async restore() {},
    // the module's own data goes; the sealed copy is not the participant's to touch
    async finalize(_ctx, f) {
      if (!f.dryRun) moduleDataGone = true
      return { deleted: { records: f.dryRun ? 0 : o.lines.length } }
    },
  }

  const row: KarenzRowView = {
    karenzId,
    catalogueId: o.catalogueId,
    manifestId: o.catalogueId,
    state: 'open',
    switchedOffAt: created,
    finalAt: new Date(created.getTime() + 30 * DAY),
    restoreRequestedAt: null,
    finalMode: null,
    platformDoneAt: null,
    tenantDoneAt: null,
  }
  const deps = (): Partial<KarenzPassDeps> => ({
    listKarenz: async () => [{ ...row }],
    reportKarenz: async (_customerId, _karenzId, e) => {
      if (e.mark === 'tenant_done') {
        row.tenantDoneAt = now
        row.state = 'finalized'
      }
    },
    participantsFor: () => [participant],
    store,
    writeAudit: async () => {},
    startedActor: async () => null,
    hasLocalEvidence: async () => false,
    pruneErasure: async () => 0,
    now: () => now,
  })

  return {
    tenant,
    karenzId,
    erase: (subjectRef: string) => erased.push(subjectRef),
    get moduleDataGone() {
      return moduleDataGone
    },
    get rowState() {
      return row.state
    },
    records: () => t.records(),
    statements: () => t.statements,
    /** Statements that change or remove a sealed copy or a data key (there must be none). */
    mutations: () => t.statements.filter((s) => /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?|UPDATE)\s+(retained_record|karenz_data_key)/i.test(s)),
    async sealAndFinalize() {
      _resetKarenzPassForTests()
      _clearKarenzStagesForTests()
      registerKarenzStages({
        retained: async (ctx) => {
          await sealLines(db as never, o.tenantId, ctx.karenzId, o.extractorId, o.lines, { catalogueId: o.catalogueId, retentionClass: o.retentionClass }, { secret: o.secret, guard: async () => {} })
        },
      })
      await runKarenzPass(tenant, deps())
      // day 30: the platform job moved the row to finalizing and recorded the live mode
      now = new Date(row.finalAt.getTime() + 60_000)
      row.state = 'finalizing'
      row.finalMode = 'live'
      row.platformDoneAt = now
      await runKarenzPass(tenant, deps())
      _clearKarenzStagesForTests()
    },
  }
}
