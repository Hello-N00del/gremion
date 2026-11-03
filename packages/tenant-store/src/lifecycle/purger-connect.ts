// packages/tenant-store/src/lifecycle/purger-connect.ts
//
// Kernel issue #89: create-time provisioning that a later release extends is never re-applied to
// customers created earlier. The purge run LOGS IN to each customer's kernel database as that
// customer's purger role (purge.ts openPurgerSession), so the purger needs CONNECT on the database.
// ensureKernelDatabase grants it at create time (kernel.ts); the older release made the role but not
// the grant, because its purge run did not log in as the purger. A customer created then fails every
// scheduled purge with `permission denied for database "t_<hex>__kernel"` until the grant arrives, and
// no upgrade step re-ran ensureKernelDatabase.
//
// This is that one grant, on its own, as an idempotent re-ensure: `reconcile` reports it (verify) and
// re-applies it (apply). It does NOT call ensureKernelDatabase, which would rewrite the app role's
// password (the verb has no business holding it). It never creates a role: a customer without a purger
// role has no kernel database provisioned at all, which is a different repair.
//
// The same gap holds for the other two things the purge needs of the purger: USAGE on schema public and
// SELECT + DELETE on the purge tables (purge.ts ensureKernelPurgeGrants, run at create time only). The
// release that left no CONNECT left those too, so ensureKernelPurgerAccess re-ensures all three and
// kernelPurgerAccessProblems reads all three; the CONNECT-only pair stays for the narrow case.
//
// AS WHOM: the kernel server's admin. The CONNECT half runs on the maintenance database, where there is no
// customer-controlled search_path to guard. The schema and table half runs inside the customer's database
// through purge.ts (asAdminIn: search_path pinned to pg_catalog first, so no name resolves to an object the
// customer's owner planted). Every identifier is spliced by the SERVER (ddl.ts execFormatted); every
// catalogue function is schema-qualified.
import { execFormatted } from './ddl.js'
import { kernelDbName, kernelRoles } from './kernel.js'
import { ensureKernelPurgeGrants, kernelPurgeGrantProblems } from './purge.js'
import type { ModuleServer } from './types.js'

/** What the effective state is, read from the catalogue (so a grant through PUBLIC counts): [] = the purger can CONNECT. */
export async function kernelPurgerConnectProblems(server: ModuleServer, tenantId: string): Promise<string[]> {
  const { purger } = kernelRoles(tenantId)
  const dbName = kernelDbName(tenantId)
  const [role] = await server.admin<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) ${purger}) AS present`
  if (!role?.present) return [`the purger role ${purger} does not exist (the kernel database of this customer was never provisioned)`]
  const [db] = await server.admin<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) ${dbName}) AS present`
  if (!db?.present) return [`the kernel database ${dbName} does not exist`]
  const [held] = await server.admin<{ held: boolean }[]>`
    SELECT pg_catalog.has_database_privilege(${purger}::pg_catalog.text, ${dbName}::pg_catalog.text, 'CONNECT') AS held`
  return held?.held ? [] : [`the purger role ${purger} lacks CONNECT on ${dbName} (the scheduled purge logs in as it and fails: permission denied for database)`]
}

/**
 * Grants the purger CONNECT on the customer's kernel database (exactly CONNECT, never TEMPORARY or
 * CREATE) and reads it back. Idempotent: `granted` is true only when this call found it missing.
 * Throws when the role or the database is absent (nothing to repair here) or the grant did not take.
 */
export async function ensureKernelPurgerConnect(server: ModuleServer, tenantId: string): Promise<{ granted: boolean }> {
  const { purger } = kernelRoles(tenantId)
  const dbName = kernelDbName(tenantId)
  const before = await kernelPurgerConnectProblems(server, tenantId)
  if (before.length === 0) return { granted: false }
  if (before.some((p) => p.includes('does not exist'))) throw new Error(before.join('; '))
  await execFormatted(server.admin, 'GRANT CONNECT ON DATABASE %I TO %I', [dbName, purger])
  const after = await kernelPurgerConnectProblems(server, tenantId)
  if (after.length) throw new Error(`the purger CONNECT grant on ${dbName} did not take: ${after.join('; ')}`)
  return { granted: true }
}

/**
 * Everything the scheduled purge needs of the purger on a customer's kernel database, as one post-condition:
 * CONNECT (above), USAGE on schema public and SELECT + DELETE on the purge tables. The release a customer was
 * created on may predate ALL of these (it had no purge run that logs in), and the create-time path that grants
 * the last two (ensureKernelPurgeGrants) is not re-run by any upgrade step, so CONNECT alone turns the purge
 * from "permission denied for database" into "refused: the purger lacks SELECT, DELETE" (kernel issue #89).
 * [] = the purge can run. A customer without a role or database has nothing to read here (that problem alone).
 */
export async function kernelPurgerAccessProblems(server: ModuleServer, tenantId: string): Promise<string[]> {
  const connect = await kernelPurgerConnectProblems(server, tenantId)
  if (connect.some((p) => p.includes('does not exist'))) return connect
  return [...connect, ...(await kernelPurgeGrantProblems(server, tenantId))]
}

/**
 * Re-ensures all of it, idempotently: CONNECT (ensureKernelPurgerConnect), then USAGE and the per-table grants
 * (ensureKernelPurgeGrants, the same function the create path runs), and reads the whole post-condition back.
 * `repaired` is true only when this call found something missing. Throws when the role or database is absent
 * or a grant did not take.
 */
export async function ensureKernelPurgerAccess(server: ModuleServer, tenantId: string): Promise<{ repaired: boolean }> {
  const before = await kernelPurgerAccessProblems(server, tenantId)
  if (before.length === 0) return { repaired: false }
  if (before.some((p) => p.includes('does not exist'))) throw new Error(before.join('; '))
  await ensureKernelPurgerConnect(server, tenantId)
  await ensureKernelPurgeGrants(server, tenantId)
  const after = await kernelPurgerAccessProblems(server, tenantId)
  if (after.length) throw new Error(`the purger grants on ${kernelDbName(tenantId)} did not take: ${after.join('; ')}`)
  return { repaired: true }
}
