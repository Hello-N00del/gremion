// packages/generated-clients/src/registry.ts
//
// contracts/registry.json (DB-PLT-API-CONTRACT / DB-PLT-EVENT-TYPE, TRD-403)
// is the single list of every first-party HTTP or event surface's spec. This
// module (a) loads and structurally validates that list and (b) discovers
// every spec FILE actually on disk, so the two can be diffed: a spec with no
// entry, an entry with no file, and a registry that lists nothing at all are
// each named rather than silently passing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export type SpecType = 'openapi' | 'asyncapi'

export interface RegistryEntry {
  name: string
  type: SpecType
  file: string // repo-root-relative, forward-slash
  status: string
  owner: string
}

interface RawRegistry {
  specs?: unknown
}

/** Discover every spec file the registry is expected to cover. NEW-FILES-ONLY
 *  scope (Q4 default): contracts/star star/{openapi,asyncapi}.star.json and
 *  services/star/{openapi,asyncapi}/star star/star.json. Neither `services/`
 *  nor a third-party module repo exists in this tree yet, so the second half
 *  of the pattern finds nothing today and is here for when it does. */
export function discoverSpecFiles(repoRoot: string): string[] {
  const found: string[] = []
  const SPEC_NAME = /^(openapi|asyncapi)\..+\.json$/

  const walkContracts = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === 'fixtures' || entry === 'schema') continue // not surfaces
        walkContracts(full)
      } else if (SPEC_NAME.test(entry)) {
        found.push(relative(repoRoot, full).split('\\').join('/'))
      }
    }
  }
  walkContracts(join(repoRoot, 'contracts'))

  const servicesDir = join(repoRoot, 'services')
  if (existsSync(servicesDir)) {
    for (const svc of readdirSync(servicesDir)) {
      const svcDir = join(servicesDir, svc)
      if (!statSync(svcDir).isDirectory()) continue
      for (const kind of ['openapi', 'asyncapi']) {
        const kindDir = join(svcDir, kind)
        if (!existsSync(kindDir)) continue
        const walk = (dir: string): void => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            if (statSync(full).isDirectory()) walk(full)
            else if (entry.endsWith('.json')) found.push(relative(repoRoot, full).split('\\').join('/'))
          }
        }
        walk(kindDir)
      }
    }
  }
  return found.sort()
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Structural + cross-reference validation. Returns named problems; empty means clean. */
export function validateRegistry(repoRoot: string): { problems: string[]; entries: RegistryEntry[] } {
  const problems: string[] = []
  const registryPath = join(repoRoot, 'contracts', 'registry.json')
  if (!existsSync(registryPath)) {
    return { problems: [`contracts/registry.json does not exist at ${registryPath}`], entries: [] }
  }
  let raw: RawRegistry
  try {
    raw = JSON.parse(readFileSync(registryPath, 'utf8')) as RawRegistry
  } catch (e) {
    return { problems: [`contracts/registry.json is not valid JSON: ${(e as Error).message}`], entries: [] }
  }
  if (!Array.isArray(raw.specs) || raw.specs.length === 0) {
    return { problems: ['contracts/registry.json "specs" is missing, not an array, or empty'], entries: [] }
  }

  const entries: RegistryEntry[] = []
  const seenNames = new Set<string>()
  const seenFiles = new Set<string>()
  for (const [i, item] of raw.specs.entries()) {
    if (!isPlainRecord(item)) {
      problems.push(`specs[${i}]: not an object`)
      continue
    }
    const name = item.name
    const type = item.type
    const file = item.file
    const status = item.status
    const owner = item.owner
    if (typeof name !== 'string' || name.length === 0) problems.push(`specs[${i}]: missing "name"`)
    if (type !== 'openapi' && type !== 'asyncapi') problems.push(`specs[${i}] (${String(name)}): "type" must be "openapi" or "asyncapi", got ${JSON.stringify(type)}`)
    if (typeof file !== 'string' || file.length === 0) {
      problems.push(`specs[${i}] (${String(name)}): entry has no "file"`)
      continue
    }
    if (typeof status !== 'string' || status.length === 0) problems.push(`specs[${i}] (${String(name)}): missing "status"`)
    if (typeof owner !== 'string' || owner.length === 0) problems.push(`specs[${i}] (${String(name)}): missing "owner"`)
    if (!existsSync(join(repoRoot, file))) {
      problems.push(`specs[${i}] (${String(name)}): file "${file}" does not exist on disk`)
    }
    if (typeof name === 'string') {
      if (seenNames.has(name)) problems.push(`duplicate registry entry name "${name}"`)
      seenNames.add(name)
    }
    if (seenFiles.has(file)) problems.push(`duplicate registry entry file "${file}"`)
    seenFiles.add(file)
    entries.push({
      name: typeof name === 'string' ? name : String(i),
      type: (type === 'openapi' || type === 'asyncapi') ? type : 'openapi',
      file,
      status: typeof status === 'string' ? status : '',
      owner: typeof owner === 'string' ? owner : '',
    })
  }

  // Cross-reference: every discovered spec file must be registered.
  const discovered = discoverSpecFiles(repoRoot)
  for (const f of discovered) {
    if (!seenFiles.has(f)) problems.push(`${f}: discovered on disk but has no contracts/registry.json entry`)
  }

  return { problems, entries }
}

export function loadRegistry(repoRoot: string): RegistryEntry[] {
  const { problems, entries } = validateRegistry(repoRoot)
  if (problems.length > 0) {
    throw new Error(`contracts/registry.json is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  return entries
}
