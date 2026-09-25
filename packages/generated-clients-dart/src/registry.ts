// packages/generated-clients-dart/src/registry.ts
//
// Surface discovery for the Dart clients, read from contracts/registry.json on
// every run. A deliberate departure from the TS sibling's hand-maintained
// GENERATED_CLIENTS table (packages/generated-clients/src/codegen.ts): a new
// OpenAPI surface registered by any lane gets a Dart client (and a failing
// check until it has one) without anyone remembering to edit a table here.
//
// Read-only on the registry and self-contained: packages/generated-clients is
// read as a pattern, never imported. Registry VALIDITY (files on disk,
// duplicates, unregistered specs) stays that package's contracts:check job;
// this module only refuses what it cannot classify, so nothing is dropped
// silently.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.ts'

/** Every staging dir (generator in/out, fixture trees, the Docker pub cache)
 *  lives here, gitignored — never os.tmpdir() (brief §9). */
export const SCRATCH_ROOT = join(REPO_ROOT, 'packages', 'generated-clients-dart', '.gen-work')

export const DART_PACKAGES_DIR = 'packages/generated-clients-dart'

export interface DartSurface {
  /** registry `name`, also the package directory name */
  name: string
  /** repo-root-relative spec path */
  specFile: string
  /** repo-root-relative package directory, packages/generated-clients-dart/<name> */
  packageDir: string
  /** pub package name, gremion_<name_snake>_client */
  pubName: string
}

const SURFACE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** The Node write/check side that shares packages/generated-clients-dart/
 *  with the surface packages. A surface may not take one of these names (the
 *  writer would sync generated output over the tooling), and every other
 *  top-level entry there must be a registered surface. */
export const NODE_SIDE = new Set(['.gitignore', 'README.md', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'src', 'tools', 'node_modules', '.gen-work'])

/** No vocabulary is defined upstream (contracts/README.md, TASK-030's
 *  validator only requires a non-empty string), so this one is closed: an
 *  unknown or mistyped status ("Active", "beta") throws rather than silently
 *  dropping an OpenAPI surface from codegen. Only `active` gets a client. */
export const KNOWN_STATUSES = new Set(['active', 'draft', 'deprecated', 'retired'])

export function pubNameFor(registryName: string): string {
  return `gremion_${registryName.replace(/-/g, '_')}_client`
}

function toSurface(name: string, specFile: string): DartSurface {
  return { name, specFile, packageDir: `${DART_PACKAGES_DIR}/${name}`, pubName: pubNameFor(name) }
}

/** `surfaces`: the entries that get a Dart client (type openapi, status
 *  active). `allOpenApi`: every registered OpenAPI spec whatever its status,
 *  for the out-of-package hand-written-client scan. Throws on anything it
 *  cannot classify — an entry it skipped would be a surface silently left
 *  without a client. */
export function loadDartSurfaces(repoRoot: string): { surfaces: DartSurface[]; allOpenApi: DartSurface[] } {
  const registryPath = join(repoRoot, 'contracts', 'registry.json')
  if (!existsSync(registryPath)) throw new Error(`contracts/registry.json does not exist at ${registryPath}`)
  let raw: { specs?: unknown }
  try {
    raw = JSON.parse(readFileSync(registryPath, 'utf8')) as { specs?: unknown }
  } catch (e) {
    throw new Error(`contracts/registry.json is not valid JSON: ${(e as Error).message}`)
  }
  if (!Array.isArray(raw.specs)) throw new Error('contracts/registry.json "specs" is missing or not an array')

  const surfaces: DartSurface[] = []
  const allOpenApi: DartSurface[] = []
  for (const [i, item] of raw.specs.entries()) {
    const e = (item ?? {}) as Record<string, unknown>
    const { name, type, file, status } = e
    const where = `contracts/registry.json specs[${i}] (${String(name)})`
    if (typeof name !== 'string' || typeof file !== 'string') throw new Error(`${where}: "name" and "file" must be strings`)
    if (type !== 'openapi' && type !== 'asyncapi') throw new Error(`${where}: "type" must be "openapi" or "asyncapi", got ${JSON.stringify(type)}`)
    if (typeof status !== 'string' || status.length === 0) throw new Error(`${where}: missing "status"`)
    if (!KNOWN_STATUSES.has(status)) throw new Error(`${where}: status "${status}" is not one of ${[...KNOWN_STATUSES].join(', ')} — refusing to guess whether it gets a Dart client`)
    // The type decides codegen AND the hand-client scan, so it must agree
    // with the document itself.
    const specPath = join(repoRoot, file)
    if (!existsSync(specPath)) throw new Error(`${where}: "${file}" does not exist`)
    let docKind: string
    try {
      const doc = JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>
      docKind = 'openapi' in doc ? 'openapi' : 'asyncapi' in doc ? 'asyncapi' : 'neither'
    } catch (e) {
      throw new Error(`${where}: "${file}" is not valid JSON (JSON specs only): ${(e as Error).message}`)
    }
    if (docKind !== type) throw new Error(`${where}: registered as type "${type}" but "${file}" is ${docKind === 'neither' ? 'neither an openapi nor an asyncapi document' : `an ${docKind} document`}`)
    // AsyncAPI: registered but excluded from Dart codegen (TRD-409; same scope as the TS precedent, packages/generated-clients/src/codegen.ts).
    if (type !== 'openapi') continue
    if (NODE_SIDE.has(name)) throw new Error(`${where}: surface name "${name}" would collide with the Node tooling in ${DART_PACKAGES_DIR}/`)
    if (!SURFACE_NAME.test(name)) throw new Error(`${where}: name "${name}" is not a valid surface directory / pub package name (lower-kebab-case)`)
    if (!file.endsWith('.json')) throw new Error(`${where}: "${file}" is not a JSON spec (JSON specs only)`)
    const surface = toSurface(name, file)
    allOpenApi.push(surface)
    if (status === 'active') surfaces.push(surface)
  }
  return { surfaces, allOpenApi }
}
