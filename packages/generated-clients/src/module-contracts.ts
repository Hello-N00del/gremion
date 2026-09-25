// packages/generated-clients/src/module-contracts.ts
//
// T8 / brief §5 decision 5. D2 (2026-09-15 spec, line 32407) is adapted, not
// built fresh: keep ONE validator returning `string[]` of named problems (the
// same idiom as registry.ts's validateRegistry), problem-text assertions, and
// mutated-fixture RED runs. Retargeted at a module's contract DECLARATION
// (what it provides/requires) checked against contracts/registry.json,
// instead of D2's original dist-manifest target — stale per the brief, this
// repo carries no dist manifest to validate.
//
// Scope is deliberately narrow (brief §5 decision 5, "the migration-range and
// nav/realm checks go to TASK-021"): unknown API, an unsatisfiable version
// range, and a non-canonical context are the three named failure modes this
// unit is asked for. TASK-077 is the consumer that loads a real module's
// declaration through this into DB-PLT-MODULE-VERSION(-API/-EVENT).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RegistryEntry } from './registry.js'

// DB-PLT-MODULE's canonical context set (brief, Decisions "Fixed").
export const CANONICAL_CONTEXTS = [
  'tnt', 'idt', 'oac', 'gov', 'brd', 'cal', 'fil', 'msg', 'hnd',
  'pwd', 'pub', 'nws', 'mail', 'ntf', 'plt', 'ops', 'fin', 'ele',
] as const
export type CanonicalContext = (typeof CANONICAL_CONTEXTS)[number]

// DB-PLT-EVENT-TYPE grammar: de.gremion.<ctx>.<entity>.<verb>.v<N>
const EVENT_TYPE_RE = /^de\.gremion\.([a-z]+)\.[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.v\d+$/

export interface ApiRequirement { name: string; versionRange: string }
export interface EventDeclaration { type: string }
export interface ModuleContractDeclaration {
  module: string
  context: string
  provides?: { apis?: ApiRequirement[]; events?: EventDeclaration[] }
  requires?: { apis?: ApiRequirement[]; events?: EventDeclaration[] }
}

// --- minimal semver range support --------------------------------------
// Only what "range satisfiable" needs: an AND-list of comparators
// (`>=1.0.0 <2.0.0`), plus `^`/`~` convenience forms and an exact pin. No
// `||` OR-ranges — pre-1.0 with one registered version per API, nothing here
// needs them, and a false "unsatisfiable" from an unsupported syntax is
// exactly the kind of silent gap this validator exists to avoid, so an
// unparsable range is reported as a problem rather than assumed to pass.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

interface Comparator { op: '>=' | '>' | '<=' | '<' | '='; version: [number, number, number] }

function expandShorthand(token: string): Comparator[] | null {
  if (token.startsWith('^')) {
    const v = parseSemver(token.slice(1))
    if (!v) return null
    const upper: [number, number, number] = v[0] > 0 ? [v[0] + 1, 0, 0] : v[1] > 0 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]
    return [{ op: '>=', version: v }, { op: '<', version: upper }]
  }
  if (token.startsWith('~')) {
    const v = parseSemver(token.slice(1))
    if (!v) return null
    return [{ op: '>=', version: v }, { op: '<', version: [v[0], v[1] + 1, 0] }]
  }
  const cmp = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
  if (!cmp) return null
  const v = parseSemver(cmp[2])
  if (!v) return null
  return [{ op: (cmp[1] as Comparator['op']) ?? '=', version: v }]
}

/** Parse an AND-list range string into comparators, or `null` if any token
 *  cannot be parsed (an unparsable range is a caller-visible problem, not a
 *  silent pass). */
export function parseRange(range: string): Comparator[] | null {
  const tokens = range.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const comparators: Comparator[] = []
  for (const t of tokens) {
    const expanded = expandShorthand(t)
    if (!expanded) return null
    comparators.push(...expanded)
  }
  return comparators
}

export function rangeSatisfiedBy(range: string, version: string): boolean | 'unparsable' {
  const v = parseSemver(version)
  if (!v) return 'unparsable'
  const comparators = parseRange(range)
  if (!comparators) return 'unparsable'
  return comparators.every((c) => {
    const cmp = compareSemver(v, c.version)
    switch (c.op) {
      case '>=': return cmp >= 0
      case '>': return cmp > 0
      case '<=': return cmp <= 0
      case '<': return cmp < 0
      case '=': return cmp === 0
    }
  })
}

/** Read each registry entry's spec file and return its `info.version`
 *  (OpenAPI) / top-level `version` — both AsyncAPI and OpenAPI 3.x carry
 *  their version at `info.version`. An unreadable or version-less spec is
 *  simply absent from the map; `validateModuleContracts` then reports it as
 *  a range it cannot satisfy, rather than silently skipping the check. */
export function loadApiVersions(repoRoot: string, registry: RegistryEntry[]): Map<string, string> {
  const versions = new Map<string, string>()
  for (const entry of registry) {
    try {
      const doc = JSON.parse(readFileSync(join(repoRoot, entry.file), 'utf8')) as { info?: { version?: string } }
      if (typeof doc.info?.version === 'string') versions.set(entry.name, doc.info.version)
    } catch {
      // unreadable/unparsable spec: leave unset, handled as "unknown" below
    }
  }
  return versions
}

function checkApiRequirement(label: string, api: ApiRequirement, registry: RegistryEntry[], apiVersions: Map<string, string>, problems: string[]): void {
  const entry = registry.find((e) => e.name === api.name)
  if (!entry) {
    problems.push(`${label} api "${api.name}": unknown — not in contracts/registry.json`)
    return
  }
  const version = apiVersions.get(api.name)
  if (!version) {
    problems.push(`${label} api "${api.name}": registered but its spec's version could not be read — cannot check range "${api.versionRange}"`)
    return
  }
  const satisfied = rangeSatisfiedBy(api.versionRange, version)
  if (satisfied === 'unparsable') {
    problems.push(`${label} api "${api.name}": version range "${api.versionRange}" is not a range this validator understands`)
  } else if (!satisfied) {
    problems.push(`${label} api "${api.name}": registered version ${version} does not satisfy required range "${api.versionRange}" — unsatisfiable`)
  }
}

function checkEventDeclaration(label: string, ev: EventDeclaration, problems: string[]): void {
  const m = EVENT_TYPE_RE.exec(ev.type)
  if (!m) {
    problems.push(`${label} event "${ev.type}": does not match the DB-PLT-EVENT-TYPE grammar de.gremion.<ctx>.<entity>.<verb>.v<N>`)
    return
  }
  const ctx = m[1]
  if (!(CANONICAL_CONTEXTS as readonly string[]).includes(ctx)) {
    problems.push(`${label} event "${ev.type}": context "${ctx}" is not one of the canonical DB-PLT-MODULE contexts (${CANONICAL_CONTEXTS.join(' ')})`)
  }
}

/** T8: unknown api, unsatisfiable range, bad context — each named. `registry`
 *  is `contracts/registry.json`'s entries (registry.ts:loadRegistry);
 *  `apiVersions` is `loadApiVersions()`'s map, passed separately so a caller
 *  that already has both need not re-read the disk. */
export function validateModuleContracts(
  decl: ModuleContractDeclaration,
  registry: RegistryEntry[],
  apiVersions: Map<string, string>,
): string[] {
  const problems: string[] = []

  if (!decl.module || decl.module.trim().length === 0) problems.push('module contract declaration has no "module" name')
  if (!(CANONICAL_CONTEXTS as readonly string[]).includes(decl.context)) {
    problems.push(`context "${decl.context}" is not one of the canonical DB-PLT-MODULE contexts (${CANONICAL_CONTEXTS.join(' ')})`)
  }

  for (const api of decl.provides?.apis ?? []) checkApiRequirement('provides', api, registry, apiVersions, problems)
  for (const api of decl.requires?.apis ?? []) checkApiRequirement('requires', api, registry, apiVersions, problems)
  for (const ev of decl.provides?.events ?? []) checkEventDeclaration('provides', ev, problems)
  for (const ev of decl.requires?.events ?? []) checkEventDeclaration('requires', ev, problems)

  return problems
}
