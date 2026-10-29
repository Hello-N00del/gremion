// packages/module-catalogue/src/validate.ts
//
// THE module.json validator (spec D D.1.2: exactly one). It returns named
// problems (string[]), never throws on bad input, and re-implements neither
// neighbour check it relies on:
//   - extractionSource agreement: checkExtractionSourceAgreement, imported
//     from scripts/lib/extraction-source.mjs (that file names this validator
//     as its importer);
//   - a `contracts` block: TASK-030's validateModuleContracts.
//
// Under-declaration is judged from the TREE, not from the file alone: a
// migrations/manifest.json on disk with runtime.database null is refused,
// and every declared server must be a compose service labelled
// org.gremion.postgres=module:* (checkClaims adds the catalogue-wide
// one-claim rule).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadApiVersions, validateModuleContracts, type ModuleContractDeclaration } from '@gremion/generated-clients/module-contracts'
import { loadRegistry, type RegistryEntry } from '@gremion/generated-clients/registry'
import { checkExtractionSourceAgreement, KERNEL_ROOT, readFrozenExtractionSource } from '../../../scripts/lib/extraction-source.mjs'
import { POSTGRES_LABEL, serverDefaultDatabase, SERVER_BUILTIN_DATABASES, type CatalogueEntry, type ComposeModel } from './runtime.ts'

/** names.ts MODULE_ID (D13): the separator in t_<hex>__<module> stays unambiguous. */
export const NAMES_MODULE_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** SCHEMA module_module_key_check (plt.module.module_key). */
export const SCHEMA_MODULE_KEY = /^[a-z][a-z_]{1,39}$/
/** t_ + 32 hex + __ = 36 bytes; tenantModuleDbName stays within NAMEDATALEN - 1 = 63. */
export const MAX_MODULE_ID_BYTES = 27
/** SCHEMA module_version_semver_check. */
export const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,40})?$/
/** SCHEMA module_version_retention_profile_default_id_check. */
export const RETENTION_PROFILE = /^rp-[a-z]+-[a-z0-9-]+$/
/** Amendment R27 item 3. */
export const PLATFORM_DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/
const JOB_ID = /^[a-z][a-z0-9-]{0,62}$/
const MIGRATIONS_DIR = /^[a-z][a-z0-9_-]{0,62}$/
const RUNTIME_KEYS = ['version', 'database', 'export', 'timedJobs', 'platformServer'] as const
const EXPORT_KEYS: readonly string[] = ['kind', 'retentionProfile', 'withhold']
/** runtime.export.withhold entries (MED-3): schema.table or schema.table.column, plain identifiers. */
export const WITHHOLD_ENTRY = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}(?:\.[a-z_][a-z0-9_]{0,62})?$/

export interface ContractsRegistry {
  registry: RegistryEntry[]
  apiVersions: Map<string, string>
}

export interface ValidateContext {
  /** The module directory's name. */
  id: string
  /** Absolute path of the module directory (the tree the declaration is judged against). */
  dir: string
  compose: ComposeModel
  /** Defaults to readFrozenExtractionSource() (docs/ops/extraction-source.md). */
  frozenExtractionSource?: string
  /** Defaults to contracts/registry.json of the kernel tree, read only when a contracts block is present. */
  contracts?: ContractsRegistry
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v)))

let kernelContracts: ContractsRegistry | undefined
function defaultContracts(): ContractsRegistry {
  if (!kernelContracts) {
    const registry = loadRegistry(KERNEL_ROOT)
    kernelContracts = { registry, apiVersions: loadApiVersions(KERNEL_ROOT, registry) }
  }
  return kernelContracts
}

function isModuleServer(compose: ComposeModel, service: unknown): boolean {
  if (typeof service !== 'string') return false
  const label = compose.services.get(service)?.postgresLabel
  return typeof label === 'string' && /^module:[a-z][a-z0-9_-]*$/.test(label)
}

function checkId(p: string[], where: string, id: unknown): void {
  if (typeof id !== 'string') {
    p.push(`${where}: id ${show(id)} is not a string`)
    return
  }
  if (!NAMES_MODULE_ID.test(id)) p.push(`${where}: id ${show(id)} must match ${NAMES_MODULE_ID.source} (names.ts MODULE_ID, D13)`)
  if (!SCHEMA_MODULE_KEY.test(id)) p.push(`${where}: id ${show(id)} must match ${SCHEMA_MODULE_KEY.source} (SCHEMA module_module_key_check)`)
  const bytes = Buffer.byteLength(id, 'utf8')
  if (bytes > MAX_MODULE_ID_BYTES) p.push(`${where}: id ${show(id)} is ${bytes} bytes; at most ${MAX_MODULE_ID_BYTES}, or t_<hex32>__<id> exceeds 63 bytes`)
}

function checkServer(p: string[], where: string, field: string, service: unknown, compose: ComposeModel): void {
  if (typeof service !== 'string' || service === '') {
    p.push(`${where}: ${field} must be a compose service name`)
  } else if (!isModuleServer(compose, service)) {
    p.push(`${where}: ${field} ${service} is not a compose service labelled ${POSTGRES_LABEL}=module:*`)
  }
}

/**
 * Every problem with one module.json, judged against its directory and the
 * compose file. [] means valid. Pure: no database, no network; the only I/O is
 * reading the tree under ctx.dir (and, for a contracts block, the registry).
 */
export function validateModuleJson(json: unknown, ctx: ValidateContext): string[] {
  const where = ctx.id
  if (!isRecord(json)) return [`${where}: module.json is not a JSON object`]
  const p: string[] = []
  if (json.schemaVersion !== 1) p.push(`${where}: schemaVersion must be 1 (got ${show(json.schemaVersion)})`)
  checkId(p, where, json.id)
  if (typeof json.id === 'string' && json.id !== ctx.id) p.push(`${where}: module.json id ${show(json.id)} differs from its directory name ${ctx.id}`)

  const frozen = ctx.frozenExtractionSource ?? readFrozenExtractionSource()
  for (const problem of checkExtractionSourceAgreement(
    [{ id: ctx.id, path: `${ctx.id}/module.json`, extractionSource: json.extractionSource, parseError: null }],
    frozen,
  )) {
    p.push(problem)
  }

  const onDisk = existsSync(join(ctx.dir, 'migrations', 'manifest.json'))
  const r = json.runtime
  if (!isRecord(r)) {
    p.push(`${where}: module.json has no runtime block`)
    if (onDisk) p.push(`${where}: migrations/manifest.json is on disk but runtime.database is not declared`)
    return p
  }
  for (const key of RUNTIME_KEYS) if (!(key in r)) p.push(`${where}: runtime.${key} is missing (declare it; null or [] where it does not apply)`)
  for (const key of Object.keys(r)) if (!(RUNTIME_KEYS as readonly string[]).includes(key)) p.push(`${where}: runtime.${key} is not a runtime field (${RUNTIME_KEYS.join(', ')})`)

  if ('version' in r && (typeof r.version !== 'string' || !SEMVER.test(r.version))) {
    p.push(`${where}: runtime.version ${show(r.version)} is not a semver (SCHEMA module_version_semver_check)`)
  }

  // database
  const database = r.database
  let dbService: string | undefined
  if (database === null || database === undefined) {
    if (onDisk) p.push(`${where}: migrations/manifest.json is on disk but runtime.database is null — the module under-declares its database`)
  } else if (!isRecord(database)) {
    p.push(`${where}: runtime.database must be null or {postgresService, migrations}`)
  } else {
    checkServer(p, where, 'runtime.database.postgresService', database.postgresService, ctx.compose)
    if (typeof database.postgresService === 'string') dbService = database.postgresService
    const mig = database.migrations
    if (typeof mig !== 'string' || !MIGRATIONS_DIR.test(mig)) {
      p.push(`${where}: runtime.database.migrations ${show(mig)} must be a plain directory name`)
    } else if (!existsSync(join(ctx.dir, mig, 'manifest.json'))) {
      p.push(`${where}: runtime.database.migrations names ${mig}/manifest.json, which is not on disk`)
    }
    for (const key of Object.keys(database)) if (key !== 'postgresService' && key !== 'migrations') p.push(`${where}: runtime.database.${key} is not a database field`)
  }

  // export
  const exp = r.export
  if (exp === null || exp === undefined) {
    if (isRecord(database)) p.push(`${where}: runtime.database is declared but runtime.export is null — a database must declare how it is exported before a drop (TRD-424)`)
  } else if (!isRecord(exp)) {
    p.push(`${where}: runtime.export must be null or {kind, retentionProfile}`)
  } else {
    if (!isRecord(database)) p.push(`${where}: runtime.export is declared but runtime.database is null — there is nothing to export`)
    if (exp.kind !== 'pg_dump') p.push(`${where}: runtime.export.kind ${show(exp.kind)} must be "pg_dump"`)
    if (typeof exp.retentionProfile !== 'string' || !RETENTION_PROFILE.test(exp.retentionProfile)) {
      p.push(`${where}: runtime.export.retentionProfile ${show(exp.retentionProfile)} must match ${RETENTION_PROFILE.source} (DB-OPS-RETENTION-PROFILE)`)
    }
    for (const key of Object.keys(exp)) if (!EXPORT_KEYS.includes(key)) p.push(`${where}: runtime.export.${key} is not an export field (${EXPORT_KEYS.join(', ')})`)
    // MED-3: secrets the open-format tenant export leaves out (schema.table or schema.table.column).
    if ('withhold' in exp) {
      if (!Array.isArray(exp.withhold)) {
        p.push(`${where}: runtime.export.withhold must be a list of schema.table or schema.table.column`)
      } else {
        const seen = new Set<string>()
        exp.withhold.forEach((w: unknown, i: number) => {
          if (typeof w !== 'string' || !WITHHOLD_ENTRY.test(w)) p.push(`${where}: runtime.export.withhold[${i}] ${show(w)} must match ${WITHHOLD_ENTRY.source} (schema.table or schema.table.column)`)
          else if (seen.has(w)) p.push(`${where}: runtime.export.withhold[${i}] ${show(w)} is declared twice`)
          else seen.add(w)
        })
      }
    }
  }

  // timedJobs
  if ('timedJobs' in r) {
    if (!Array.isArray(r.timedJobs)) {
      p.push(`${where}: runtime.timedJobs must be a list (use [] for none)`)
    } else {
      const seen = new Set<string>()
      r.timedJobs.forEach((j: unknown, i: number) => {
        const job = isRecord(j) ? j : {}
        if (typeof job.id !== 'string' || !JOB_ID.test(job.id)) p.push(`${where}: runtime.timedJobs[${i}].id ${show(job.id)} must match ${JOB_ID.source}`)
        else if (seen.has(job.id)) p.push(`${where}: runtime.timedJobs[${i}].id ${show(job.id)} is declared twice`)
        else seen.add(job.id)
        if (typeof job.activeColourOnly !== 'boolean') p.push(`${where}: runtime.timedJobs[${i}].activeColourOnly must be true or false`)
      })
    }
  }

  // platformServer (Amendment R27)
  const ps = r.platformServer
  if (ps !== null && ps !== undefined) {
    if (!isRecord(ps)) {
      p.push(`${where}: runtime.platformServer must be null or {postgresService, databases}`)
    } else {
      checkServer(p, where, 'runtime.platformServer.postgresService', ps.postgresService, ctx.compose)
      const svc = typeof ps.postgresService === 'string' ? ctx.compose.services.get(ps.postgresService) : undefined
      const initDb = svc ? serverDefaultDatabase(svc) : undefined
      if (dbService !== undefined && typeof ps.postgresService === 'string' && ps.postgresService !== dbService) {
        p.push(`${where}: runtime.database.postgresService ${dbService} and runtime.platformServer.postgresService ${ps.postgresService} differ — a module has one server (D14); both fields must name the same service`)
      }
      if (!Array.isArray(ps.databases) || ps.databases.length === 0) {
        p.push(`${where}: runtime.platformServer.databases must be a non-empty list`)
      } else {
        const seen = new Set<string>()
        ps.databases.forEach((d: unknown, i: number) => {
          const at = `${where}: runtime.platformServer.databases[${i}] ${show(d)}`
          if (typeof d !== 'string' || !PLATFORM_DATABASE_NAME.test(d)) p.push(`${at} must match ${PLATFORM_DATABASE_NAME.source}`)
          else if (d.startsWith('t_')) p.push(`${at} begins with t_ — it could mask a tenantModuleDbName (t_<hex32>__<id>)`)
          else if ((SERVER_BUILTIN_DATABASES as readonly string[]).includes(d)) p.push(`${at} is a server built-in, already in the closed list`)
          else if (d === initDb) p.push(`${at} is ${String(ps.postgresService)}'s POSTGRES_USER default database, already in the closed list`)
          else if (seen.has(d)) p.push(`${at} is declared twice`)
          if (typeof d === 'string') seen.add(d)
        })
      }
      for (const key of Object.keys(ps)) if (key !== 'postgresService' && key !== 'databases') p.push(`${where}: runtime.platformServer.${key} is not a platformServer field`)
    }
  }

  // contracts (TASK-030), only where present
  if ('contracts' in json) {
    const c = json.contracts
    if (!isRecord(c)) {
      p.push(`${where}: contracts must be an object (a module contract declaration)`)
    } else {
      if (c.module !== ctx.id) p.push(`${where}: contracts.module ${show(c.module)} differs from the module id ${ctx.id}`)
      const reg = ctx.contracts ?? defaultContracts()
      for (const problem of validateModuleContracts(c as unknown as ModuleContractDeclaration, reg.registry, reg.apiVersions)) p.push(`${where}: contracts: ${problem}`)
    }
  }
  return p
}

/**
 * The catalogue-wide half of the compose cross-check: every compose service
 * labelled org.gremion.postgres=module:* is claimed by exactly one module,
 * through runtime.database or runtime.platformServer (Amendment R27 item 3:
 * the rule counts MODULES, so one module naming a server through both fields
 * claims it once).
 */
export function checkClaims(entries: readonly Pick<CatalogueEntry, 'id' | 'moduleJson'>[], compose: ComposeModel): string[] {
  const claims = new Map<string, Set<string>>()
  for (const m of entries) {
    const r = m.moduleJson.runtime
    for (const svc of [r.database?.postgresService, r.platformServer?.postgresService]) {
      if (typeof svc !== 'string') continue
      if (!claims.has(svc)) claims.set(svc, new Set())
      claims.get(svc)?.add(m.id)
    }
  }
  const p: string[] = []
  for (const [name, svc] of [...compose.services.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const label = svc.postgresLabel
    if (label === null || !label.startsWith('module:')) continue
    const by = [...(claims.get(name) ?? [])].sort()
    if (by.length === 0) p.push(`${name} is labelled ${POSTGRES_LABEL}=${label} but no module.json claims it (runtime.database or runtime.platformServer)`)
    else if (by.length > 1) p.push(`${name} is claimed by two or more modules: ${by.join(', ')}`)
  }
  return p
}
