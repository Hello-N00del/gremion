// TRD-196 / PRD-OPS-005 — DB-backed proof of the erasure seam against the real
// schema (migration 0060 + the kernel tables): the kernel hook really deletes /
// pseudonymises the subject's rows, the report round-trips per module, the DB
// itself refuses a `complete` header over a non-erased module, and one tenant
// cannot read another tenant's reports.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '$lib/server/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { kernelErasureHook } from './kernel-hook'
import { createIdentityErasureHook } from './identity-hook'
import { runErasure, subjectRef, type ErasureDeps } from './orchestrator'
import { createPgReportStore, getErasureReport, listErasureReports } from './report-store'

const TENANT_A = '01920000-0000-7000-8000-00000000aaaa'
const TENANT_B = '01920000-0000-7000-8000-00000000bbbb'
const SUBJECT = 'kc-subject-erasure-1'
const OTHER = 'kc-other-person'

async function seed() {
  const sql = getDb()
  const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Erasure-Gremium', 'committee') RETURNING id`
  // The unit is provisioned in Keycloak and Matrix; Nextcloud was never created (no external id).
  await sql`INSERT INTO provisioning_resources (org_unit_id, subsystem, external_id, status) VALUES
              (${unit.id}, 'keycloak', 'kc-group-1', 'ok'), (${unit.id}, 'matrix', '!room:1', 'failed'),
              (${unit.id}, 'nextcloud', NULL, 'pending')`
  const [role] = await sql<{ id: string }[]>`INSERT INTO committee_roles (org_unit_id, name) VALUES (${unit.id}, 'Vorsitz') RETURNING id`
  for (const u of [SUBJECT, OTHER]) {
    await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${unit.id}, ${u})`
    await sql`INSERT INTO role_assignments (role_id, user_keycloak_id, start_date, end_date, assigned_by_keycloak_id)
              VALUES (${role.id}, ${u}, '2026-01-01', '2026-12-31', ${u === SUBJECT ? OTHER : SUBJECT})`
    await sql`INSERT INTO role_assignment_history (role_id, user_keycloak_id, start_date, end_date, ended_reason)
              VALUES (${role.id}, ${u}, '2025-01-01', '2025-12-31', 'expired')`
    await sql`INSERT INTO notification_read_marker (user_keycloak_id, read_at) VALUES (${u}, now())`
  }
  await sql`INSERT INTO calendar_events (title, start_at, end_at, created_by) VALUES ('Sitzung', now(), now(), ${SUBJECT})`
  return { unitId: unit.id }
}

const pendingOps = (user: string) =>
  getDb()<{ subsystem: string; org_unit_id: string }[]>`
    SELECT subsystem, org_unit_id FROM provisioning_member_ops
    WHERE user_keycloak_id = ${user} AND status <> 'ok' ORDER BY subsystem`

beforeEach(async () => {
  const sql = getDb()
  await sql`TRUNCATE erasure_report, provisioning_member_ops, governance_membership_record, org_units, calendar_events, notification_read_marker, role_assignment_history CASCADE`
})

describe('kernel erasure hook (real schema)', () => {
  it('deletes the subject, pseudonymises history and assigned_by, leaves other people untouched', async () => {
    await seed()
    const sql = getDb()
    const res = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'erased', counts: { org_unit_members: 1, role_assignments: 1, role_assignment_history: 1, notification_read_marker: 1, role_assignments_assigned_by: 1 } })

    expect(await sql`SELECT 1 FROM org_unit_members WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM role_assignments WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM role_assignment_history WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    // the pre-existing history row pseudonymised + the live assignment archived (HIGH-2)
    expect(await sql`SELECT 1 FROM role_assignment_history WHERE user_keycloak_id IS NULL`).toHaveLength(2)
    expect(await sql`SELECT 1 FROM role_assignments WHERE assigned_by_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    // the other person's rows survive
    expect(await sql`SELECT 1 FROM org_unit_members WHERE user_keycloak_id = ${OTHER}`).toHaveLength(1)
    expect(await sql`SELECT 1 FROM role_assignments WHERE user_keycloak_id = ${OTHER}`).toHaveLength(1)
    expect(await sql`SELECT 1 FROM role_assignment_history WHERE user_keycloak_id = ${OTHER}`).toHaveLength(1)
  })

  it('is idempotent: a re-run erases nothing and still reports erased with zero counts', async () => {
    await seed()
    const sql = getDb()
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const again = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(again).toMatchObject({ status: 'erased', counts: { org_unit_members: 0, role_assignments: 0 } })
  })
})

describe('HIGH-1: external identity removal is queued, never cancelled', () => {
  it('enqueues one durable remove-op per provisioned subsystem in the same tx as the membership delete', async () => {
    const { unitId } = await seed()
    const sql = getDb()
    const res = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'erased', counts: { provisioning_member_ops_enqueued: 2 } })
    expect(await pendingOps(SUBJECT)).toEqual([
      { subsystem: 'keycloak', org_unit_id: unitId },
      { subsystem: 'matrix', org_unit_id: unitId },
    ])
    expect(await pendingOps(OTHER)).toEqual([])
  })

  it('never deletes a still-pending remove-op queued before the erasure', async () => {
    const { unitId } = await seed()
    const sql = getDb()
    const [other] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Alt', 'committee') RETURNING id`
    await sql`INSERT INTO provisioning_member_ops (org_unit_id, user_keycloak_id, subsystem, op, status)
              VALUES (${other.id}, ${SUBJECT}, 'nextcloud', 'remove', 'failed'),
                     (${other.id}, ${SUBJECT}, 'keycloak', 'remove', 'ok')`
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const ops = await pendingOps(SUBJECT)
    expect(ops).toContainEqual({ subsystem: 'nextcloud', org_unit_id: other.id })
    expect(ops).toHaveLength(3)
    expect(ops.filter((o) => o.org_unit_id === unitId)).toHaveLength(2)
  })

  it('the identity step is skipped while remove-ops are pending, naming how many', async () => {
    await seed()
    const sql = getDb()
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const drain = vi.fn(async () => {})
    const res = await createIdentityErasureHook({ drain }).erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(drain).toHaveBeenCalledOnce()
    expect(res.status).toBe('skipped')
    expect(res).toMatchObject({ reason: expect.stringMatching(/external identity removal pending: 2 ops queued/) })
    expect(JSON.stringify(res)).not.toContain(SUBJECT)
  })

  it('a synchronous drain that settles the ops is reflected; the Keycloak account still keeps it skipped', async () => {
    await seed()
    const sql = getDb()
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const drain = async () => {
      await sql`UPDATE provisioning_member_ops SET status = 'ok' WHERE user_keycloak_id = ${SUBJECT}`
    }
    const res = await createIdentityErasureHook({ drain }).erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/0 ops queued.*Keycloak account/) })
  })

  it('a throwing drain leaves the ops queued and the step skipped (never failed-open to erased)', async () => {
    await seed()
    const sql = getDb()
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const res = await createIdentityErasureHook({ drain: async () => { throw new Error('kc down') } })
      .erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/2 ops queued/) })
  })
})

describe('HIGH-2: tenures and governance memberships are kept pseudonymised (RC-IDT-TENURE)', () => {
  it('copies every live role_assignments row of the subject into role_assignment_history with no subject id', async () => {
    const { unitId } = await seed()
    const sql = getDb()
    const [role] = await sql<{ id: string }[]>`SELECT id FROM committee_roles WHERE org_unit_id = ${unitId}`
    await sql`INSERT INTO role_assignments (role_id, user_keycloak_id, start_date, end_date, status, assigned_by_keycloak_id) VALUES
                (${role.id}, ${SUBJECT}, '2024-01-01', '2024-12-31', 'expired', ${OTHER}),
                (${role.id}, ${SUBJECT}, '2023-01-01', NULL, 'vacated', ${OTHER}),
                (${role.id}, ${SUBJECT}, '2025-01-01', '2025-12-31', 'grace', ${OTHER})`
    const before = await sql`SELECT 1 FROM role_assignment_history`
    const res = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'erased', counts: { role_assignments: 4, role_assignment_history_archived: 4 } })
    const hist = await sql<{ user_keycloak_id: string | null; start_date: string; ended_reason: string }[]>`
      SELECT user_keycloak_id, to_char(start_date, 'YYYY-MM-DD') AS start_date, ended_reason
      FROM role_assignment_history WHERE user_keycloak_id IS NULL ORDER BY start_date`
    expect(hist.map((h) => [h.start_date, h.ended_reason])).toEqual([
      ['2023-01-01', 'removed'],
      ['2024-01-01', 'expired'],
      ['2025-01-01', 'expired'], // the seeded history row (pseudonymised in place)
      ['2025-01-01', 'expired'], // the grace assignment
      ['2026-01-01', 'removed'], // the current assignment, ended by the erasure
    ])
    expect((await sql`SELECT 1 FROM role_assignment_history`).length).toBe(before.length + 4)
  })

  it('records an elected membership and a caucus seat pseudonymised; an unelected one is just deleted', async () => {
    const { unitId } = await seed()
    const sql = getDb()
    await sql`UPDATE org_unit_members SET membership_type = 'elected', term_start = '2026-01-01', term_end = '2026-12-31'
              WHERE user_keycloak_id = ${SUBJECT}`
    const [helper] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('AK', 'committee') RETURNING id`
    await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id, membership_type) VALUES (${helper.id}, ${SUBJECT}, 'unelected')`
    const [caucus] = await sql<{ id: string }[]>`INSERT INTO caucus (council_org_unit_id, name) VALUES (${unitId}, 'Liste A') RETURNING id`
    await sql`INSERT INTO caucus_membership (caucus_id, council_org_unit_id, user_keycloak_id, term_start)
              VALUES (${caucus.id}, ${unitId}, ${SUBJECT}, '2026-01-01')`

    const res = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(res).toMatchObject({ status: 'erased', counts: { org_unit_members: 2, caucus_membership: 1, governance_membership_record: 2 } })
    // the live rows are gone (so the reconcile worker cannot re-add anyone) ...
    expect(await sql`SELECT 1 FROM org_unit_members WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM caucus_membership WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    // ... and the governance record survives without the person
    const rec = await sql<{ source: string; org_unit_id: string; caucus_id: string | null; membership_type: string | null; term_end: string | null }[]>`
      SELECT source, org_unit_id, caucus_id, membership_type, to_char(term_end, 'YYYY-MM-DD') AS term_end
      FROM governance_membership_record ORDER BY source`
    expect(rec).toEqual([
      { source: 'caucus_membership', org_unit_id: unitId, caucus_id: caucus.id, membership_type: null, term_end: null },
      { source: 'org_unit_members', org_unit_id: unitId, caucus_id: null, membership_type: 'elected', term_end: '2026-12-31' },
    ])
    const all = await sql`SELECT to_jsonb(r) AS j FROM governance_membership_record r`
    expect(JSON.stringify(all)).not.toContain(SUBJECT)
  })

  it('is idempotent: a re-run records nothing twice', async () => {
    await seed()
    const sql = getDb()
    await sql`UPDATE org_unit_members SET membership_type = 'elected' WHERE user_keycloak_id = ${SUBJECT}`
    await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    const again = await kernelErasureHook.erase({ tenantId: TENANT_A, subjectId: SUBJECT, db: sql })
    expect(again).toMatchObject({ counts: { governance_membership_record: 0, role_assignment_history_archived: 0 } })
    expect(await sql`SELECT 1 FROM governance_membership_record`).toHaveLength(1)
  })
})

describe('full run: kernel + calendar, one module connection removed', () => {
  function deps(noConnection: string[]): ErasureDeps {
    const sql = getDb()
    const calendar: ModuleErasureHook<typeof sql> = {
      moduleId: 'calendar',
      async erase({ db, subjectId }) {
        const r = await db!`UPDATE calendar_events SET created_by = 'erased' WHERE created_by = ${subjectId}`
        return { status: 'erased', counts: { calendar_events: r.count } }
      },
    }
    const hooks = new Map<string, KernelErasureHook>([
      ['kernel', kernelErasureHook],
      ['calendar', calendar],
    ])
    return {
      enabledModuleIds: () => ['kernel', 'calendar'],
      hookFor: (id) => hooks.get(id),
      connectionFor: (id) => (noConnection.includes(id) ? null : sql),
      store: createPgReportStore(sql),
      now: () => new Date(),
    }
  }

  it('all erased -> complete, persisted per module', async () => {
    await seed()
    const report = await runErasure({ tenantId: TENANT_A, subjectId: SUBJECT, requestedBy: 'admin' }, deps([]))
    expect(report.status).toBe('complete')
    const stored = await getErasureReport(getDb(), TENANT_A, report.id)
    expect(stored?.status).toBe('complete')
    expect(stored?.modules.map((m) => [m.moduleId, m.status])).toEqual([['kernel', 'erased'], ['calendar', 'erased']])
    expect(stored?.modules[1].counts).toEqual({ calendar_events: 1 })
    expect(stored?.subjectRef).toBe(subjectRef(TENANT_A, SUBJECT))
  })

  it('calendar connection removed -> calendar skipped (data untouched), report incomplete, persisted so', async () => {
    await seed()
    const report = await runErasure({ tenantId: TENANT_A, subjectId: SUBJECT, requestedBy: 'admin' }, deps(['calendar']))
    expect(report.status).toBe('incomplete')
    const stored = await getErasureReport(getDb(), TENANT_A, report.id)
    expect(stored?.status).toBe('incomplete')
    expect(stored?.modules.find((m) => m.moduleId === 'calendar')).toMatchObject({ status: 'skipped', reason: 'no database connection' })
    expect(await getDb()`SELECT 1 FROM calendar_events WHERE created_by = ${SUBJECT}`).toHaveLength(1)
  })

  it('the stored report never contains the raw subject id', async () => {
    await seed()
    const report = await runErasure({ tenantId: TENANT_A, subjectId: SUBJECT, requestedBy: 'admin' }, deps([]))
    const rows = await getDb()`SELECT to_jsonb(r) AS j FROM erasure_report r UNION ALL SELECT to_jsonb(m) FROM erasure_report_module m`
    expect(JSON.stringify(rows)).not.toContain(SUBJECT)
    expect(report.id).toBeTruthy()
  })
})

describe('the database itself refuses a dishonest "complete"', () => {
  it('rejects complete over a skipped module, and over no modules at all', async () => {
    const sql = getDb()
    const store = createPgReportStore(sql)
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: subjectRef(TENANT_A, SUBJECT), requestedBy: 'a', startedAt: new Date(), moduleIds: ['x'] })
    await expect(store.finish(id, 'complete', new Date())).rejects.toThrow(/cannot be complete/)
    await store.record(id, { moduleId: 'x', status: 'skipped', counts: {}, reason: 'no database connection' })
    await expect(store.finish(id, 'complete', new Date())).rejects.toThrow(/cannot be complete/)
    await store.finish(id, 'incomplete', new Date())
    expect((await getErasureReport(sql, TENANT_A, id))?.status).toBe('incomplete')
  })

  it('rejects a non-erased module row without a reason', async () => {
    const sql = getDb()
    const store = createPgReportStore(sql)
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: subjectRef(TENANT_A, SUBJECT), requestedBy: 'a', startedAt: new Date(), moduleIds: ['x'] })
    await expect(store.record(id, { moduleId: 'x', status: 'skipped', counts: {}, reason: null })).rejects.toThrow()
  })
})

describe('MED-1: the report tables are tamper-resistant at the database', () => {
  const ref = () => subjectRef(TENANT_A, SUBJECT)
  const erased = (moduleId: string) => ({ moduleId, status: 'erased' as const, counts: {}, reason: null })

  it('persists the expected module set on the header', async () => {
    const sql = getDb()
    const id = await createPgReportStore(sql).begin({ tenantId: TENANT_A, subjectRef: ref(), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel', 'calendar'] })
    const [row] = await sql<{ expected_modules: string[] }[]>`SELECT expected_modules FROM erasure_report WHERE id = ${id}`
    expect(row.expected_modules).toEqual(['kernel', 'calendar'])
  })

  it('complete needs a row for EVERY expected module, all erased', async () => {
    const store = createPgReportStore(getDb())
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: ref(), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel', 'calendar'] })
    await store.record(id, erased('kernel'))
    await expect(store.finish(id, 'complete', new Date())).rejects.toThrow(/cannot be complete/)
    await store.record(id, erased('calendar'))
    await store.finish(id, 'complete', new Date())
    expect((await getErasureReport(getDb(), TENANT_A, id))?.status).toBe('complete')
  })

  it('refuses a module row for a module that was not expected', async () => {
    const store = createPgReportStore(getDb())
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: ref(), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel'] })
    await expect(store.record(id, erased('calendar'))).rejects.toThrow(/not an expected module/)
  })

  it('a header cannot be inserted already finished', async () => {
    const sql = getDb()
    await expect(sql`INSERT INTO erasure_report (tenant_id, subject_ref, requested_by, status, finished_at, expected_modules)
                     VALUES (${TENANT_A}, ${ref()}, 'a', 'complete', now(), '{}')`).rejects.toThrow()
  })

  it('a finished report is append-only: no module insert/update/delete, no header update/delete', async () => {
    const sql = getDb()
    const store = createPgReportStore(sql)
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: ref(), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel', 'calendar'] })
    await store.record(id, erased('kernel'))
    await store.finish(id, 'incomplete', new Date())
    await expect(store.record(id, erased('calendar'))).rejects.toThrow(/finished/)
    await expect(sql`UPDATE erasure_report_module SET status = 'erased', counts = '{"x":1}' WHERE report_id = ${id}`).rejects.toThrow(/finished/)
    await expect(sql`DELETE FROM erasure_report_module WHERE report_id = ${id}`).rejects.toThrow(/finished/)
    await expect(sql`UPDATE erasure_report SET status = 'complete' WHERE id = ${id}`).rejects.toThrow(/finished/)
    await expect(sql`UPDATE erasure_report SET requested_by = 'x' WHERE id = ${id}`).rejects.toThrow(/finished/)
    await expect(sql`DELETE FROM erasure_report WHERE id = ${id}`).rejects.toThrow(/finished/)
    expect((await getErasureReport(sql, TENANT_A, id))?.modules).toHaveLength(1)
  })

  it('a running header cannot have its identity columns rewritten', async () => {
    const sql = getDb()
    const id = await createPgReportStore(sql).begin({ tenantId: TENANT_A, subjectRef: ref(), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel'] })
    await expect(sql`UPDATE erasure_report SET expected_modules = '{}' WHERE id = ${id}`).rejects.toThrow(/immutable/)
    await expect(sql`UPDATE erasure_report SET subject_ref = ${'b'.repeat(64)} WHERE id = ${id}`).rejects.toThrow(/immutable/)
  })
})

describe('tenant isolation of reports', () => {
  it('tenant B cannot read or list tenant A reports', async () => {
    const sql = getDb()
    const store = createPgReportStore(sql)
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: subjectRef(TENANT_A, SUBJECT), requestedBy: 'a', startedAt: new Date(), moduleIds: ['kernel'] })
    await store.record(id, { moduleId: 'kernel', status: 'erased', counts: { n: 1 }, reason: null })
    await store.finish(id, 'complete', new Date())

    expect(await getErasureReport(sql, TENANT_B, id)).toBeNull()
    expect(await listErasureReports(sql, TENANT_B)).toEqual([])
    expect(await listErasureReports(sql, TENANT_B, { subjectRef: subjectRef(TENANT_A, SUBJECT) })).toEqual([])
    expect((await listErasureReports(sql, TENANT_A)).map((r) => r.id)).toEqual([id])
    // the same person in another tenant hashes differently
    expect(subjectRef(TENANT_B, SUBJECT)).not.toBe(subjectRef(TENANT_A, SUBJECT))
  })
})
