// packages/tenant-store/src/lifecycle/guards.ts
//
// The names the lifecycle may touch, checked before every statement that
// creates, connects to or drops a database. Every identifier the lifecycle
// puts into DDL comes from here (validated) and is then quoted by the SERVER
// (format('%I')), never concatenated into SQL text.
import { assertModuleId, assertTenantId, tenantModuleDbName } from '../names.js'

/** A (tenant, module) database: t_<tenant uuid as 32 hex>__<module id>. */
export const TENANT_MODULE_DB = /^t_[0-9a-f]{32}__[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/** Module ids the lifecycle refuses: `kernel` names the customer's kernel database, never a module's. */
export const RESERVED_MODULE_IDS: ReadonlySet<string> = new Set(['kernel'])

/** The legacy and platform databases the lifecycle never opens (test 12). */
export const NEVER_OPENED: ReadonlySet<string> = new Set(['control', 'gremion', 'keycloak', 'postgres', 'template0', 'template1'])

export type LifecycleErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_PLATFORM'
  | 'MODULE_UNKNOWN'
  | 'MODULE_VERSION_UNKNOWN'
  | 'GATE_REFUSED'
  | 'DISABLE_IN_PROGRESS'
  | 'CONCURRENT_STATE'
  | 'DATABASE_MISSING'
  | 'DATABASE_FOREIGN_OWNER'
  | 'TARGET_REFUSED'
  | 'EXPORT_FAILED'
  | 'EXPORT_UNVERIFIED'

export class LifecycleError extends Error {
  override name = 'LifecycleError'
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** Validates the module id for the lifecycle: names.ts MODULE_ID and not reserved. */
export function assertLifecycleModuleId(moduleId: string): void {
  try {
    assertModuleId(moduleId)
  } catch (err) {
    throw new LifecycleError('INVALID_INPUT', (err as Error).message, { cause: err })
  }
  if (RESERVED_MODULE_IDS.has(moduleId)) throw new LifecycleError('INVALID_INPUT', `module id ${moduleId} is reserved (the customer's kernel database), not a module`)
}

export function assertLifecycleTenantId(tenantId: string): void {
  try {
    assertTenantId(tenantId)
  } catch (err) {
    throw new LifecycleError('INVALID_INPUT', (err as Error).message, { cause: err })
  }
}

/** The owner (NOLOGIN) and app (LOGIN) roles of one module on its server (Q4). */
export function moduleRoles(moduleId: string): { owner: string; app: string } {
  assertLifecycleModuleId(moduleId)
  return { owner: `m_${moduleId}`, app: `m_${moduleId}_app` }
}

/**
 * The one database the lifecycle may create, open, export or drop for
 * (tenant, module): exactly tenantModuleDbName(tenant, module), matching
 * TENANT_MODULE_DB, never the tenant's kernel database, never a platform or
 * legacy name. Returns the name.
 */
export function assertTenantModuleTarget(dbName: string, tenantId: string, moduleId: string): string {
  assertLifecycleTenantId(tenantId)
  assertLifecycleModuleId(moduleId)
  const expected = tenantModuleDbName(tenantId, moduleId)
  if (typeof dbName !== 'string' || !TENANT_MODULE_DB.test(dbName) || NEVER_OPENED.has(dbName)) {
    throw new LifecycleError('TARGET_REFUSED', `refusing database ${JSON.stringify(dbName)}: not a (tenant, module) database name`)
  }
  if (dbName === tenantModuleDbName(tenantId, 'kernel')) {
    throw new LifecycleError('TARGET_REFUSED', `refusing ${dbName}: it is the tenant's kernel database`)
  }
  if (dbName !== expected) throw new LifecycleError('TARGET_REFUSED', `refusing ${dbName}: (${tenantId}, ${moduleId}) owns ${expected}`)
  return dbName
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function assertUuid(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new LifecycleError('INVALID_INPUT', `${what} is not a lowercase RFC 9562 uuid: ${JSON.stringify(value)}`)
}
