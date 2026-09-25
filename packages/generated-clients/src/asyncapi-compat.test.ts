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
