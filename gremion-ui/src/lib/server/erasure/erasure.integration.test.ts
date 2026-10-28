// TRD-196 / PRD-OPS-005 — DB-backed proof of the erasure seam against the real
// schema (migration 0060 + the kernel tables): the kernel hook really deletes /
// pseudonymises the subject's rows, the report round-trips per module, the DB
// itself refuses a `complete` header over a non-erased module, and one tenant
// cannot read another tenant's reports.
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { kernelErasureHook } from './kernel-hook'
import { runErasure, subjectRef, type ErasureDeps } from './orchestrator'
import { createPgReportStore, getErasureReport, listErasureReports } from './report-store'

const TENANT_A = '01920000-0000-7000-8000-00000000aaaa'
const TENANT_B = '01920000-0000-7000-8000-00000000bbbb'
const SUBJECT = 'kc-subject-erasure-1'
const OTHER = 'kc-other-person'

async function seed() {
  const sql = getDb()
  const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('Erasure-Gremium', 'committee') RETURNING id`
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
}

beforeEach(async () => {
  const sql = getDb()
  await sql`TRUNCATE erasure_report, org_units, calendar_events, notification_read_marker, role_assignment_history CASCADE`
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
    expect(await sql`SELECT 1 FROM role_assignment_history WHERE user_keycloak_id IS NULL`).toHaveLength(1)
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

describe('tenant isolation of reports', () => {
  it('tenant B cannot read or list tenant A reports', async () => {
    const sql = getDb()
    const store = createPgReportStore(sql)
    const id = await store.begin({ tenantId: TENANT_A, subjectRef: subjectRef(TENANT_A, SUBJECT), requestedBy: 'a', startedAt: new Date(), moduleIds: [] })
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
