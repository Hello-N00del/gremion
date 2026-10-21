// packages/tenant-store/src/lifecycle/kernel-api-reader.ts
//
// TASK-077 (lane note C13): the kernel API's database role for the two
// platform databases it READS, and nothing else:
//   control           public.tenant, public.tenant_domain   (tenancy, Q1)
//   gremion_platform  plt.module, plt.module_version,
//                     plt.module_enablement                  (the registry)
// LOGIN, no superuser/createdb/createrole/replication/bypassrls, NOINHERIT,
// CONNECT on both databases, USAGE on the two schemas, SELECT on exactly the
// tables above. It mirrors @gremion/provisioning's ensurePanelReader (the
// control panel's reader) and, like it, ASSERTS the result: every other table
// in those databases -- plt.provisioning_step, the operator attestations, the
// executor's request queue, ops.* -- is neither readable nor writable by it.
//
// Wiring it into `init` (bootstrapPlatform) is TASK-043d's hand-off (R31-I4:
// the provisioning engine is the only operator surface); until then the
// kernel API's test harness calls it directly. Idempotent: a rerun re-sets the
// password (the env file is the source) and re-asserts the grants.
import type { Sql } from '@gremion/db'
import { PLATFORM_DATABASE } from './platform.js'

/** What the kernel API reads, per database, and nothing else. */
export const KERNEL_API_READS = {
  control: ['public.tenant', 'public.tenant_domain'],
  platform: ['plt.module', 'plt.module_version', 'plt.module_enablement'],
} as const

export type KernelApiReaderErrorCode = 'INVALID_INPUT' | 'PRECONDITION' | 'POSTCONDITION'

export class KernelApiReaderError extends Error {
  override name = 'KernelApiReaderError'
  constructor(
    readonly code: KernelApiReaderErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface KernelApiReaderDeps {
  /** The kernel server's superuser, on any database (roles are cluster-wide). */
  kernelAdmin: Sql
  /** The same superuser on the named database; the caller's `end` is called here. */
  openAdminOn(database: string): Sql
  /** The role name (KERNEL_API_DB_ROLE), a plain identifier. */
  role: string
  password: string
  /** The control registry's database (CONTROL_DB_NAME, `control`). */
  controlDatabase: string
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

async function execFmt(sql: Sql, template: string, args: readonly string[]): Promise<void> {
  const ph = args.map((_, i) => `, $${i + 2}::text`).join('')
  const [row] = await sql.unsafe<{ q: string }[]>(`SELECT format($1::text${ph}) AS q`, [template, ...args])
  await sql.unsafe(row!.q)
}

/**
 * Every ordinary/partitioned table and view of the database outside the
 * system schemas: the allowed ones must be SELECT-only for `role`, every other
 * one must carry no privilege for it at all. Returns the problems (empty = ok).
 */
export async function kernelApiReaderPrivilegeProblems(sql: Sql, role: string, allowed: readonly string[]): Promise<string[]> {
  const rows = await sql<{ rel: string; sel: boolean; write: boolean }[]>`
    SELECT format('%s.%s', n.nspname, c.relname) AS rel,
           has_table_privilege(${role}, c.oid, 'SELECT') AS sel,
           has_table_privilege(${role}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS write
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
     ORDER BY 1`
  const want = new Set(allowed)
  const problems: string[] = []
  for (const r of rows) {
    if (want.has(r.rel)) {
      if (!r.sel || r.write) problems.push(`${r.rel}: select=${r.sel} write=${r.write} (want select only)`)
    } else if (r.sel || r.write) {
      problems.push(`${r.rel}: select=${r.sel} write=${r.write} (want no privilege: not a kernel API read)`)
    }
  }
  for (const t of allowed) if (!rows.some((r) => r.rel === t)) problems.push(`${t}: absent`)
  return problems
}

export async function ensureKernelApiReader(d: KernelApiReaderDeps): Promise<{ created: boolean }> {
  if (!IDENT.test(d.role)) throw new KernelApiReaderError('INVALID_INPUT', `kernel API reader role ${JSON.stringify(d.role)} is not a plain identifier`)
  if (!IDENT.test(d.controlDatabase)) throw new KernelApiReaderError('INVALID_INPUT', `control database ${JSON.stringify(d.controlDatabase)} is not a plain identifier`)
  if (typeof d.password !== 'string' || d.password.length < 16) throw new KernelApiReaderError('INVALID_INPUT', 'the kernel API reader password is shorter than 16 characters')
  const targets = [
    { db: d.controlDatabase, schema: 'public', tables: KERNEL_API_READS.control, by: 'the migrate one-shot (control registry migrations)' },
    { db: PLATFORM_DATABASE, schema: 'plt', tables: KERNEL_API_READS.platform, by: 'migratePlatform (bootstrapPlatform)' },
  ] as const
  // Every table it reads must exist before anything is created.
  for (const t of targets) {
    const sql = d.openAdminOn(t.db)
    try {
      for (const table of t.tables) {
        const [r] = await sql<{ present: boolean }[]>`SELECT pg_catalog.to_regclass(${table}) IS NOT NULL AS present`
        if (!r?.present) throw new KernelApiReaderError('PRECONDITION', `kernel API reader: table ${table} is absent in database ${t.db}; run ${t.by} first`)
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const exists = (await d.kernelAdmin`SELECT 1 FROM pg_roles WHERE rolname = ${d.role}`).length > 0
  // Refuse a pre-existing role that is not already a reader BEFORE any ALTER: a
  // mistyped KERNEL_API_DB_ROLE naming a customer role (k_<hex>_app, a member of
  // its owner) or an owner must not have its password and NOINHERIT clobbered.
  // A reader this function made has no memberships and owns nothing.
  if (exists) {
    const [links] = await d.kernelAdmin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_auth_members m
        JOIN pg_roles r ON r.oid IN (m.member, m.roleid) WHERE r.rolname = ${d.role}`
    if ((links?.n ?? 0) > 0) throw new KernelApiReaderError('PRECONDITION', `role ${d.role} already exists and is a member of, or has members in, another role: it is not a kernel API reader; refusing to alter it (check KERNEL_API_DB_USER)`)
    for (const db of [...new Set([d.controlDatabase, PLATFORM_DATABASE])]) {
      const sql = d.openAdminOn(db)
      try {
        const [o] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_catalog.pg_shdepend s
            JOIN pg_catalog.pg_roles r ON r.oid = s.refobjid
           WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass AND s.deptype = 'o' AND r.rolname = ${d.role}
             AND s.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()))`
        if ((o?.n ?? 0) > 0) throw new KernelApiReaderError('PRECONDITION', `role ${d.role} already exists and owns ${o!.n} object(s) in ${db} (or owns a database): it is not a kernel API reader; refusing to alter it (check KERNEL_API_DB_USER)`)
      } finally {
        await sql.end({ timeout: 5 })
      }
    }
  }
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L'
  await execFmt(d.kernelAdmin, `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${attrs}`, [d.role, d.password])
  for (const t of targets) await execFmt(d.kernelAdmin, 'GRANT CONNECT ON DATABASE %I TO %I', [t.db, d.role])
  for (const t of targets) {
    const sql = d.openAdminOn(t.db)
    try {
      await execFmt(sql, 'GRANT USAGE ON SCHEMA %I TO %I', [t.schema, d.role])
      for (const table of t.tables) {
        const [s, name] = table.split('.') as [string, string]
        await execFmt(sql, 'GRANT SELECT ON TABLE %I.%I TO %I', [s, name, d.role])
      }
      const problems = await kernelApiReaderPrivilegeProblems(sql, d.role, t.tables)
      if (problems.length) throw new KernelApiReaderError('POSTCONDITION', `kernel API reader ${d.role} in ${t.db}: ${problems.join('; ')}`)
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const [r] = await d.kernelAdmin<{ bad: boolean }[]>`
    SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication OR rolinherit OR NOT rolcanlogin) AS bad
      FROM pg_roles WHERE rolname = ${d.role}`
  if (!r || r.bad) throw new KernelApiReaderError('POSTCONDITION', `kernel API reader ${d.role} carries an attribute beyond LOGIN NOINHERIT`)
  const [member] = await d.kernelAdmin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${d.role}`
  if ((member?.n ?? 0) > 0) throw new KernelApiReaderError('POSTCONDITION', `kernel API reader ${d.role} is a member of another role; it must hold its grants directly`)
  return { created: !exists }
}
