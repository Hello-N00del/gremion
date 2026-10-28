import { getDb } from './db'
import { getRunner, type PgTransaction } from '$lib/server/db/tx'

export interface AuditEntry {
  userId: string
  field: string
  oldValue: string | null
  newValue: string
}

export interface AuditRecord extends AuditEntry {
  id: number
  createdAt: Date
}

/**
 * Append one row to the hash-chained audit_log (INV-1). The row's prev_hash /
 * row_hash are set by the BEFORE INSERT trigger (migration 043), so callers
 * only supply the payload.
 *
 * Pass `tx` to run the INSERT on the caller's transaction. This is REQUIRED
 * when the audited act is itself persisted in a transaction (e.g. #320
 * resolution adoption at publish): the audit row and the act must commit or
 * roll back together, or a rolled-back act would leave an orphan audit entry
 * (and vice-versa). Omitting `tx` uses the tenant pool (auto-commit) —
 * correct for standalone audited acts.
 */
export async function writeAuditEntry(entry: AuditEntry, tx?: PgTransaction): Promise<void> {
  const sql = getRunner(tx, getDb)
  await sql`
    INSERT INTO audit_log (user_id, field, old_value, new_value)
    VALUES (${entry.userId}, ${entry.field}, ${entry.oldValue ?? null}, ${entry.newValue})
  `
}

/**
 * Governance Core INV-1: verify the audit_log hash chain is intact.
 * Delegates to the in-DB verifier (migrations 0043, 0059) so hashing is
 * identical to the writer trigger; the walk starts at the retention purge's
 * anchor. Returns the id of the first broken row, or ok when intact.
 */
export async function verifyAuditChain(): Promise<{ ok: true } | { ok: false; brokenAtId: number }> {
  const sql = getDb()
  const rows = await sql<{ broken: string | null }[]>`SELECT audit_log_verify_chain() AS broken`
  const broken = rows[0]?.broken
  return broken == null ? { ok: true } : { ok: false, brokenAtId: Number(broken) }
}

export async function readAuditLog(field?: string, limit = 50): Promise<AuditRecord[]> {
  const sql = getDb()
  const rows = field
    ? await sql<AuditRecord[]>`
        SELECT id, created_at AS "createdAt", user_id AS "userId", field, old_value AS "oldValue", new_value AS "newValue"
        FROM audit_log WHERE field = ${field}
        ORDER BY created_at DESC LIMIT ${limit}
      `
    : await sql<AuditRecord[]>`
        SELECT id, created_at AS "createdAt", user_id AS "userId", field, old_value AS "oldValue", new_value AS "newValue"
        FROM audit_log
        ORDER BY created_at DESC LIMIT ${limit}
      `
  return rows
}
