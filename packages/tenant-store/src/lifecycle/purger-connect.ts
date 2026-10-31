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
// AS WHOM: the kernel server's admin on the server's maintenance database; no statement runs inside the
// customer's database, so there is no customer-controlled search_path to guard. Every identifier is
// spliced by the SERVER (ddl.ts execFormatted); every catalogue function is schema-qualified.
import { execFormatted } from './ddl.js'
import { kernelDbName, kernelRoles } from './kernel.js'
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
