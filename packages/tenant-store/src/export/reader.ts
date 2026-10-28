// packages/tenant-store/src/export/reader.ts
//
// The export's own database role (HIGH-1). The export reads tenant databases
// whose owner role (k_app, through membership) may plant code that runs when
// a value is cast, compared or rendered: a cast on its own type, say. A
// superuser session that runs such code hands the tenant COPY ... TO PROGRAM
// (OS command execution), READ ONLY or not; SET ROLE does not help, because
// tenant code can RESET ROLE back to the session user. So the export never
// connects as the server's superuser: it logs in AS this role, which is
//
//   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
//
// a member of pg_read_all_data (and of nothing else), with CONNECT on exactly
// the databases of the export at hand. BYPASSRLS keeps the export complete
// where a table has row-level security; it grants no code execution. The
// password is a fresh random secret per run (a SCRAM verifier in the DDL,
// never the plaintext) and is set to NULL again when the run ends
// (retireExportReader), so the role cannot log in between exports.
import { randomBytes } from 'node:crypto'
import type postgres from 'postgres'
import { scramSha256Verifier } from '../lifecycle/scram.js'

type Sql = postgres.Sql<Record<string, never>>

export const EXPORT_READER_ROLE = 'gremion_export_reader'

export class ExportReaderError extends Error {
  override name = 'ExportReaderError'
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

async function execFmt(sql: Sql, template: string, args: readonly string[]): Promise<void> {
  const ph = args.map((_, i) => `, $${i + 2}::text`).join('')
  const [row] = await sql.unsafe<{ q: string }[]>(`SELECT pg_catalog.format($1::text${ph}) AS q`, [template, ...args])
  await sql.unsafe(row!.q)
}

export interface ExportReaderCredentials {
  user: string
  password: string
}

/**
 * Creates (or re-asserts) the export reader on the server `admin` is a
 * superuser of, with a fresh password and CONNECT on `databases`. `admin`
 * must be connected to a maintenance database, never to a tenant database:
 * nothing here runs inside one. Refuses a pre-existing role of that name that
 * is anything but an export reader (other memberships, members, owned objects).
 */
export async function ensureExportReader(admin: Sql, opts: { databases: readonly string[]; role?: string }): Promise<ExportReaderCredentials> {
  const role = opts.role ?? EXPORT_READER_ROLE
  if (!IDENT.test(role)) throw new ExportReaderError(`export reader role ${JSON.stringify(role)} is not a plain identifier`)
  for (const db of opts.databases) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db)) throw new ExportReaderError(`database ${JSON.stringify(db)} is not a plain identifier`)
  const exists = (await admin`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${role}`).length > 0
  if (exists) {
    const [links] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles r ON r.oid = m.member
        JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
       WHERE (r.rolname = ${role} AND g.rolname <> 'pg_read_all_data') OR g.rolname = ${role}`
    if ((links?.n ?? 0) > 0) throw new ExportReaderError(`role ${role} exists and has memberships beyond pg_read_all_data: it is not an export reader; refusing to alter it`)
    const [owns] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_roles r ON r.oid = s.refobjid
       WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.deptype = 'o' AND r.rolname = ${role}`
    if ((owns?.n ?? 0) > 0) throw new ExportReaderError(`role ${role} exists and owns objects: it is not an export reader; refusing to alter it`)
  }
  const password = randomBytes(32).toString('base64url')
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT PASSWORD %L'
  await execFmt(admin, `${exists ? 'ALTER' : 'CREATE'} ROLE %I ${attrs}`, [role, scramSha256Verifier(password)])
  await execFmt(admin, 'GRANT pg_read_all_data TO %I', [role])
  for (const db of opts.databases) await execFmt(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [db, role])
  await assertNotSuperuserCapable(admin, role)
  return { user: role, password }
}

/** Ends the reader's ability to log in (PASSWORD NULL). Idempotent; a missing role is fine. */
export async function retireExportReader(admin: Sql, role: string = EXPORT_READER_ROLE): Promise<void> {
  if (!IDENT.test(role)) throw new ExportReaderError(`export reader role ${JSON.stringify(role)} is not a plain identifier`)
  if ((await admin`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${role}`).length === 0) return
  await execFmt(admin, 'ALTER ROLE %I PASSWORD NULL', [role])
}

/** Throws unless `role` is not a superuser and cannot become one (no membership in, or SET to, a superuser role). */
export async function assertNotSuperuserCapable(sql: Sql | postgres.TransactionSql, role: string): Promise<void> {
  const [r] = await (sql as Sql)<{ bad: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles s
       WHERE s.rolsuper AND pg_catalog.pg_has_role(${role}::name, s.oid, 'MEMBER')
    ) OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${role} AND (rolsuper OR rolcreaterole OR rolreplication)) AS bad`
  if (!r || r.bad) throw new ExportReaderError(`role ${role} is (or can become) a superuser or may create roles: the export never runs as one`)
}
