// packages/tenant-store/src/lifecycle/block.ts
//
// The Karenz block and its inverse, kept apart from enable.ts and disable.ts because both need both
// (a failed restore re-blocks; a repeated disable re-asserts the block) and neither may import the other.
import type { Sql } from '@gremion/db'
import { execFormatted } from './ddl.js'
import { assertTenantModuleTarget, LifecycleError, moduleRoles } from './guards.js'

/** Nothing but m_<id>_app (and the owner) may connect: PUBLIC loses CONNECT and TEMPORARY. */
export async function lockDownDatabase(admin: Sql, dbName: string, app: string): Promise<void> {
  await execFormatted(admin, 'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', [dbName])
  await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [dbName, app])
}

/** The inverse of the Karenz block: the app role may connect again (PUBLIC stays locked out). */
export async function unblockModuleDatabase(admin: Sql, dbName: string, tenantId: string, moduleId: string, app: string): Promise<void> {
  assertTenantModuleTarget(dbName, tenantId, moduleId)
  if (app !== moduleRoles(moduleId).app) throw new LifecycleError('TARGET_REFUSED', `refusing to unblock ${dbName} for ${JSON.stringify(app)}: ${moduleId}'s app role is ${moduleRoles(moduleId).app}`)
  await lockDownDatabase(admin, dbName, app)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The Karenz block: the module's app role loses CONNECT on the (tenant, module)
 * database and its sessions are terminated; the database, its data and the owner
 * role stay. Proven, not assumed: the function then asserts that the app role
 * cannot connect (has_database_privilege) and that no session of it is left, and
 * throws otherwise. Idempotent. The target is re-asserted at the call.
 */
export async function blockModuleDatabase(admin: Sql, dbName: string, tenantId: string, moduleId: string, app: string): Promise<void> {
  assertTenantModuleTarget(dbName, tenantId, moduleId)
  if (app !== moduleRoles(moduleId).app) throw new LifecycleError('TARGET_REFUSED', `refusing to block ${dbName} for ${JSON.stringify(app)}: ${moduleId}'s app role is ${moduleRoles(moduleId).app}`)
  await execFormatted(admin, 'REVOKE CONNECT ON DATABASE %I FROM %I', [dbName, app])
  // a database that PUBLIC could still connect to would let the app role in through PUBLIC
  await execFormatted(admin, 'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', [dbName])
  let sessions = -1
  for (let attempt = 0; attempt < 50; attempt++) {
    await admin`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = ${dbName} AND usename = ${app} AND pid <> pg_backend_pid()`
    const [left] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${dbName} AND usename = ${app}`
    sessions = left?.n ?? -1
    if (sessions === 0) break
    await sleep(100)
  }
  const [priv] = await admin<{ can: boolean }[]>`SELECT has_database_privilege(${app}, ${dbName}, 'CONNECT') AS can`
  if (priv?.can !== false) throw new LifecycleError('CONCURRENT_STATE', `${app} can still connect to ${dbName} after the block`)
  if (sessions !== 0) throw new LifecycleError('CONCURRENT_STATE', `${app} still has sessions on ${dbName} after the block`)
}
