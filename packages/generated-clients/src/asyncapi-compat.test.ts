// T4: the T3 rules hold for AsyncAPI payloads too (contracts/fixtures/compat/
// asyncapi, base 1.0.0). RED because: there was no AsyncAPI compat check.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkAsyncApiCompat, compareAsyncApiPayloads } from './asyncapi-compat.js'
import { REPO_ROOT } from './repo-root.js'

const FIXTURES = join(REPO_ROOT, 'contracts', 'fixtures', 'compat', 'asyncapi')
const load = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const loadDoc = (name: string) => JSON.parse(load(name)) as unknown
const base = load('base-1.0.0.json')
const baseDoc = loadDoc('base-1.0.0.json')

describe('compareAsyncApiPayloads', () => {
  it('flags a removed property as breaking', () => {
    const res = compareAsyncApiPayloads(baseDoc, loadDoc('removed-property-1.0.0.json'))
    expect(res.breaking).toBe(true)
  })
  it('flags a newly-required property as breaking', () => {
    const res = compareAsyncApiPayloads(baseDoc, loadDoc('newly-required-1.0.0.json'))
    expect(res.breaking).toBe(true)
  })
  it('flags a removed enum value as breaking', () => {
    const res = compareAsyncApiPayloads(baseDoc, loadDoc('removed-enum-value-1.0.0.json'))
    expect(res.breaking).toBe(true)
  })
  it('flags a narrowed/changed type as breaking', () => {
    const res = compareAsyncApiPayloads(baseDoc, loadDoc('narrowed-type-1.0.0.json'))
    expect(res.breaking).toBe(true)
  })
  it('does NOT flag a new optional property as breaking', () => {
    const res = compareAsyncApiPayloads(baseDoc, loadDoc('added-optional-property-1.0.0.json'))
    expect(res.breaking).toBe(false)
  })
})

describe('checkAsyncApiCompat — T4 fixtures', () => {
  it('removed property (breaking) with NO bump: FAILS', () => {
    expect(checkAsyncApiCompat(base, load('removed-property-1.0.0.json')).ok).toBe(false)
  })
  it('removed property (breaking) with a MAJOR bump: PASSES', () => {
    expect(checkAsyncApiCompat(base, load('removed-property-2.0.0.json')).ok).toBe(true)
  })
  it('newly-required (breaking) with NO bump: FAILS', () => {
    expect(checkAsyncApiCompat(base, load('newly-required-1.0.0.json')).ok).toBe(false)
  })
  it('newly-required (breaking) with a MAJOR bump: PASSES', () => {
    expect(checkAsyncApiCompat(base, load('newly-required-2.0.0.json')).ok).toBe(true)
  })
  it('removed enum value (breaking) with NO bump: FAILS', () => {
    expect(checkAsyncApiCompat(base, load('removed-enum-value-1.0.0.json')).ok).toBe(false)
  })
  it('removed enum value (breaking) with a MAJOR bump: PASSES', () => {
    expect(checkAsyncApiCompat(base, load('removed-enum-value-2.0.0.json')).ok).toBe(true)
  })
  it('narrowed type (breaking) with NO bump: FAILS', () => {
    expect(checkAsyncApiCompat(base, load('narrowed-type-1.0.0.json')).ok).toBe(false)
  })
  it('narrowed type (breaking) with a MAJOR bump: PASSES', () => {
    expect(checkAsyncApiCompat(base, load('narrowed-type-2.0.0.json')).ok).toBe(true)
  })
  it('added optional property (non-breaking) with NO bump: FAILS', () => {
    const res = checkAsyncApiCompat(base, load('added-optional-property-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(false)
  })
  it('added optional property (non-breaking) with a MINOR bump: PASSES', () => {
    expect(checkAsyncApiCompat(base, load('added-optional-property-1.1.0.json')).ok).toBe(true)
  })
  it('description-only change: PASSES regardless of (same) version', () => {
    const res = checkAsyncApiCompat(base, load('description-only-1.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.structuralChange).toBe(false)
  })
  it('identical document: PASSES', () => {
    expect(checkAsyncApiCompat(base, base).ok).toBe(true)
  })

  // Regression for the stripCompatNoise bug the OpenAPI acceptance demo
  // caught (oasdiff-gate.ts): a payload property literally named
  // "description" (realistic here — calendar/content events carry one) must
  // not be mistaken for narrative documentation and silently dropped from
  // the comparison. Own base+variant pair: base-1.0.0.json's payload has no
  // "description" property to remove.
  const descBase = load('base-with-description-property-1.0.0.json')
  it('removed description-named payload property with NO bump: FAILS', () => {
    const res = checkAsyncApiCompat(descBase, load('removed-description-property-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
    expect(res.structuralChange).toBe(true)
  })
  it('removed description-named payload property with a MAJOR bump: PASSES', () => {
    const res = checkAsyncApiCompat(descBase, load('removed-description-property-2.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('major')
  })
})

// Round-1 verifier HIGH finding: every REAL payload in this repo is a $ref
// to a components.schemas entry that is allOf[Envelope, {...}] — the base
// fixture above has neither. These fixtures reproduce that exact shape so
// the regression is pinned in the unit suite, not only in the real-tree
// test below.
describe('compareAsyncApiPayloads — $ref + allOf envelope shape (round-1 verifier HIGH)', () => {
  const envelopeBase = loadDoc('envelope-base-1.0.0.json')

  it('resolves the $ref payload and flattens allOf to see the NESTED property', () => {
    const res = compareAsyncApiPayloads(envelopeBase, loadDoc('envelope-removed-nested-property-1.0.0.json'))
    expect(res.breaking).toBe(true)
    expect(res.reasons.some((r) => r.includes('payload.payload.attempts'))).toBe(true)
  })

  it('a type expressed as ["string","null"] on both sides is NOT a false-positive change', () => {
    // envelope-base's Envelope.correlationId is ["string", "null"] on both
    // sides of every fixture in this block — if `type` were compared with
    // !== on the raw array instead of as a set, this alone would (wrongly)
    // report a breaking change even with no real edit.
    const res = compareAsyncApiPayloads(envelopeBase, loadDoc('envelope-removed-nested-property-2.0.0.json'))
    expect(res.reasons.some((r) => r.includes('correlationId'))).toBe(false)
  })
})

describe('checkAsyncApiCompat — $ref + allOf envelope shape (round-1 verifier HIGH)', () => {
  const envelopeBase = load('envelope-base-1.0.0.json')

  it('nested removal (breaking) with NO bump: FAILS', () => {
    const res = checkAsyncApiCompat(envelopeBase, load('envelope-removed-nested-property-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
  })

  it('nested removal (breaking) with a MAJOR bump: PASSES', () => {
    const res = checkAsyncApiCompat(envelopeBase, load('envelope-removed-nested-property-2.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('major')
  })

  // MEDIUM finding (survived mutant G1b: `bump === 'major'` loosened to
  // `bump === 'major' || bump === 'minor'` and all tests stayed green). A
  // minor bump is NOT enough for a breaking removal.
  it('nested removal (breaking) with only a MINOR bump: FAILS', () => {
    const res = checkAsyncApiCompat(envelopeBase, load('envelope-removed-nested-property-1.1.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
    expect(res.bump).toBe('minor')
  })
})

// Round-1 verifier HIGH finding, reproduced against the REAL kernel spec
// (not a fixture): the exact probe from the review — remove `attempts` from
// EnvelopeOrgUnit's nested payload, remove `failed`/`abandoned` from the
// `status` enum, drop `status` from required, and bump only to 1.1.0 (minor).
// Before the fix this passed as "non-breaking AsyncAPI payload addition";
// it must now fail.
describe('checkAsyncApiCompat — real tree (contracts/kernel/asyncapi.provisioning.json)', () => {
  const realSpecPath = join(REPO_ROOT, 'contracts', 'kernel', 'asyncapi.provisioning.json')
  const realRaw = readFileSync(realSpecPath, 'utf8')
  const realDoc = JSON.parse(realRaw) as Record<string, unknown>

  function mutateOrgUnitPayload(mutate: (payload: Record<string, unknown>) => void, version: string): string {
    const doc = JSON.parse(JSON.stringify(realDoc)) as {
      info: { version: string }
      components: { schemas: { EnvelopeOrgUnit: { allOf: unknown[] } } }
    }
    doc.info.version = version
    const member = doc.components.schemas.EnvelopeOrgUnit.allOf[1] as { properties: { payload: Record<string, unknown> } }
    mutate(member.properties.payload)
    return JSON.stringify(doc)
  }

  it('removing attempts + narrowing the status enum + dropping status from required, with only a MINOR bump: FAILS', () => {
    const mutated = mutateOrgUnitPayload((payload) => {
      delete (payload.properties as Record<string, unknown>).attempts
      const status = (payload.properties as Record<string, { enum: string[] }>).status
      status.enum = status.enum.filter((v) => v !== 'failed' && v !== 'abandoned')
      payload.required = (payload.required as string[]).filter((r) => r !== 'status')
    }, '1.1.0')
    const res = checkAsyncApiCompat(realRaw, mutated)
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
    expect(res.reason).toMatch(/attempts|status/)
  })

  it('the same removal with a MAJOR bump: PASSES', () => {
    const mutated = mutateOrgUnitPayload((payload) => {
      delete (payload.properties as Record<string, unknown>).attempts
    }, '2.0.0')
    const res = checkAsyncApiCompat(realRaw, mutated)
    expect(res.ok).toBe(true)
  })
})
