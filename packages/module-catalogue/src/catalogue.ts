// packages/module-catalogue/src/catalogue.ts
//
// The catalogue is the set of module DIRECTORIES under a modules root, each
// carrying a module.json. One entry per directory, not per file found: a
// directory with no module.json is a problem, never a skip (the same rule as
// scripts/check-extraction-source.mjs's collector); a plain file beside the
// directories (disabled.json, COUPLED-TESTS.json, ...) is not a module.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KERNEL_ROOT } from '../../../scripts/lib/extraction-source.mjs'
import { readCompose } from './compose.ts'
import type { CatalogueEntry, ComposeModel, ModuleJson } from './runtime.ts'
import { checkClaims, validateModuleJson, type ContractsRegistry } from './validate.ts'

export { KERNEL_ROOT }

export interface Catalogue {
  root: string
  /** Every module directory whose module.json parsed, in directory order. */
  modules: CatalogueEntry[]
  /** Module directories found (with or without a module.json). */
  directories: number
  problems: string[]
}

/** Reads the root. Does not validate the declarations (checkCatalogue does). */
export function loadCatalogue(root: string): Catalogue {
  const abs = resolve(root)
  const out: Catalogue = { root: abs, modules: [], directories: 0, problems: [] }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    out.problems.push(`modules root ${abs} is not a directory — nothing could be read and the check would pass vacuously`)
    return out
  }
  for (const name of readdirSync(abs).sort()) {
    const dir = join(abs, name)
    let isDir: boolean
    try {
      isDir = statSync(dir).isDirectory()
    } catch (err) {
      out.problems.push(`${name}: unreadable — ${(err as Error).message}`)
      continue
    }
    if (!isDir) continue
    out.directories++
    const file = join(dir, 'module.json')
    if (!existsSync(file)) {
      out.problems.push(`${name}/: no module.json — every directory under the modules root is a module and must declare one`)
      continue
    }
    let moduleJson: unknown
    try {
      moduleJson = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      out.problems.push(`${name}/module.json: not parseable JSON — ${(err as Error).message}`)
      continue
    }
    out.modules.push({ id: name, dir, moduleJson: moduleJson as ModuleJson })
  }
  if (out.directories === 0) out.problems.push(`no module directory under ${abs} — the check would pass vacuously`)
  return out
}

export interface CheckOptions {
  compose?: ComposeModel
  /** Used when `compose` is not given. Default: the kernel's docker-compose.yml. */
  composePath?: string
  frozenExtractionSource?: string
  contracts?: ContractsRegistry
}

export interface CheckResult extends Catalogue {
  /** Modules whose module.json passed validateModuleJson. */
  valid: number
}

/**
 * loadCatalogue + validateModuleJson per module + checkClaims across the
 * catalogue (the claim rule runs only over a catalogue whose every module
 * validated, so one broken file cannot make a server look unclaimed).
 */
export function checkCatalogue(root: string, opts: CheckOptions = {}): CheckResult {
  const cat = loadCatalogue(root)
  const compose = opts.compose ?? readCompose(opts.composePath ?? join(KERNEL_ROOT, 'docker-compose.yml'))
  let valid = 0
  const problems = [...cat.problems]
  for (const m of cat.modules) {
    const own = validateModuleJson(m.moduleJson, {
      id: m.id,
      dir: m.dir,
      compose,
      ...(opts.frozenExtractionSource === undefined ? {} : { frozenExtractionSource: opts.frozenExtractionSource }),
      ...(opts.contracts === undefined ? {} : { contracts: opts.contracts }),
    })
    if (own.length === 0) valid++
    problems.push(...own)
  }
  if (problems.length === 0) problems.push(...checkClaims(cat.modules, compose))
  return { ...cat, problems, valid }
}
