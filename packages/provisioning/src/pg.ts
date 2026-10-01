// packages/provisioning/src/pg.ts — the gremion_platform adapters this
// package owns: the Q19 attestations, the modules port over TASK-021's
// enableModule, and bootstrapPlatform (Q15, `gremion-tenant init`).
import type { Sql } from '@gremion/db'
import {
  assertPlatform,
  enableModule,
  ensurePlatformDatabase,
  lookupModuleVersion,
  migratePlatform,
  type EnableGate,
  type LifecycleDeps,
  type LifecycleModule,
} from '@gremion/tenant-store/lifecycle'
import { loadCatalogueRows, type CatalogueModule, type CatalogueRowsResult } from './catalogue-rows.ts'
import { assertUuid, ProvisioningError } from './errors.ts'
import { INTERIM_GATE_BASIS } from './operator-gate.ts'
import type { AttestationPort, CustomerRef, ModulesPort } from './ports.ts'

export function pgAttestations(platform: Sql): AttestationPort {
  // A closure, not `this` (review B1 LOW, r2): the port's methods may be passed detached.
  const lookup: AttestationPort['lookup'] = async (customerId, moduleKey) => {
    assertUuid(customerId, 'customer id')
    const rows = await platform<{ id: string }[]>`
      SELECT attestation_id::text AS id FROM plt.operator_enable_attestation
       WHERE customer_id = ${customerId} AND module_key = ${moduleKey}`
    return rows[0]?.id ?? null
  }
  return {
    lookup,
    async ensure(customerId, moduleKey, operatorId, enableList) {
      assertUuid(customerId, 'customer id')
      assertUuid(operatorId, 'operator id')
      const inserted = await platform<{ id: string }[]>`
        INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
        VALUES (${customerId}, ${moduleKey}, ${operatorId}, ${[...enableList]}, ${INTERIM_GATE_BASIS})
        ON CONFLICT (customer_id, module_key) DO NOTHING
        RETURNING attestation_id::text AS id`
      const id = inserted[0]?.id ?? (await lookup(customerId, moduleKey))
      if (!id) throw new ProvisioningError('POSTCONDITION', `no attestation for (${customerId}, ${moduleKey}) after insert`)
      return id
    },
    async list(customerId) {
      assertUuid(customerId, 'customer id')
      const rows = await platform<{ module_key: string; id: string; operator_id: string; created_at: Date }[]>`
        SELECT module_key, attestation_id::text AS id, operator_id::text, created_at
          FROM plt.operator_enable_attestation WHERE customer_id = ${customerId} ORDER BY module_key`
      return rows.map((r) => ({ moduleKey: r.module_key, attestationId: r.id, operatorId: r.operator_id, createdAt: r.created_at }))
    },
  }
}

/**
 * The modules port over @gremion/tenant-store's enableModule. `lifecycle`
 * carries everything but the gate (platform, servers, secrets, exporter,
 * exportDir); the gate is the interim operator gate, passed per call.
 */
export function pgModules(opts: { platform: Sql; catalogue: readonly LifecycleModule[]; lifecycle: Omit<LifecycleDeps, 'enableGate' | 'platform'> }): ModulesPort {
  const byId = new Map(opts.catalogue.map((m) => [m.id, m]))
  return {
    catalogueIds: () => [...byId.keys()].sort(),
    async unloaded(ids) {
      const missing: string[] = []
      for (const id of ids) {
        const module = byId.get(id)
        // an id outside the catalogue is MODULE_UNKNOWN's (assertEnableList), not this check's
        if (!module) continue
        if (!(await lookupModuleVersion(opts.platform, id, module.moduleJson.runtime.version))) missing.push(id)
      }
      return missing
    },
    async enable(c: CustomerRef, moduleId: string, gate: EnableGate, operatorId: string) {
      const module = byId.get(moduleId)
      if (!module) throw new ProvisioningError('MODULE_UNKNOWN', `module ${moduleId} is not in the catalogue`)
      const r = await enableModule(c.id, module, { kind: 'operator', id: operatorId }, { ...opts.lifecycle, platform: opts.platform, enableGate: gate })
      return { noop: r.noop, database: r.database }
    },
    async enabled(c: CustomerRef) {
      const rows = await opts.platform<{ module_key: string }[]>`
        SELECT m.module_key FROM plt.module_enablement e JOIN plt.module m USING (module_id)
         WHERE e.customer_id = ${c.id} AND e.state = 'enabled' ORDER BY 1`
      return rows.map((r) => r.module_key)
    },
  }
}

export interface BootstrapDeps {
  /** The kernel server's POSTGRES_USER on its maintenance database. */
  kernelAdmin: Sql
  /** Opens gremion_platform AS its owner (a direct pool of >= 2). */
  openPlatform(): Sql
  owner: string
  ownerPassword: string
  catalogue: readonly CatalogueModule[]
  /** The ops realm (Q5); omitted for a database-only bootstrap. */
  opsRealm?: { ensure(): Promise<{ created: boolean }> }
  log?: (line: string) => void
}

export interface BootstrapResult {
  platformCreated: boolean
  applied: string[]
  catalogue: CatalogueRowsResult
  opsRealm: { created: boolean } | null
}

export interface PanelReaderDeps {
  /** A superuser (the state server's POSTGRES_USER) on any database. */
  kernelAdmin: Sql
  /** The same superuser on the named database (closed by the caller's `end`). */
  openAdminOn(database: string): Sql
  role: string
  password: string
  /** The control registry's database (CONTROL_DB_NAME, `control`). */
  controlDatabase: string
}

/** What the control panel reads (apps/control-panel customers.ts), and nothing else. */
export const PANEL_READS = { control: ['public.tenant', 'public.tenant_domain'], platform: ['plt.provisioning_step'] } as const

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

async function execFmt(sql: Sql, template: string, args: readonly string[]): Promise<void> {
  const ph = args.map((_, i) => `, $${i + 2}::text`).join('')
  const [row] = await sql.unsafe<{ q: string }[]>(`SELECT format($1::text${ph}) AS q`, [template, ...args])
  await sql.unsafe(row!.q)
}

async function assertReadsOnly(sql: Sql, role: string, tables: readonly string[]): Promise<void> {
  for (const t of tables) {
    const [r] = await sql<{ sel: boolean; write: boolean }[]>`
      SELECT has_table_privilege(${role}, ${t}, 'SELECT') AS sel,
             has_table_privilege(${role}, ${t}, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS write`
    if (!r?.sel || r.write) throw new ProvisioningError('POSTCONDITION', `panel reader ${role} on ${t}: select=${r?.sel} write=${r?.write} (want select only)`)
  }
}

/**
 * The control panel's database role (review C MEDIUM #70): LOGIN, no
 * superuser/createdb/createrole/bypassrls, CONNECT on the control registry
 * and gremion_platform, SELECT on exactly PANEL_READS. The pooled panel
 * connected as the two databases' OWNERS before; it never writes (Q6: every
 * mutation is gremion-tenant's). Idempotent; a rerun re-sets the password
 * (the env file is the source) and re-asserts the grants.
 */
export async function ensurePanelReader(d: PanelReaderDeps): Promise<{ created: boolean }> {
  if (!IDENT.test(d.role)) throw new ProvisioningError('INVALID_INPUT', `panel reader role ${JSON.stringify(d.role)} is not a plain identifier`)
  if (!IDENT.test(d.controlDatabase)) throw new ProvisioningError('INVALID_INPUT', `control database ${JSON.stringify(d.controlDatabase)} is not a plain identifier`)
  if (d.password.length < 16) throw new ProvisioningError('INVALID_INPUT', 'the panel reader password is shorter than 16 characters')
  // Every table the role reads must exist BEFORE anything is created (review
  // r4 LOW): `init` runs after the migrate one-shot has migrated the control
  // registry; on an unmigrated stack it says so instead of a bare 42P01.
  for (const [db, tables, by] of [
    [d.controlDatabase, PANEL_READS.control, 'the migrate one-shot (control registry migrations)'],
    ['gremion_platform', PANEL_READS.platform, 'migratePlatform (bootstrapPlatform)'],
  ] as const) {
    const sql = d.openAdminOn(db)
    try {
      for (const t of tables) {
        const [r] = await sql<{ present: boolean }[]>`SELECT to_regclass(${t}) IS NOT NULL AS present`
        if (!r?.present) {
          throw new ProvisioningError('PRECONDITION', `panel reader: table ${t} is absent in database ${db}; run ${by} before gremion-tenant init (docs/ops/pooled-stack-layout.md)`)
        }
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const exists = (await d.kernelAdmin`SELECT 1 FROM pg_roles WHERE rolname = ${d.role}`).length > 0
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L'
  await execFmt(d.kernelAdmin, `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${attrs}`, [d.role, d.password])
  for (const db of [d.controlDatabase, 'gremion_platform']) await execFmt(d.kernelAdmin, 'GRANT CONNECT ON DATABASE %I TO %I', [db, d.role])
  for (const [db, schema, tables] of [
    [d.controlDatabase, 'public', PANEL_READS.control],
    ['gremion_platform', 'plt', PANEL_READS.platform],
  ] as const) {
    const sql = d.openAdminOn(db)
    try {
      await execFmt(sql, 'GRANT USAGE ON SCHEMA %I TO %I', [schema, d.role])
      for (const t of tables) {
        const [s, name] = t.split('.') as [string, string]
        await execFmt(sql, 'GRANT SELECT ON TABLE %I.%I TO %I', [s, name, d.role])
      }
      await assertReadsOnly(sql, d.role, tables)
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const [r] = await d.kernelAdmin<{ bad: boolean }[]>`
    SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR NOT rolcanlogin) AS bad FROM pg_roles WHERE rolname = ${d.role}`
  if (!r || r.bad) throw new ProvisioningError('POSTCONDITION', `panel reader ${d.role} carries an attribute beyond LOGIN`)
  return { created: !exists }
}

/**
 * `gremion-tenant init` (Q15): gremion_platform created if absent, migrated
 * (migratePlatform asserts the connection), the catalogue rows loaded (Q20),
 * the ops realm made (Q5). Idempotent: a rerun creates, applies and inserts
 * nothing.
 */
export async function bootstrapPlatform(deps: BootstrapDeps): Promise<BootstrapResult> {
  const log = deps.log ?? (() => {})
  const db = await ensurePlatformDatabase(deps.kernelAdmin, { owner: deps.owner, ownerPassword: deps.ownerPassword })
  log(`gremion_platform ${db.created ? 'created' : 'present'} (owner ${db.owner})`)
  const platform = deps.openPlatform()
  try {
    await assertPlatform(platform)
    const m = await migratePlatform(platform, { log })
    const catalogue = await loadCatalogueRows(platform, deps.catalogue)
    for (const u of catalogue.undecided) log(`catalogue: ${u.moduleKey} NOT loaded: ${u.reason}`)
    const opsRealm = deps.opsRealm ? await deps.opsRealm.ensure() : null
    return { platformCreated: db.created, applied: m.applied, catalogue, opsRealm }
  } finally {
    await platform.end({ timeout: 5 })
  }
}
