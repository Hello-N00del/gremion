// packages/tenant-store/src/lifecycle/audit-append-only.ts
//
// TASK-033-a: the kernel audit_log is a GOVERNANCE RECORD (RC-GOV-CHAIN in
// docs/compliance/retention-catalogue.md; operator decision 2026-10-28). It is
// append-only for the application: the app role, the owner role it is a member
// of, and PUBLIC hold no DELETE, UPDATE or TRUNCATE on it, and no timer purges it
// (PURGE_RULES has no audit_log rule, by design and by purge.test.ts). The chain
// anchor beside it (0059) is read-only for the same roles: nothing moves it now
// that no purge runs, and a writable anchor is a way to forge the chain's start.
//
// AS WHOM and HOW: the same hardened admin path as ensureKernelPurgeGrants:
// the kernel server's admin (a superuser) opens the customer database, every
// statement runs in a transaction whose first statement pins search_path to
// pg_catalog (kernel.ts asAdminIn), every identifier is spliced by the SERVER
// (format('%I'), ddl.ts execFormatted), every table name is schema-qualified.
// A REVOKE fires no tenant code, and no name here resolves to an object the
// customer's owner planted (ALTER DATABASE SET search_path + a public.format).
//
// WHEN: at provisioning (customer-adapters migrate, after the kernel chain
// created the tables) and on `reconcile` (the apply mode re-asserts it; the
// verify mode reports it). NOT daily: the boot fleet migrates every tenant as the
// app role, which cannot grant or revoke, and a new table or a grant made by a
// later migration is caught by the next reconcile.
//
// HONEST LIMIT: until TASK-192 the app role is a member of the owner role, and the
// owner can GRANT itself a privilege back. This is a speed bump against a
// bug or a stray statement in the application, not isolation from a tenant that
// runs arbitrary SQL as its own owner; the purge-time defence (the purger refuses
// foreign triggers and so on) is a separate layer.
import { execFormatted } from './ddl.js'
import { asAdminIn, kernelDbName, kernelRoles } from './kernel.js'
import type { ModuleServer } from './types.js'

export interface AppendOnlyTable {
  /** `name` in the public schema (a plain identifier, spliced into the statement text). */
  readonly table: string
  /** The privileges the app, the owner and PUBLIC must NOT hold. */
  readonly revoke: readonly ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[]
}

/** audit_log and its chain anchor (gremion-ui migrations 0009, 0043, 0059). SELECT and INSERT on audit_log stay. */
export const APPEND_ONLY_TABLES: readonly AppendOnlyTable[] = [
  { table: 'audit_log', revoke: ['DELETE', 'UPDATE', 'TRUNCATE'] },
  { table: 'audit_log_chain_anchor', revoke: ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] },
]

const PLAIN = /^[a-z_]+$/

/**
 * REVOKEs the privileges of APPEND_ONLY_TABLES from PUBLIC, the app role and the
 * owner role in the customer's kernel database. Idempotent. A table the kernel
 * chain has not created yet is returned in `absent` (the next call picks it up).
 */
export async function ensureKernelAuditAppendOnly(server: ModuleServer, tenantId: string): Promise<{ revoked: string[]; absent: string[] }> {
  const { app, owner } = kernelRoles(tenantId)
  const dbName = kernelDbName(tenantId)
  const db = await server.open(dbName)
  const revoked: string[] = []
  const absent: string[] = []
  try {
    await asAdminIn(db, async (tx) => {
      const [who] = await tx<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
      if (who?.db !== dbName) throw new Error(`the admin pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
      for (const t of APPEND_ONLY_TABLES) {
        if (!PLAIN.test(t.table)) throw new RangeError(`table ${JSON.stringify(t.table)} is not a plain identifier`)
        const [present] = await tx<{ ok: boolean }[]>`SELECT pg_catalog.to_regclass(${`public.${t.table}`}::pg_catalog.text) IS NOT NULL AS ok`
        if (!present?.ok) {
          absent.push(t.table)
          continue
        }
        await execFormatted(tx, `REVOKE ${t.revoke.join(', ')} ON TABLE public.${t.table} FROM PUBLIC, %I, %I`, [app, owner])
        revoked.push(t.table)
      }
    })
  } finally {
    await db.end({ timeout: 5 })
  }
  return { revoked, absent }
}

/**
 * The EFFECTIVE state, read from the catalogue by has_table_privilege (so a
 * grant through PUBLIC or through role membership is seen): one line per
 * privilege the app or the owner still holds on an append-only table. [] = the
 * contract holds. A table that does not exist yet is not a problem BY DEFAULT (the
 * chain may not have run); `requirePresent` makes it one, for the callers that run
 * after the chain (provisioning treats an absent table as fatal; reconcile, verify
 * and apply, must report it the same way instead of passing a database that has no
 * audit record to protect).
 */
export async function kernelAuditAppendOnlyProblems(
  server: ModuleServer,
  tenantId: string,
  opts: { requirePresent?: boolean } = {},
): Promise<string[]> {
  const { app, owner } = kernelRoles(tenantId)
  const dbName = kernelDbName(tenantId)
  const db = await server.open(dbName)
  const problems: string[] = []
  try {
    await asAdminIn(db, async (tx) => {
      const [who] = await tx<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
      if (who?.db !== dbName) throw new Error(`the admin pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
      for (const t of APPEND_ONLY_TABLES) {
        if (!PLAIN.test(t.table)) throw new RangeError(`table ${JSON.stringify(t.table)} is not a plain identifier`)
        const qualified = `public.${t.table}`
        const [present] = await tx<{ ok: boolean }[]>`SELECT pg_catalog.to_regclass(${qualified}::pg_catalog.text) IS NOT NULL AS ok`
        if (!present?.ok) {
          if (opts.requirePresent) problems.push(`${t.table}: table is absent (the kernel chain has not created it, so the audit record cannot be append-only)`)
          continue
        }
        for (const role of [app, owner]) {
          for (const priv of t.revoke) {
            const [held] = await tx<{ held: boolean }[]>`
              SELECT pg_catalog.has_table_privilege(${role}::pg_catalog.text, ${qualified}::pg_catalog.text, ${priv}::pg_catalog.text) AS held`
            if (held?.held) problems.push(`${t.table}: ${role} still holds ${priv} (the kernel audit record is append-only)`)
          }
        }
      }
    })
  } finally {
    await db.end({ timeout: 5 })
  }
  return problems
}
