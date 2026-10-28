// packages/tenant-store/src/export/export.ts
//
// TRD-149/150/151 (PRD-PLAT-004): the tenant export in open formats. One CSV
// and one JSON file per exportable table, grouped per module, plus
// manifest.json (schema version, tenant slug, generated_at, every file with
// its sha256, byte size and row count, every module or system that is NOT in
// the export with the reason), then the completeness check over what is on
// disk (verify.ts). This is an export, not a backup: restic backups
// (infra/host/bin/gremion-backup) stay the restore path.
//
// What is exported:
//   kernel   KERNEL_EXPORT_TABLES: org units, role definitions and
//            assignments (+ history), committee membership, elections,
//            caucuses, protocols with attendance, resolutions, action items
//            and challenges, the audit log. config_store is NOT exported
//            (it may hold credentials) and is listed under excluded_tables.
//   modules  a module whose module.json declares runtime.export (kind
//            pg_dump) AND is enabled for the tenant: every base table in
//            every non-system schema of the tenant's module database
//            (finance.*, content.*, public.*) except the migration ledger;
//            a module that yields no table fails the export. A table outside
//            public is written as <scope>/<schema>.<table>.(csv|json).
//            runtime.export.withhold (schema.table or schema.table.column)
//            keeps a module's secrets (tokens, ciphertexts, credentials) out
//            of the files; each is listed under excluded_tables /
//            excluded_columns, and an entry that names nothing fails the
//            export. A module with runtime.export null is listed under excluded, with the
//            reason; so are Nextcloud files and Matrix history, which live
//            outside Postgres and are not exported by this tool.
// Every database is read in ONE repeatable-read, read-only transaction, so a
// table pair is consistent, and never as a superuser (HIGH-1: tenant-defined
// casts/functions would run with its rights): the caller connects as the
// export reader (reader.ts), and every database is refused otherwise. Rows
// are ordered by primary key (else ctid) and rendered by the driver from the
// server's text output; no value is cast in SQL. Output: directory 0700, files 0600, never into a
// directory that already has content.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type postgres from 'postgres'
import { CSV_FORMULA_GUARD, csvLine, jsonReplacer } from './csv.js'
import { assertNotSuperuserCapable } from './reader.js'
import { MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, verifyExport, type ExportManifest, type ManifestFile, type VerifyResult } from './verify.js'

type Sql = postgres.Sql<Record<string, never>>

/** Kernel core tables (gremion-ui/migrations): committees became org_units in 0010. */
export const KERNEL_EXPORT_TABLES = [
  'org_units',
  'org_unit_kind',
  'sub_org_type',
  'committee_groups',
  'committee_roles',
  'role_assignments',
  'role_assignment_history',
  'committee_members',
  'committee_elections',
  'caucus',
  'caucus_membership',
  'protocols',
  'protocol_attendance',
  'protocol_resolutions',
  'protocol_action_items',
  'resolution_challenges',
  'audit_log',
] as const

export const KERNEL_EXCLUDED_TABLES: readonly { table: string; reason: string }[] = [
  { table: 'config_store', reason: 'tenant configuration may hold credentials; not personal or governance data' },
]

/** Systems outside Postgres that this tool never exports (named so the omission is visible, TRD-150). */
export const ALWAYS_EXCLUDED_SYSTEMS: readonly { system: string; reason: string }[] = [
  { system: 'nextcloud-files', reason: 'file bytes live in Nextcloud/object storage, not in the tenant database; not exported by this tool (fetch with the storage tooling)' },
  { system: 'matrix-history', reason: 'chat history lives in the Synapse database on the messaging server; not exported by this tool' },
]

export interface ExportModule {
  id: string
  /** module.json runtime.export (null when the module declares none); withhold: schema.table[.column] left out (MED-3). */
  runtimeExport: { kind: string; retentionProfile: string; withhold?: readonly string[] } | null
  /** module.json runtime.platformServer, if any. */
  platformServer?: { postgresService: string; databases: readonly string[] } | null
  /** Whether the module is enabled for this tenant (it has a database for it). */
  enabled: boolean
  /** Connection to the tenant's module database; required when runtimeExport and enabled. */
  sql?: Sql
}

export interface ExportOptions {
  slug: string
  outDir: string
  kernel: Sql
  modules: readonly ExportModule[]
  now?: () => Date
  /** Replaces the exported kernel list (tests). */
  kernelTables?: readonly string[]
}

export interface ExportResult {
  manifest: ExportManifest
  verify: VerifyResult
}

export class ExportError extends Error {}

const IDENT = /^[a-z][a-z0-9_]*$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const LEDGER_TABLE = 'schema_migrations'
const BATCH = 500

function ensureEmptyPrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (readdirSync(dir).length > 0) throw new ExportError(`output directory ${dir} is not empty: an export never overwrites or mixes with earlier files`)
}

interface Sink {
  write(chunk: string): void
  end(): { bytes: number; sha256: string }
}

function openSink(path: string): Sink {
  const fd = openSync(path, 'wx', 0o600)
  const hash = createHash('sha256')
  let bytes = 0
  return {
    write(chunk) {
      const b = Buffer.from(chunk, 'utf8')
      hash.update(b)
      bytes += b.length
      writeSync(fd, b)
    },
    end() {
      closeSync(fd)
      return { bytes, sha256: hash.digest('hex') }
    },
  }
}

/** A SQL identifier, quoted (any name the catalog returns; nothing is interpolated unquoted). */
function quoteIdent(id: string): string {
  return `"${id.replaceAll('"', '""')}"`
}

/**
 * MED-1: a catalog name as a file-name part. [a-z0-9_] stay as they are;
 * every other UTF-8 byte becomes -<2 lowercase hex> ("Members" ->
 * "-4dembers", "../x" -> "-2e-2e-2fx"), so the result is [a-z0-9_-]+, never
 * holds a dot or a slash, and distinct names stay distinct. The manifest
 * keeps the real name.
 */
export function fileSafeName(name: string): string {
  let out = ''
  for (const b of Buffer.from(name, 'utf8')) {
    const ch = String.fromCharCode(b)
    out += /[a-z0-9_]/.test(ch) ? ch : `-${b.toString(16).padStart(2, '0')}`
  }
  return out
}

const FILE_PART = /^[a-z0-9_-]+$/
/** Longest stem before the hash fallback: <stem>.json stays well inside NAME_MAX (255). */
const MAX_STEM = 200

/** <table> for public, <schema>.<table> otherwise, file-safe (the file names inside the scope directory). */
export function fileStem(schema: string, table: string): string {
  const parts = (schema === 'public' ? [table] : [schema, table]).map(fileSafeName)
  for (const p of parts) if (!FILE_PART.test(p)) throw new ExportError(`refusing table name ${JSON.stringify(`${schema}.${table}`)}: no file-safe name`)
  const stem = parts.join('.')
  if (stem.length <= MAX_STEM) return stem
  const h = createHash('sha256').update(`${schema}\u0000${table}`).digest('hex').slice(0, 16)
  return `${parts.join('_').slice(0, MAX_STEM - 18)}-h${h}`
}

/** The file's absolute path, asserted to stay inside <outDir>/<scope> (MED-1). */
function insideOut(outDir: string, scope: string, file: string): string {
  if (!IDENT.test(scope)) throw new ExportError(`refusing scope ${JSON.stringify(scope)}`)
  const base = resolve(outDir, scope)
  const p = resolve(base, file)
  if (dirname(p) !== base || !p.startsWith(base + sep)) throw new ExportError(`refusing a file outside ${base}: ${JSON.stringify(file)}`)
  return p
}

const WITHHELD = 'withheld by the module (module.json runtime.export.withhold): a secret or credential, not exported in open formats'

async function exportTable(tx: postgres.TransactionSql, scope: string, schema: string, table: string, outDir: string, withheldColumns: ReadonlySet<string>, excludedColumns: NonNullable<ExportManifest['excluded_columns']>): Promise<ManifestFile[]> {
  // The table and its columns from pg_catalog (schema-qualified, no search_path).
  const [rel] = await tx<{ oid: number }[]>`
    SELECT c.oid::int AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind IN ('r', 'p')`
  if (!rel) throw new ExportError(`table ${schema}.${table} does not exist or has no columns`)
  const cols = await tx<{ name: string; pk: number | null }[]>`
    SELECT a.attname::text AS name, pg_catalog.array_position(i.indkey::int2[], a.attnum) AS pk
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
     WHERE a.attrelid = ${rel.oid} AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`
  if (cols.length === 0) throw new ExportError(`table ${schema}.${table} does not exist or has no columns`)
  // Deterministic order WITHOUT casting or comparing any value through code the
  // tenant could have defined (HIGH-1): the primary key (built-in btree
  // opclasses only; defining one needs a superuser), else the physical row
  // position, stable inside this repeatable-read snapshot.
  const pk = cols.filter((c) => c.pk !== null).sort((a, b) => a.pk! - b.pk!)
  const orderBy = pk.length > 0 ? pk.map((c) => quoteIdent(c.name)).join(', ') : 'ctid'
  for (const w of withheldColumns) if (!cols.some((c) => c.name === w)) throw new ExportError(`module ${scope}: runtime.export.withhold names ${schema}.${table}.${w}, which does not exist; fix the declaration (a renamed secret column must not slip into the export)`)
  for (const c of cols) if (withheldColumns.has(c.name)) excludedColumns.push({ scope, schema, table, column: c.name, reason: WITHHELD })
  const header = cols.map((c) => c.name).filter((c) => !withheldColumns.has(c))
  if (header.length === 0) throw new ExportError(`module ${scope}: every column of ${schema}.${table} is withheld; withhold the table instead`)
  const select = `SELECT ${header.map(quoteIdent).join(', ')} FROM ${quoteIdent(schema)}.${quoteIdent(table)} ORDER BY ${orderBy}`

  // Validated BEFORE anything touches the disk.
  const stem = fileStem(schema, table)
  const csvPath = insideOut(outDir, scope, `${stem}.csv`)
  const jsonPath = insideOut(outDir, scope, `${stem}.json`)
  mkdirSync(resolve(outDir, scope), { recursive: true, mode: 0o700 })
  const csv = openSink(csvPath)
  const json = openSink(jsonPath)
  let rows = 0
  try {
    json.write('[')
    csv.write(csvLine(header))
    // Values are the driver's rendering of the server's text output; no SQL cast.
    await tx.unsafe(select).cursor(BATCH, (batch) => {
      for (const row of batch) {
        csv.write(csvLine(header.map((c) => (row as Record<string, unknown>)[c])))
        json.write((rows === 0 ? '\n' : ',\n') + JSON.stringify(row, jsonReplacer))
        rows++
      }
    })
    json.write(rows === 0 ? ']\n' : '\n]\n')
  } catch (err) {
    csv.end()
    json.end()
    throw err
  }
  const c = csv.end()
  const j = json.end()
  return [
    { path: `${scope}/${stem}.csv`, scope, schema, table, format: 'csv', rows, bytes: c.bytes, sha256: c.sha256 },
    { path: `${scope}/${stem}.json`, scope, schema, table, format: 'json', rows, bytes: j.bytes, sha256: j.sha256 },
  ]
}

async function exportDatabase(
  sql: Sql,
  scope: string,
  tables: readonly string[] | 'all',
  outDir: string,
  excludedTables: ExportManifest['excluded_tables'],
  excludedColumns: NonNullable<ExportManifest['excluded_columns']>,
  withhold: readonly string[] = [],
): Promise<ManifestFile[]> {
  // MED-3: schema.table (whole table) or schema.table.column.
  const withheldTables = new Set<string>()
  const withheldColumns = new Map<string, Set<string>>()
  for (const w of withhold) {
    const parts = w.split('.')
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^[a-z_][a-z0-9_]{0,62}$/.test(p))) throw new ExportError(`module ${scope}: runtime.export.withhold entry ${JSON.stringify(w)} is not schema.table or schema.table.column`)
    const key = `${parts[0]}.${parts[1]}`
    if (parts.length === 2) withheldTables.add(key)
    else withheldColumns.set(key, (withheldColumns.get(key) ?? new Set()).add(parts[2]!))
  }
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    // HIGH-1: the catalogs first, before ANY query resolves an operator or a function through a search_path the tenant set.
    await tx.unsafe(`SET LOCAL search_path TO pg_catalog, pg_temp`)
    // HIGH-1: never read a tenant database as a superuser, or as a role that
    // can become one (tenant code can RESET ROLE to the session user).
    const [who] = await tx<{ session: string; current: string }[]>`SELECT session_user::text AS session, current_user::text AS current`
    for (const role of new Set([who!.session, who!.current])) {
      try {
        await assertNotSuperuserCapable(tx, role)
      } catch (err) {
        throw new ExportError(`${scope}: ${(err as Error).message}; connect as the export reader (ensureExportReader)`, { cause: err })
      }
    }
    let list: readonly { schema: string; table: string }[]
    if (tables === 'all') {
      // HIGH-2: every schema the module's migrations created (finance.*,
      // content.*, ...), not just public: ordinary and partitioned tables
      // (partitions are read through their parent), minus the system schemas
      // and tables that belong to an extension.
      const found = await tx<{ schema: string; table: string }[]>`
        SELECT n.nspname::text AS schema, c.relname::text AS table
          FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                            WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')
         ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`
      list = found.filter((t) => {
        if (t.schema === 'public' && t.table === LEDGER_TABLE) {
          excludedTables.push({ scope, schema: t.schema, table: t.table, reason: 'migration ledger (schema bookkeeping, not tenant data)' })
          return false
        }
        if (withheldTables.has(`${t.schema}.${t.table}`)) {
          excludedTables.push({ scope, schema: t.schema, table: t.table, reason: WITHHELD })
          return false
        }
        return true
      })
      // A declaration that names nothing is a mistake to see, not to skip.
      const present = new Set(found.map((t) => `${t.schema}.${t.table}`))
      for (const key of [...withheldTables, ...withheldColumns.keys()]) {
        if (!present.has(key)) throw new ExportError(`module ${scope}: runtime.export.withhold names ${key}, which does not exist; fix the declaration (a renamed secret must not slip into the export)`)
      }
      for (const key of withheldColumns.keys()) if (withheldTables.has(key)) throw new ExportError(`module ${scope}: runtime.export.withhold names both ${key} and a column of it`)
      // A module declared exportable that yields nothing is a failed export, not an empty one.
      if (list.length === 0) throw new ExportError(`module ${scope}: its database has no table in any schema; refusing to record it as exported`)
    } else {
      if (withhold.length > 0) throw new ExportError(`${scope}: withhold applies to module databases only`)
      list = tables.map((table) => ({ schema: 'public', table }))
    }
    const files: ManifestFile[] = []
    for (const t of list) files.push(...(await exportTable(tx, scope, t.schema, t.table, outDir, withheldColumns.get(`${t.schema}.${t.table}`) ?? new Set(), excludedColumns)))
    return files
  }) as Promise<ManifestFile[]>
}

export async function exportTenant(opts: ExportOptions): Promise<ExportResult> {
  if (!SLUG.test(opts.slug)) throw new ExportError(`not a tenant slug: ${JSON.stringify(opts.slug)}`)
  const ids = new Set<string>()
  for (const m of opts.modules) {
    if (!IDENT.test(m.id) || m.id === 'kernel' || ids.has(m.id)) throw new ExportError(`module id ${JSON.stringify(m.id)} is invalid or duplicated`)
    ids.add(m.id)
  }
  ensureEmptyPrivateDir(opts.outDir)

  const files: ManifestFile[] = []
  const excludedTables: ExportManifest['excluded_tables'] = KERNEL_EXCLUDED_TABLES.map((e) => ({ scope: 'kernel', schema: 'public', ...e }))
  const excludedColumns: NonNullable<ExportManifest['excluded_columns']> = []
  const modules: ExportManifest['modules'] = []
  const excludedSystems: ExportManifest['excluded_systems'] = ALWAYS_EXCLUDED_SYSTEMS.map((s) => ({ ...s }))

  files.push(...(await exportDatabase(opts.kernel, 'kernel', opts.kernelTables ?? KERNEL_EXPORT_TABLES, opts.outDir, excludedTables, excludedColumns)))

  for (const m of [...opts.modules].sort((a, b) => a.id.localeCompare(b.id))) {
    if (m.platformServer) {
      for (const d of m.platformServer.databases) {
        excludedSystems.push({ system: `${m.id}:${m.platformServer.postgresService}/${d}`, reason: 'platform-level server database shared across tenants (e.g. Matrix history); not a per-tenant database and not exported by this tool' })
      }
    }
    if (!m.runtimeExport) {
      modules.push({ id: m.id, status: 'excluded', reason: 'module.json declares no runtime.export (the module keeps no exportable database of its own)' })
    } else if (!m.enabled) {
      modules.push({ id: m.id, status: 'excluded', reason: 'module is not enabled for this tenant (no tenant database exists)' })
    } else if (!m.sql) {
      throw new ExportError(`module ${m.id} declares runtime.export and is enabled but no database connection was supplied`)
    } else {
      files.push(...(await exportDatabase(m.sql, m.id, 'all', opts.outDir, excludedTables, excludedColumns, m.runtimeExport.withhold ?? [])))
      modules.push({ id: m.id, status: 'exported' })
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const manifest: ExportManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    tenant: { slug: opts.slug },
    generated_at: (opts.now?.() ?? new Date()).toISOString(),
    files,
    modules,
    excluded_systems: excludedSystems,
    excluded_tables: excludedTables,
    excluded_columns: excludedColumns,
    csv_formula_guard: CSV_FORMULA_GUARD,
  }
  writeFileSync(join(opts.outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { manifest, verify: verifyExport(opts.outDir) }
}
