// packages/module-catalogue/src/runtime.ts
//
// The module.json runtime block (TASK-021 Q1 + Amendment R27) and the ops facts
// DERIVED from it. Nothing here is hand-maintained: the backup server list, the
// colour-gated job list and each server's closed list of platform databases
// are computed from the catalogue (the module.json files) and the compose
// file, so removing a module removes its server, jobs and databases with no
// kernel edit (G-D17, TRD-424).
//
// This file has NO relative import and no dependency: @gremion/tenant-store's
// lifecycle imports it (`@gremion/module-catalogue/runtime`) and type-checks
// it under its own compiler flags.

/** The kernel's own PostgreSQL service. gremion-backup's postgres_services() defaults to it. */
export const KERNEL_POSTGRES_SERVICE = 'postgres'

/** The compose label every PostgreSQL server carries (TASK-019): `kernel` or `module:<id>`. */
export const POSTGRES_LABEL = 'org.gremion.postgres'

/** Databases every PostgreSQL server holds from initdb on. */
export const SERVER_BUILTIN_DATABASES = ['postgres', 'template0', 'template1'] as const

/**
 * Q6: the kernel server's closed list of platform (non-customer) databases:
 * the built-ins, keycloak, the legacy gremion and control databases
 * (init-databases.sh) and gremion_platform (SCHEMA §0.1). A closed list,
 * never a `t_` prefix filter: anything else on the server must be a
 * (customer, module) or customer kernel database, or it is an extra.
 */
export const KERNEL_PLATFORM_DATABASES = ['postgres', 'template0', 'template1', 'keycloak', 'gremion', 'control', 'gremion_platform'] as const

export interface DatabaseDecl {
  /** A compose service labelled org.gremion.postgres=module:*. */
  postgresService: string
  /** The module's migrations directory (relative, holding manifest.json). */
  migrations: string
}

export interface ExportDecl {
  kind: 'pg_dump'
  /** DB-OPS-RETENTION-PROFILE id, ^rp-[a-z]+-[a-z0-9-]+$. */
  retentionProfile: string
  /**
   * MED-3: what the open-format tenant export (TRD-149) leaves out, as
   * schema.table (the whole table) or schema.table.column: tokens, ciphertexts,
   * credentials. Recorded in the manifest under excluded_tables /
   * excluded_columns. The pg_dump before a drop (TRD-424) is unaffected.
   */
  withhold?: string[]
}

export interface TimedJob {
  id: string
  activeColourOnly: boolean
}

/** Amendment R27: a module server that holds only platform databases (messaging's synapse). */
export interface PlatformServerDecl {
  postgresService: string
  databases: string[]
}

export interface ModuleRuntime {
  version: string
  database: DatabaseDecl | null
  export: ExportDecl | null
  timedJobs: TimedJob[]
  platformServer: PlatformServerDecl | null
}

export interface ModuleJson {
  schemaVersion: 1
  id: string
  extractionSource: string
  runtime: ModuleRuntime
  contracts?: unknown
}

/** One validated module of the catalogue. */
export interface CatalogueEntry {
  id: string
  /** Absolute path of modules/<id>. */
  dir: string
  moduleJson: ModuleJson
}

/** The parts of one compose service the catalogue reads. */
export interface ComposeService {
  name: string
  /** The org.gremion.postgres label value, or null. */
  postgresLabel: string | null
  /**
   * environment, with ${VAR:-default} / ${VAR-default} resolved to the
   * default; a value with no default (${VAR}, ${VAR:?msg}) is undefined.
   */
  env: Readonly<Record<string, string | undefined>>
}

export interface ComposeModel {
  services: ReadonlyMap<string, ComposeService>
}

type EntryLike = Pick<CatalogueEntry, 'id' | 'moduleJson'>

/**
 * The database a server's entrypoint creates at init: POSTGRES_DB, else
 * POSTGRES_USER, else `postgres` (the postgres image's rule).
 */
export function serverDefaultDatabase(svc: ComposeService): string {
  return svc.env.POSTGRES_DB ?? svc.env.POSTGRES_USER ?? 'postgres'
}

/**
 * The closed list of platform databases on `service`: never a (customer,
 * module) database. Kernel server: KERNEL_PLATFORM_DATABASES plus its init
 * database. Module server: the built-ins, its init database, and every
 * runtime.platformServer.databases a module declares for it (Amendment R27
 * item 4). Sorted, unique. Throws for a service compose does not carry or
 * one without the label: an unknown server has no list to fall back on.
 */
export function platformDatabases(service: string, opts: { compose: ComposeModel; catalogue: readonly EntryLike[] }): string[] {
  const svc = opts.compose.services.get(service)
  if (!svc) throw new Error(`no compose service ${service}`)
  const label = svc.postgresLabel
  if (label === null) throw new Error(`${service} carries no ${POSTGRES_LABEL} label: it is not a PostgreSQL server of this installation`)
  const out = new Set<string>([serverDefaultDatabase(svc)])
  if (label === 'kernel') {
    for (const d of KERNEL_PLATFORM_DATABASES) out.add(d)
  } else if (label.startsWith('module:')) {
    for (const d of SERVER_BUILTIN_DATABASES) out.add(d)
    for (const m of opts.catalogue) {
      const ps = m.moduleJson.runtime.platformServer
      if (ps && ps.postgresService === service) for (const d of ps.databases) out.add(d)
    }
  } else {
    throw new Error(`${service} carries ${POSTGRES_LABEL}=${label}, neither kernel nor module:<id>`)
  }
  return [...out].sort()
}

/**
 * BACKUP_POSTGRES_SERVICES, derived: the kernel server first, then each
 * runtime.database.postgresService, then each runtime.platformServer
 * .postgresService not already listed, in catalogue order (Amendment R27
 * item 5). A module removed from the catalogue drops out.
 */
export function deriveBackupServices(catalogue: readonly EntryLike[]): string[] {
  const out: string[] = [KERNEL_POSTGRES_SERVICE]
  for (const m of catalogue) {
    const svc = m.moduleJson.runtime.database?.postgresService
    if (svc !== undefined && !out.includes(svc)) out.push(svc)
  }
  for (const m of catalogue) {
    const svc = m.moduleJson.runtime.platformServer?.postgresService
    if (svc !== undefined && !out.includes(svc)) out.push(svc)
  }
  return out
}

/** The jobs that run on the active colour only, in catalogue order (the colour policy). */
export function deriveColourGatedJobs(catalogue: readonly EntryLike[]): string[] {
  const out: string[] = []
  for (const m of catalogue) for (const j of m.moduleJson.runtime.timedJobs) if (j.activeColourOnly) out.push(j.id)
  return out
}

export interface CatalogueOps {
  backupPostgresServices: string[]
  colourGatedJobs: string[]
  /** service -> its closed platformDatabases list, for every server in backupPostgresServices. */
  platformDatabases: Record<string, string[]>
}

/** The three derived facts in one artefact (`bin/check.mjs --emit-ops`). */
export function buildCatalogueOps(catalogue: readonly EntryLike[], compose: ComposeModel): CatalogueOps {
  const backupPostgresServices = deriveBackupServices(catalogue)
  const platform: Record<string, string[]> = {}
  for (const svc of backupPostgresServices) platform[svc] = platformDatabases(svc, { compose, catalogue })
  return { backupPostgresServices, colourGatedJobs: deriveColourGatedJobs(catalogue), platformDatabases: platform }
}
