// services/kernel-api/src/registry/declarations.ts — the runtime declarations
// the registry serves (D10; PLAN L3-17 "the registry serves the validated
// runtime declarations of L3-06").
//
// The image carries modules/<key>/module.json (data only). The full validator
// (@gremion/module-catalogue validateModuleJson) needs the compose file, the
// module tree and the frozen extraction source, none of which the image
// carries, so it runs at TEST time over the same files (lane note C17); at
// boot this module only parses each file and checks what the registry relies
// on: id = directory, runtime.version a semver, the runtime block's shape.
// Any problem refuses the boot, naming it. Startup writes NOTHING (A1: the
// catalogue rows are loadCatalogueRows', read-only here).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ModuleRuntimeDecl {
  version: string
  database: { postgresService: string; migrations: string } | null
  export: { kind: 'pg_dump'; retentionProfile: string } | null
  timedJobs: { id: string; activeColourOnly: boolean }[]
  platformServer: { postgresService: string; databases: string[] } | null
}

/** plt.module_version semver CHECK, restated (0002_plt_module.sql). */
export const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]{1,40})?$/
/** plt.module module_key CHECK, restated. */
export const MODULE_KEY = /^[a-z][a-z_]{1,39}$/

export class DeclarationError extends Error {
  override name = 'DeclarationError'
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function shapeProblems(id: string, r: unknown): string[] {
  const p: string[] = []
  if (!isRecord(r)) return [`${id}: module.json has no runtime block`]
  const keys = Object.keys(r).sort().join(',')
  if (keys !== 'database,export,platformServer,timedJobs,version') p.push(`${id}: runtime keys are [${keys}], want exactly database, export, platformServer, timedJobs, version`)
  if (typeof r.version !== 'string' || !SEMVER.test(r.version)) p.push(`${id}: runtime.version ${JSON.stringify(r.version)} is not a semver plt.module_version accepts`)
  if (r.database !== null && !(isRecord(r.database) && typeof r.database.postgresService === 'string' && typeof r.database.migrations === 'string')) p.push(`${id}: runtime.database is neither null nor {postgresService, migrations}`)
  if (r.export !== null && !(isRecord(r.export) && r.export.kind === 'pg_dump' && typeof r.export.retentionProfile === 'string')) p.push(`${id}: runtime.export is neither null nor {kind: pg_dump, retentionProfile}`)
  if (!Array.isArray(r.timedJobs) || !r.timedJobs.every((j) => isRecord(j) && typeof j.id === 'string' && typeof j.activeColourOnly === 'boolean')) p.push(`${id}: runtime.timedJobs is not a list of {id, activeColourOnly}`)
  if (r.platformServer !== null && !(isRecord(r.platformServer) && typeof r.platformServer.postgresService === 'string' && Array.isArray(r.platformServer.databases))) p.push(`${id}: runtime.platformServer is neither null nor {postgresService, databases}`)
  return p
}

/**
 * Every modules/<dir>/module.json under `root`, parsed and shape-checked,
 * keyed by module key. A directory without module.json is skipped only when
 * it is not a module directory at all (no plain files count); zero modules is
 * a refusal (the registry would serve nothing, vacuously).
 */
export function loadDeclarations(root: string): Map<string, ModuleRuntimeDecl> {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new DeclarationError(`modules root ${root} is not a directory`)
  const out = new Map<string, ModuleRuntimeDecl>()
  const problems: string[] = []
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, 'module.json')
    if (!existsSync(file)) {
      problems.push(`${name}/: no module.json`)
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      problems.push(`${name}/module.json: not JSON (${(err as Error).message})`)
      continue
    }
    if (!isRecord(json) || json.id !== name) {
      problems.push(`${name}/module.json: id ${JSON.stringify(isRecord(json) ? json.id : undefined)} differs from its directory`)
      continue
    }
    if (!MODULE_KEY.test(name)) {
      problems.push(`${name}: not a plt.module module_key`)
      continue
    }
    const shape = shapeProblems(name, json.runtime)
    if (shape.length) {
      problems.push(...shape)
      continue
    }
    out.set(name, json.runtime as ModuleRuntimeDecl)
  }
  if (problems.length) throw new DeclarationError(`module declarations refused: ${problems.join('; ')}`)
  if (out.size === 0) throw new DeclarationError(`no module declaration under ${root}: the registry would serve nothing`)
  return out
}
