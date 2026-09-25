// T8: validateModuleContracts — unknown api, unsatisfiable range, bad
// context. RED because: there was no validator (module-contracts.ts did not
// exist).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validateModuleContracts,
  rangeSatisfiedBy,
  parseRange,
  CANONICAL_CONTEXTS,
  loadApiVersions,
  type ModuleContractDeclaration,
} from './module-contracts.js'
import type { RegistryEntry } from './registry.js'
import { loadRegistry } from './registry.js'
import { REPO_ROOT } from './repo-root.js'

const REGISTRY: RegistryEntry[] = [
  { name: 'kernel-governance', type: 'openapi', file: 'contracts/kernel/openapi.governance.json', status: 'active', owner: 'gov' },
]
const VERSIONS = new Map([['kernel-governance', '1.0.0']])

function baseDecl(overrides: Partial<ModuleContractDeclaration> = {}): ModuleContractDeclaration {
  return { module: 'calendar', context: 'cal', ...overrides }
}

describe('rangeSatisfiedBy / parseRange', () => {
  it.each([
    ['>=1.0.0', '1.0.0', true],
    ['>=1.0.0', '0.9.0', false],
    ['>=1.0.0 <2.0.0', '1.5.0', true],
    ['>=1.0.0 <2.0.0', '2.0.0', false],
    ['^1.2.0', '1.9.0', true],
    ['^1.2.0', '2.0.0', false],
    ['~1.2.0', '1.2.9', true],
    ['~1.2.0', '1.3.0', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '1.0.1', false],
  ] as const)('%s satisfied by %s = %s', (range, version, expected) => {
    expect(rangeSatisfiedBy(range, version)).toBe(expected)
  })

  it('an unparsable range is reported, not silently accepted', () => {
    expect(rangeSatisfiedBy('not-a-range', '1.0.0')).toBe('unparsable')
    expect(parseRange('')).toBeNull()
  })
})

describe('validateModuleContracts', () => {
  it('a clean declaration has no problems', () => {
    const decl = baseDecl({ requires: { apis: [{ name: 'kernel-governance', versionRange: '>=1.0.0 <2.0.0' }] } })
    expect(validateModuleContracts(decl, REGISTRY, VERSIONS)).toEqual([])
  })

  it('names an unknown api', () => {
    const decl = baseDecl({ requires: { apis: [{ name: 'ghost-api', versionRange: '>=1.0.0' }] } })
    const problems = validateModuleContracts(decl, REGISTRY, VERSIONS)
    expect(problems.some((p) => /unknown/.test(p) && p.includes('ghost-api'))).toBe(true)
  })

  it('names an unsatisfiable version range', () => {
    const decl = baseDecl({ requires: { apis: [{ name: 'kernel-governance', versionRange: '>=2.0.0' }] } })
    const problems = validateModuleContracts(decl, REGISTRY, VERSIONS)
    expect(problems.some((p) => /unsatisfiable/.test(p) && p.includes('kernel-governance'))).toBe(true)
  })

  it('names a bad (non-canonical) context', () => {
    const decl = baseDecl({ context: 'xyz' })
    const problems = validateModuleContracts(decl, REGISTRY, VERSIONS)
    expect(problems.some((p) => /not one of the canonical/.test(p) && p.includes('xyz'))).toBe(true)
  })

  it('names a malformed event type', () => {
    const decl = baseDecl({ provides: { events: [{ type: 'not-an-event-type' }] } })
    const problems = validateModuleContracts(decl, REGISTRY, VERSIONS)
    expect(problems.some((p) => /DB-PLT-EVENT-TYPE grammar/.test(p))).toBe(true)
  })

  it('names an event type whose context is not canonical', () => {
    const decl = baseDecl({ provides: { events: [{ type: 'de.gremion.xyz.thing.created.v1' }] } })
    const problems = validateModuleContracts(decl, REGISTRY, VERSIONS)
    expect(problems.some((p) => /context "xyz" is not one of the canonical/.test(p))).toBe(true)
  })

  it('accepts a well-formed event type in a canonical context', () => {
    const decl = baseDecl({ provides: { events: [{ type: 'de.gremion.cal.event.created.v1' }] } })
    expect(validateModuleContracts(decl, REGISTRY, VERSIONS)).toEqual([])
  })
})

describe('CANONICAL_CONTEXTS', () => {
  it('is exactly the DB-PLT-MODULE set (18 contexts)', () => {
    expect(CANONICAL_CONTEXTS).toHaveLength(18)
    expect(CANONICAL_CONTEXTS).toContain('cal')
    expect(CANONICAL_CONTEXTS).toContain('gov')
  })
})

describe('loadApiVersions — the real tree', () => {
  it('reads info.version for every registered spec', () => {
    const registry = loadRegistry(REPO_ROOT)
    const versions = loadApiVersions(REPO_ROOT, registry)
    expect(versions.size).toBe(registry.length)
    for (const entry of registry) {
      expect(versions.get(entry.name)).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

describe('module-contracts.schema.json — structural sanity', () => {
  it('is valid JSON describing the same shape the validator expects', () => {
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'schema', 'module-contracts.schema.json'), 'utf8'))
    expect(schema.required).toEqual(['module', 'context'])
    expect(schema.properties.context.enum).toEqual([...CANONICAL_CONTEXTS])
  })
})
