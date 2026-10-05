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
import { loadCatalogueRows, provisionalNote, type CatalogueModule, type CatalogueRowsResult } from './catalogue-rows.ts'
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
 * exportDir, and -- TASK-075 -- the releaseRef every module-database ledger
 * row records, required here so a caller cannot omit it and meet enable's
 * runtime refusal instead); the gate is the interim operator gate, passed per call.
 */
export function pgModules(opts: {
  platform: Sql
  catalogue: readonly LifecycleModule[]
  lifecycle: Omit<LifecycleDeps, 'enableGate' | 'platform' | 'releaseRef'> & { releaseRef: string }
}): ModulesPort {
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
  /**
   * TASK-075: the release this init ships (the deployed IMAGE_TAG), written
   * as release_ref into every gremion_platform ledger row it applies.
   */
  releaseRef: string
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

/**
 * What the control panel reads (apps/control-panel customers.ts, requests.ts),
 * and nothing else. The request queue is read through its status VIEW (no
 * evidence_token); plt.module + plt.module_enablement feed the module
 * checkboxes and the per-customer module list (TASK-043d).
 */
export const PANEL_READS = {
  control: ['public.tenant', 'public.tenant_domain'],
  platform: [
    'plt.provisioning_step',
    'plt.provisioning_request_status',
    'plt.provisioning_request_event',
    'plt.executor_heartbeat',
    'plt.module',
    'plt.module_enablement',
  ],
} as const

/** The panel's ONE write (TASK-043d D2): no table privilege, this function only. */
export const PANEL_EXECUTES = ['plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text)'] as const

/** The host-side executor's functions (TASK-043d D3); no table privilege at all. */
export const EXECUTOR_EXECUTES = [
  'plt.claim_provisioning_request(text, integer)',
  'plt.requeue_own_requests(text)',
  'plt.renew_provisioning_lease(uuid, text, integer)',
  'plt.record_provisioning_event(uuid, text, text, text, text)',
  'plt.mark_provisioning_request_verified(uuid, text)',
  'plt.finish_provisioning_request(uuid, text, text, text)',
  'plt.executor_beat(text, text)',
  'plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text)',
] as const

/** NOLOGIN marker roles: membership says which origin a request has (no privilege of their own). */
export const PANEL_REQUESTER_MARKER = 'plt_panel_requester'
export const EXECUTOR_MARKER = 'plt_executor'
/** The executor's LOGIN role: no password, reachable only over the state server's local socket. */
export const EXECUTOR_ROLE = 'gremion_executor'

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
    if (!r?.sel || r.write) throw new ProvisioningError('POSTCONDITION', `panel role ${role} on ${t}: select=${r?.sel} write=${r?.write} (want select only)`)
  }
}

/** Every relation of `schema` the role may touch beyond `reads` (SELECT) is a POSTCONDITION failure. */
async function assertNoOtherRelation(sql: Sql, role: string, schema: string, reads: readonly string[]): Promise<void> {
  const rows = await sql<{ rel: string; sel: boolean; write: boolean }[]>`
    SELECT format('%I.%I', n.nspname, c.relname) AS rel,
           has_table_privilege(${role}, c.oid, 'SELECT') AS sel,
           has_table_privilege(${role}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS write
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'v', 'm', 'p', 'f')`
  const allowed = new Set(reads)
  const extra = rows.filter((r) => r.write || (r.sel && !allowed.has(r.rel))).map((r) => `${r.rel}${r.write ? ' (write)' : ''}`)
  if (extra.length) throw new ProvisioningError('POSTCONDITION', `role ${role} holds privileges beyond its read set on ${extra.join(', ')}`)
}

/** The role may EXECUTE exactly `want` among the callable (non-trigger) functions of plt. */
async function assertExecutesExactly(sql: Sql, role: string, want: readonly string[]): Promise<void> {
  const rows = await sql<{ sig: string; x: boolean }[]>`
    SELECT p.oid::regprocedure::text AS sig, has_function_privilege(${role}, p.oid, 'EXECUTE') AS x
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'plt' AND p.prorettype <> 'trigger'::regtype`
  const wanted = await sql<{ sig: string | null }[]>`SELECT to_regprocedure(s)::text AS sig FROM unnest(${[...want]}::text[]) AS s`
  const missingFn = want.filter((_, i) => wanted[i]?.sig == null)
  if (missingFn.length) throw new ProvisioningError('PRECONDITION', `function(s) ${missingFn.join(', ')} are absent in gremion_platform; run migratePlatform (bootstrapPlatform) first`)
  const need = new Set(wanted.map((w) => w.sig!))
  const have = new Set(rows.filter((r) => r.x).map((r) => r.sig))
  const lacking = [...need].filter((s) => !have.has(s))
  const extra = [...have].filter((s) => !need.has(s))
  if (lacking.length || extra.length) {
    throw new ProvisioningError('POSTCONDITION', `role ${role} EXECUTE set differs: lacking [${lacking.join(', ')}], extra [${extra.join(', ')}]`)
  }
}

/** A NOLOGIN marker role (created when absent) and `member`'s membership in it, with no inherit and no SET. */
async function ensureMarker(admin: Sql, marker: string, member: string): Promise<void> {
  const exists = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${marker}`).length > 0
  if (!exists) await execFmt(admin, 'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', [marker])
  await execFmt(admin, 'GRANT %I TO %I WITH INHERIT FALSE, SET FALSE', [marker, member])
}

async function memberOf(admin: Sql, member: string): Promise<string[]> {
  const rows = await admin<{ r: string }[]>`
    SELECT r.rolname AS r FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
     WHERE u.rolname = ${member} ORDER BY 1`
  return rows.map((x) => x.r)
}

async function assertLoginOnly(admin: Sql, role: string, what: string): Promise<void> {
  const [r] = await admin<{ bad: boolean }[]>`
    SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit OR NOT rolcanlogin) AS bad FROM pg_roles WHERE rolname = ${role}`
  if (!r || r.bad) throw new ProvisioningError('POSTCONDITION', `${what} ${role} carries an attribute beyond LOGIN NOINHERIT`)
}

/**
 * The control panel's database role (review C MEDIUM #70; TASK-043d D3):
 * LOGIN NOINHERIT, no superuser/createdb/createrole/bypassrls, CONNECT on the
 * control registry and gremion_platform, SELECT on exactly PANEL_READS,
 * EXECUTE on exactly plt.submit_provisioning_request, and membership (no
 * inherit, no SET) in the marker role plt_panel_requester that makes its
 * requests origin=panel. It writes no table. Idempotent; a rerun re-sets the
 * password (the env file is the source) and re-asserts every grant.
 */
export async function ensurePanelRequester(d: PanelReaderDeps): Promise<{ created: boolean }> {
  if (!IDENT.test(d.role)) throw new ProvisioningError('INVALID_INPUT', `panel role ${JSON.stringify(d.role)} is not a plain identifier`)
  if (!IDENT.test(d.controlDatabase)) throw new ProvisioningError('INVALID_INPUT', `control database ${JSON.stringify(d.controlDatabase)} is not a plain identifier`)
  if (d.password.length < 16) throw new ProvisioningError('INVALID_INPUT', 'the panel role password is shorter than 16 characters')
  if (d.role === EXECUTOR_ROLE || d.role === PANEL_REQUESTER_MARKER || d.role === EXECUTOR_MARKER) {
    throw new ProvisioningError('INVALID_INPUT', `the panel role may not be named ${d.role}`)
  }
  // Every relation the role reads must exist BEFORE anything is created (review
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
          throw new ProvisioningError('PRECONDITION', `panel role: relation ${t} is absent in database ${db}; run ${by} before gremion-tenant init (docs/ops/pooled-stack-layout.md)`)
        }
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const exists = (await d.kernelAdmin`SELECT 1 FROM pg_roles WHERE rolname = ${d.role}`).length > 0
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L'
  await execFmt(d.kernelAdmin, `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${attrs}`, [d.role, d.password])
  await ensureMarker(d.kernelAdmin, PANEL_REQUESTER_MARKER, d.role)
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
      if (schema === 'plt') {
        for (const f of PANEL_EXECUTES) await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${f} TO ${await quoteIdent(sql, d.role)}`)
        await assertNoOtherRelation(sql, d.role, 'plt', tables)
        await assertExecutesExactly(sql, d.role, PANEL_EXECUTES)
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  await assertLoginOnly(d.kernelAdmin, d.role, 'panel role')
  const markers = await memberOf(d.kernelAdmin, d.role)
  if (markers.includes(EXECUTOR_MARKER)) throw new ProvisioningError('POSTCONDITION', `panel role ${d.role} is a member of ${EXECUTOR_MARKER}`)
  if (!markers.includes(PANEL_REQUESTER_MARKER)) throw new ProvisioningError('POSTCONDITION', `panel role ${d.role} is not a member of ${PANEL_REQUESTER_MARKER}`)
  return { created: !exists }
}

async function quoteIdent(sql: Sql, ident: string): Promise<string> {
  const [r] = await sql<{ q: string }[]>`SELECT quote_ident(${ident}) AS q`
  return r!.q
}

export interface ExecutorRoleDeps {
  /** A superuser (the state server's POSTGRES_USER) on any database. */
  kernelAdmin: Sql
  /** The same superuser on the named database (closed by the caller's `end`). */
  openAdminOn(database: string): Sql
  /** Default gremion_executor. */
  role?: string
}

/**
 * The host-side executor's role (TASK-043d D3): LOGIN NOINHERIT WITHOUT a
 * password -- a password-less role authenticates only where pg_hba trusts the
 * local socket, i.e. through `docker exec` into the state server (the
 * host-privileged path) and never over the network -- CONNECT on
 * gremion_platform, EXECUTE on exactly EXECUTOR_EXECUTES, no table privilege,
 * and membership (no inherit, no SET) in plt_executor (origin=host for a
 * break-glass request). Idempotent; a rerun re-asserts everything.
 */
export async function ensureExecutorRole(d: ExecutorRoleDeps): Promise<{ created: boolean }> {
  const role = d.role ?? EXECUTOR_ROLE
  if (!IDENT.test(role)) throw new ProvisioningError('INVALID_INPUT', `executor role ${JSON.stringify(role)} is not a plain identifier`)
  if (role === PANEL_REQUESTER_MARKER || role === EXECUTOR_MARKER) throw new ProvisioningError('INVALID_INPUT', `the executor role may not be named ${role}`)
  const sql = d.openAdminOn('gremion_platform')
  try {
    for (const f of EXECUTOR_EXECUTES) {
      const [r] = await sql<{ present: boolean }[]>`SELECT to_regprocedure(${f}) IS NOT NULL AS present`
      if (!r?.present) throw new ProvisioningError('PRECONDITION', `executor role: function ${f} is absent in gremion_platform; run migratePlatform (bootstrapPlatform) before it`)
    }
    const exists = (await d.kernelAdmin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length > 0
    const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL'
    await execFmt(d.kernelAdmin, `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${attrs}`, [role])
    await ensureMarker(d.kernelAdmin, EXECUTOR_MARKER, role)
    await execFmt(d.kernelAdmin, 'GRANT CONNECT ON DATABASE %I TO %I', ['gremion_platform', role])
    await execFmt(sql, 'GRANT USAGE ON SCHEMA %I TO %I', ['plt', role])
    const q = await quoteIdent(sql, role)
    for (const f of EXECUTOR_EXECUTES) await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${f} TO ${q}`)
    await assertNoOtherRelation(sql, role, 'plt', [])
    await assertExecutesExactly(sql, role, EXECUTOR_EXECUTES)
    await assertLoginOnly(d.kernelAdmin, role, 'executor role')
    const [pw] = await d.kernelAdmin<{ has: boolean }[]>`SELECT rolpassword IS NOT NULL AS has FROM pg_authid WHERE rolname = ${role}`
    if (!pw || pw.has) throw new ProvisioningError('POSTCONDITION', `executor role ${role} has a password; it must authenticate over the local socket only`)
    const markers = await memberOf(d.kernelAdmin, role)
    if (markers.includes(PANEL_REQUESTER_MARKER) || !markers.includes(EXECUTOR_MARKER)) {
      throw new ProvisioningError('POSTCONDITION', `executor role ${role} memberships [${markers.join(', ')}], want ${EXECUTOR_MARKER} only`)
    }
    return { created: !exists }
  } finally {
    await sql.end({ timeout: 5 })
  }
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
    const m = await migratePlatform(platform, { releaseRef: deps.releaseRef, log })
    const catalogue = await loadCatalogueRows(platform, deps.catalogue)
    for (const u of catalogue.undecided) log(`catalogue: ${u.moduleKey} NOT loaded: ${u.reason}`)
    for (const r of catalogue.load) if (r.provisional) log(`catalogue: ${provisionalNote(r)}`)
    const opsRealm = deps.opsRealm ? await deps.opsRealm.ensure() : null
    return { platformCreated: db.created, applied: m.applied, catalogue, opsRealm }
  } finally {
    await platform.end({ timeout: 5 })
  }
}
