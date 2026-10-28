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
//            pg_dump) AND is enabled for the tenant: every base table of the
//            tenant's module database except the migration ledger. A module
//            with runtime.export null is listed under excluded, with the
//            reason; so are Nextcloud files and Matrix history, which live
//            outside Postgres and are not exported by this tool.
// Every database is read in ONE repeatable-read, read-only transaction, so a
// table pair is consistent. Output: directory 0700, files 0600, never into a
// directory that already has content.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type postgres from 'postgres'
import { csvLine, jsonReplacer } from './csv.js'
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
  /** module.json runtime.export (null when the module declares none). */
  runtimeExport: { kind: string; retentionProfile: string } | null
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

function quote(id: string): string {
  if (!IDENT.test(id)) throw new ExportError(`refusing identifier ${JSON.stringify(id)}`)
  return `"${id}"`
}

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

async function exportTable(tx: postgres.TransactionSql, scope: string, table: string, outDir: string): Promise<ManifestFile[]> {
  mkdirSync(join(outDir, scope), { recursive: true, mode: 0o700 })
  const csv = openSink(join(outDir, scope, `${table}.csv`))
  const json = openSink(join(outDir, scope, `${table}.json`))
  let rows = 0
  try {
    json.write('[')
    // Deterministic order: the primary key columns are not known here, so order by every column's text.
    const cols = await tx.unsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
    if (cols.length === 0) throw new ExportError(`table public.${table} does not exist or has no columns`)
    const header = cols.map((c) => c.column_name)
    csv.write(csvLine(header))
    await tx.unsafe(`SELECT * FROM public.${quote(table)} ORDER BY ${header.map((c) => `"${c.replaceAll('"', '""')}"::text`).join(', ')}`).cursor(BATCH, (batch) => {
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
    { path: `${scope}/${table}.csv`, scope, table, format: 'csv', rows, bytes: c.bytes, sha256: c.sha256 },
    { path: `${scope}/${table}.json`, scope, table, format: 'json', rows, bytes: j.bytes, sha256: j.sha256 },
  ]
}

async function exportDatabase(sql: Sql, scope: string, tables: readonly string[] | 'all', outDir: string, excludedTables: ExportManifest['excluded_tables']): Promise<ManifestFile[]> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    let list: readonly string[]
    if (tables === 'all') {
      const found = await tx<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      list = found.map((r) => r.table_name).filter((t) => {
        if (t === LEDGER_TABLE) {
          excludedTables.push({ scope, table: t, reason: 'migration ledger (schema bookkeeping, not tenant data)' })
          return false
        }
        return true
      })
    } else {
      list = tables
    }
    const files: ManifestFile[] = []
    for (const t of list) files.push(...(await exportTable(tx, scope, t, outDir)))
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
  const excludedTables: ExportManifest['excluded_tables'] = KERNEL_EXCLUDED_TABLES.map((e) => ({ scope: 'kernel', ...e }))
  const modules: ExportManifest['modules'] = []
  const excludedSystems: ExportManifest['excluded_systems'] = ALWAYS_EXCLUDED_SYSTEMS.map((s) => ({ ...s }))

  files.push(...(await exportDatabase(opts.kernel, 'kernel', opts.kernelTables ?? KERNEL_EXPORT_TABLES, opts.outDir, excludedTables)))

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
      files.push(...(await exportDatabase(m.sql, m.id, 'all', opts.outDir, excludedTables)))
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
  }
  writeFileSync(join(opts.outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { manifest, verify: verifyExport(opts.outDir) }
}
