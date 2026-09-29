// packages/tenant-store/src/lifecycle/enable.ts
//
// enableModule(tenant, module, actor, deps): D13, one database per (tenant,
// module), created on enable. Order, and why:
//   1. validate every input; assert the platform connection IS gremion_platform
//   2. plt.module + plt.module_version must know (module, runtime.version)
//   3. the gate (Q3: injected, required, default-deny) — BEFORE anything is
//      written, so a refused gate leaves no database and no state
//   4. plt.module_database -> 'enabling' (visible, resumable state first)
//   5. roles m_<id> (NOLOGIN owner) and m_<id>_app (LOGIN, SCRAM verifier)
//   6. CREATE DATABASE <tenantModuleDbName> OWNER m_<id> (server-quoted %I),
//      REVOKE CONNECT, TEMPORARY FROM PUBLIC, GRANT CONNECT TO m_<id>_app
//   7. runMigrations AS m_<id> (startup role), then default DML for the app
//   8. one platform transaction: module_database 'enabling' -> 'enabled' and
//      module_enablement 'enabled' with the gate references, enabled_by/_at
// Every step is idempotent, so a crash anywhere resumes by calling it again;
// a second enable of an enabled module writes nothing.
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import { tenantModuleDbName } from '../names.js'
import { runMigrations } from '../runner.js'
import { execFormatted, sqlState } from './ddl.js'
import {
  assertLifecycleModuleId,
  assertLifecycleTenantId,
  assertTenantModuleTarget,
  assertUuid,
  LifecycleError,
  moduleRoles,
} from './guards.js'
import { loadBaselinePhaseFor } from '../phase.js'
import { assertPlatform, casModuleDatabaseState, KERNEL_ROOT, lookupModuleVersion, readModuleDatabase } from './platform.js'
import { scramSha256Verifier } from './scram.js'
import type { Actor, EnableResult, GateResult, LifecycleDeps, LifecycleModule, ModuleServer } from './types.js'

export function assertActor(actor: Actor): void {
  if (!actor || (actor.kind !== 'person' && actor.kind !== 'operator')) throw new LifecycleError('INVALID_INPUT', 'actor.kind must be person or operator')
  assertUuid(actor.id, 'actor.id')
}

async function roleExists(admin: Sql, role: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
  return rows.length === 1
}

/** Q4: m_<id> NOLOGIN owner, m_<id>_app LOGIN NOBYPASSRLS; both NOSUPERUSER, created or re-asserted. */
export async function ensureModuleRoles(admin: Sql, moduleId: string, appPassword: string): Promise<{ owner: string; app: string }> {
  const { owner, app } = moduleRoles(moduleId)
  const attrs = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  for (const [role, login] of [[owner, 'NOLOGIN'], [app, 'LOGIN NOINHERIT']] as const) {
    if (!(await roleExists(admin, role))) {
      try {
        await execFormatted(admin, `CREATE ROLE %I ${login} ${attrs}`, [role])
      } catch (err) {
        if (sqlState(err) !== '42710') throw err // a concurrent enable created it
      }
    }
    await execFormatted(admin, `ALTER ROLE %I ${login} ${attrs}`, [role])
  }
  await execFormatted(admin, 'ALTER ROLE %I PASSWORD %L', [app, scramSha256Verifier(appPassword)])
  return { owner, app }
}

async function databaseOwner(admin: Sql, dbName: string): Promise<string | null> {
  const rows = await admin<{ owner: string }[]>`
    SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${dbName}`
  return rows[0]?.owner ?? null
}

/** CREATE DATABASE if absent; refuses a database of that name owned by anyone but m_<id>. */
async function ensureDatabase(admin: Sql, dbName: string, owner: string): Promise<boolean> {
  let current = await databaseOwner(admin, dbName)
  let created = false
  if (current === null) {
    try {
      await execFormatted(admin, 'CREATE DATABASE %I OWNER %I', [dbName, owner])
      created = true
    } catch (err) {
      if (sqlState(err) !== '42P04') throw err // a concurrent enable created it
    }
    current = await databaseOwner(admin, dbName)
  }
  if (current !== owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${dbName} exists but is owned by ${current ?? 'nobody'}, not ${owner}: refusing to adopt a database the lifecycle did not create`)
  }
  return created
}

/** Nothing but m_<id>_app (and the owner) may connect: PUBLIC loses CONNECT and TEMPORARY. */
export async function lockDownDatabase(admin: Sql, dbName: string, app: string): Promise<void> {
  await execFormatted(admin, 'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', [dbName])
  await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [dbName, app])
}

/** DML for the app role on everything the owner has created, and by default on what it creates next. */
async function grantAppPrivileges(owned: Sql, owner: string, app: string): Promise<void> {
  const schemas = await owned<{ nspname: string }[]>`
    SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
     WHERE (r.rolname = ${owner} OR n.nspname = 'public') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
     ORDER BY 1`
  for (const { nspname } of schemas) {
    await execFormatted(owned, 'GRANT USAGE ON SCHEMA %I TO %I', [nspname, app])
    await execFormatted(owned, 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', [nspname, app])
    await execFormatted(owned, 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', [nspname, app])
    await execFormatted(owned, 'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', [owner, nspname, app])
    await execFormatted(owned, 'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', [owner, nspname, app])
  }
  // The runner's ledger is the runner's: the app may read it (schemaGate), never write it.
  const [ledger] = await owned<{ present: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
  if (ledger?.present) {
    await execFormatted(owned, 'REVOKE ALL ON TABLE public.schema_migrations FROM %I', [app])
    await execFormatted(owned, 'GRANT SELECT ON TABLE public.schema_migrations TO %I', [app])
  }
}

/** Opens the (tenant, module) database as the owner and proves where and who it is before anything runs. */
export async function openAsOwner(server: ModuleServer, dbName: string, owner: string): Promise<Sql> {
  const sql = await server.open(dbName, { role: owner })
  try {
    const [who] = await sql<{ db: string; usr: string }[]>`SELECT current_database() AS db, current_user AS usr`
    if (who?.db !== dbName) throw new LifecycleError('TARGET_REFUSED', `the migration pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
    if (who.usr !== owner) throw new LifecycleError('TARGET_REFUSED', `the migration pool runs as ${JSON.stringify(who.usr)}, not the owner ${owner} (startup options=-c role=${owner})`)
    return sql
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {})
    throw err
  }
}

function checkGate(gate: GateResult): void {
  assertUuid(gate.isolationTestResultId, 'enableGate().isolationTestResultId')
  assertUuid(gate.dpiaDecisionId, 'enableGate().dpiaDecisionId')
  if (gate.crossBodyTestResultId !== undefined && gate.crossBodyTestResultId !== null) assertUuid(gate.crossBodyTestResultId, 'enableGate().crossBodyTestResultId')
}

export async function enableModule(tenantId: string, module: LifecycleModule, actor: Actor, deps: LifecycleDeps): Promise<EnableResult> {
  // 1. inputs, then the platform connection
  assertLifecycleTenantId(tenantId)
  const moduleId = module?.id
  assertLifecycleModuleId(moduleId)
  if (module.moduleJson?.id !== moduleId) throw new LifecycleError('INVALID_INPUT', `module.json id ${JSON.stringify(module.moduleJson?.id)} is not ${moduleId}`)
  assertActor(actor)
  if (typeof deps?.enableGate !== 'function') {
    throw new LifecycleError('GATE_REFUSED', 'deps.enableGate is required (default-deny, PRD-PLAT-012): no gate, no enable')
  }
  const log = deps.log ?? (() => {})
  const runtime = module.moduleJson.runtime
  const database = runtime.database
  // TASK-075: every ledger row names its release; refused before anything is written.
  if (database && (typeof deps.releaseRef !== 'string' || deps.releaseRef.length < 1 || deps.releaseRef.length > 64 || /[\u0000-\u001f]/.test(deps.releaseRef))) {
    throw new LifecycleError('INVALID_INPUT', 'deps.releaseRef (the release this enable ships, 1-64 printable characters) is required for a module with a database')
  }
  await assertPlatform(deps.platform)

  // 2. the catalogue must know this module version
  const mv = await lookupModuleVersion(deps.platform, moduleId, runtime.version)
  if (!mv) throw new LifecycleError('MODULE_VERSION_UNKNOWN', `plt.module_version has no (${moduleId}, ${runtime.version}); the registry (TASK-077) loads it before an enable`)

  // 3. the gate, before anything is written
  const gate = await deps.enableGate(tenantId, moduleId)
  if (!gate) throw new LifecycleError('GATE_REFUSED', `the enable gate refused (${tenantId}, ${moduleId}): no isolation-test or DPIA reference`)
  checkGate(gate)

  const key = { customerId: tenantId, moduleId: mv.moduleId }
  const hook = async (step: Parameters<NonNullable<NonNullable<LifecycleDeps['hooks']>['afterStep']>>[0], db: string | null) =>
    deps.hooks?.afterStep?.(step, { tenantId, moduleId, database: db })

  let dbName: string | null = null
  let created = false
  let applied: string[] = []
  if (database) {
    dbName = assertTenantModuleTarget(tenantModuleDbName(tenantId, moduleId), tenantId, moduleId)
    // 4. visible, resumable state first
    await deps.platform`
      INSERT INTO plt.module_database (customer_id, module_id, db_name, state)
      VALUES (${tenantId}, ${mv.moduleId}, ${dbName}, 'enabling')
      ON CONFLICT (customer_id, module_id) DO NOTHING`
    const row = await readModuleDatabase(deps.platform, tenantId, mv.moduleId)
    if (!row) throw new LifecycleError('CONCURRENT_STATE', `plt.module_database row for ${dbName} vanished`)
    if (row.dbName !== dbName) throw new LifecycleError('TARGET_REFUSED', `plt.module_database names ${row.dbName} for (${tenantId}, ${moduleId}), expected ${dbName}`)
    if (row.state === 'disabling') throw new LifecycleError('DISABLE_IN_PROGRESS', `${dbName} is being disabled; finish disableModule first`)
    if (row.state === 'dropped' && !(await casModuleDatabaseState(deps.platform, key, ['dropped'], 'enabling'))) {
      throw new LifecycleError('CONCURRENT_STATE', `${dbName} left 'dropped' concurrently`)
    }
    const server = deps.server(database.postgresService)
    if (row.state === 'enabled') {
      if ((await databaseOwner(server.admin, dbName)) === null) {
        throw new LifecycleError('DATABASE_MISSING', `plt.module_database says ${dbName} is enabled but the server has no such database`)
      }
      const [en] = await deps.platform<{ state: string }[]>`
        SELECT state FROM plt.module_enablement WHERE customer_id = ${tenantId} AND module_id = ${mv.moduleId}`
      if (en?.state === 'enabled') {
        log(`(${tenantId}, ${moduleId}) is already enabled: nothing to do`)
        return { tenantId, moduleId, database: dbName, created: false, applied: [], noop: true }
      }
    } else {
      await hook('enabling', dbName)
      // 5. roles
      const { owner, app } = await ensureModuleRoles(server.admin, moduleId, await deps.secrets.appPassword(moduleId))
      await hook('roles', dbName)
      // 6. the database
      created = await ensureDatabase(server.admin, dbName, owner)
      await lockDownDatabase(server.admin, dbName, app)
      await hook('created', dbName)
      // 7. migrations as the owner
      const owned = await openAsOwner(server, dbName, owner)
      try {
        // TASK-075 G1b: a database this call created has nothing to lose, so
        // no pre-migration dump; an existing one (upgrade, resumed enable)
        // runs under deps.upgradeHooks (the dump hook).
        const phaseFor = deps.phaseFor ? deps.phaseFor(moduleId) : loadBaselinePhaseFor(`module-${moduleId}`, KERNEL_ROOT)
        const hooks = created ? undefined : deps.upgradeHooks
        const r = await runMigrations({
          sql: owned,
          dir: join(module.dir, database.migrations),
          releaseRef: deps.releaseRef as string,
          ...(phaseFor ? { phaseFor } : {}),
          ...(hooks ? { hooks } : {}),
          log,
        })
        applied = r.applied
        await grantAppPrivileges(owned, owner, app)
      } finally {
        await owned.end({ timeout: 5 })
      }
      await hook('migrated', dbName)
    }
  }

  // 8. one platform transaction: the database row and the level-1 switch
  await deps.platform.begin(async (tx) => {
    if (dbName !== null) {
      const [st] = await tx<{ state: string }[]>`
        SELECT state FROM plt.module_database WHERE customer_id = ${tenantId} AND module_id = ${mv.moduleId} FOR UPDATE`
      if (st?.state === 'enabling') {
        await tx`UPDATE plt.module_database SET state = 'enabled', dropped_at = NULL WHERE customer_id = ${tenantId} AND module_id = ${mv.moduleId}`
      } else if (st?.state !== 'enabled') {
        throw new LifecycleError('CONCURRENT_STATE', `${dbName} moved to ${String(st?.state)} while it was being enabled`)
      }
    }
    await tx`
      INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, state,
        isolation_test_result_id, cross_body_test_result_id, dpia_decision_id,
        enabled_by_kind, enabled_by, enabled_at, created_by_kind, created_by, updated_by_kind, updated_by)
      VALUES (${tenantId}, ${mv.moduleId}, ${mv.moduleVersionId}, 'enabled',
        ${gate.isolationTestResultId}, ${gate.crossBodyTestResultId ?? null}, ${gate.dpiaDecisionId},
        ${actor.kind}, ${actor.id}, now(), ${actor.kind}, ${actor.id}, ${actor.kind}, ${actor.id})
      ON CONFLICT (customer_id, module_id) DO UPDATE SET
        module_version_id = EXCLUDED.module_version_id,
        state = 'enabled',
        isolation_test_result_id = EXCLUDED.isolation_test_result_id,
        cross_body_test_result_id = EXCLUDED.cross_body_test_result_id,
        dpia_decision_id = EXCLUDED.dpia_decision_id,
        enabled_by_kind = EXCLUDED.enabled_by_kind,
        enabled_by = EXCLUDED.enabled_by,
        enabled_at = EXCLUDED.enabled_at,
        updated_by_kind = EXCLUDED.updated_by_kind,
        updated_by = EXCLUDED.updated_by`
  })
  await hook('enabled', dbName)
  log(`enabled (${tenantId}, ${moduleId})${dbName ? ` on ${dbName}${created ? ' (created)' : ''}, ${applied.length} migration(s) applied` : ' (no database)'}`)
  return { tenantId, moduleId, database: dbName, created, applied, noop: false }
}
