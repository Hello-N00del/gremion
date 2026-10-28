// TRD-196 — the tenant-DB persistence of the per-module erasure report
// (migration 0060_erasure_report.sql). Every statement is scoped by tenant_id on
// top of the db-per-tenant isolation, so a report id from another tenant reads as
// not found even if a pool were ever shared.
import type { Sql } from '@gremion/db'
import type { ErasureOverallStatus, ModuleErasureOutcome } from '@gremion/ports/erasure'
import type { ErasureReport, ErasureReportStore } from './orchestrator'

interface HeaderRow {
  id: string
  tenant_id: string
  subject_ref: string
  requested_by: string
  status: ErasureOverallStatus
  started_at: Date
  finished_at: Date | null
}

interface ModuleRow {
  report_id: string
  module_id: string
  status: ModuleErasureOutcome['status']
  counts: Record<string, number>
  reason: string | null
}

export function createPgReportStore(sql: Sql): ErasureReportStore {
  return {
    async begin(h) {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO erasure_report (tenant_id, subject_ref, requested_by, status, started_at, expected_modules)
        VALUES (${h.tenantId}, ${h.subjectRef}, ${h.requestedBy}, 'running', ${h.startedAt}, ${sql.array([...h.moduleIds])}::text[])
        RETURNING id`
      return rows[0].id
    },
    async record(reportId, o) {
      await sql`
        INSERT INTO erasure_report_module (report_id, module_id, position, status, counts, reason)
        VALUES (
          ${reportId}, ${o.moduleId},
          (SELECT count(*)::int FROM erasure_report_module WHERE report_id = ${reportId}),
          ${o.status}, ${sql.json({ ...o.counts })}, ${o.reason})`
    },
    async finish(reportId, status, finishedAt) {
      // The DB trigger refuses `complete` unless every expected module has an `erased`
      // row, and refuses any change once the header is finished (append-only).
      await sql`
        UPDATE erasure_report SET status = ${status}, finished_at = ${finishedAt}
        WHERE id = ${reportId}`
    },
  }
}

function assemble(h: HeaderRow, mods: ModuleRow[]): ErasureReport {
  return {
    id: h.id,
    tenantId: h.tenant_id,
    subjectRef: h.subject_ref,
    requestedBy: h.requested_by,
    status: h.status,
    startedAt: h.started_at,
    finishedAt: h.finished_at,
    modules: mods
      .filter((m) => m.report_id === h.id)
      .map((m) => ({ moduleId: m.module_id, status: m.status, counts: m.counts, reason: m.reason })),
  }
}

async function modulesOf(sql: Sql, ids: string[]): Promise<ModuleRow[]> {
  if (ids.length === 0) return []
  return sql<ModuleRow[]>`
    SELECT report_id, module_id, status, counts, reason
    FROM erasure_report_module WHERE report_id IN ${sql(ids)}
    ORDER BY report_id, position`
}

export async function getErasureReport(sql: Sql, tenantId: string, id: string): Promise<ErasureReport | null> {
  const rows = await sql<HeaderRow[]>`
    SELECT id, tenant_id, subject_ref, requested_by, status, started_at, finished_at
    FROM erasure_report WHERE tenant_id = ${tenantId} AND id = ${id}`
  if (rows.length === 0) return null
  return assemble(rows[0], await modulesOf(sql, [rows[0].id]))
}

export async function listErasureReports(
  sql: Sql,
  tenantId: string,
  opts: { subjectRef?: string; limit?: number } = {},
): Promise<ErasureReport[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await sql<HeaderRow[]>`
    SELECT id, tenant_id, subject_ref, requested_by, status, started_at, finished_at
    FROM erasure_report
    WHERE tenant_id = ${tenantId}
      ${opts.subjectRef ? sql`AND subject_ref = ${opts.subjectRef}` : sql``}
    ORDER BY started_at DESC, id DESC
    LIMIT ${limit}`
  const mods = await modulesOf(sql, rows.map((r) => r.id))
  return rows.map((r) => assemble(r, mods))
}
