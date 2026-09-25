// T3: OpenAPI compat gate against contracts/fixtures/compat/openapi, base
// 1.0.0: remove or add with no bump fails; 1.1.0 / 2.0.0 pass; description-
// only passes. T5: a missing/erroring tool fails the check CLOSED (throws,
// gives no verdict) — there is no environment bypass.
// RED because: the old gate (gremion-ui/scripts/contracts-gate.ts) is
// staged-only and carries a CONTRACTS_ALLOW_BREAKING bypass; neither the
// version-bump rule nor this port existed before this commit.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkOpenApiCompat, classifyVersionBump, runOasdiffBreaking, stripCompatNoise } from './oasdiff-gate.js'
import { REPO_ROOT } from './repo-root.js'

const FIXTURES = join(REPO_ROOT, 'contracts', 'fixtures', 'compat', 'openapi')
const load = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const base = load('base-1.0.0.json')

describe('classifyVersionBump', () => {
  it.each([
    ['1.0.0', '2.0.0', 'major'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.0.0', '1.0.1', 'patch'],
    ['1.0.0', '1.0.0', 'none'],
    ['1.1.0', '1.0.0', 'downgrade'],
    ['1.0.0', 'not-semver', 'invalid'],
  ] as const)('%s -> %s is %s', (o, n, expected) => {
    expect(classifyVersionBump(o, n)).toBe(expected)
  })
})

describe('stripCompatNoise', () => {
  it('removes description keys recursively but keeps everything else', () => {
    const doc = { a: { description: 'x', b: 1 }, description: 'top' }
    expect(stripCompatNoise(doc)).toEqual({ a: { b: 1 } })
  })
})

describe('checkOpenApiCompat — T3 fixtures', () => {
  it('remove (breaking) with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('removed-endpoint-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
  })

  it('remove (breaking) with a MAJOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('removed-endpoint-2.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('major')
  })

  it('narrow (breaking) with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('narrowed-param-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
  })

  it('narrow (breaking) with a MAJOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('narrowed-param-2.0.0.json'))
    expect(res.ok).toBe(true)
  })

  it('add (non-breaking) with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('added-param-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(false)
    expect(res.structuralChange).toBe(true)
  })

  it('add (non-breaking) with a MINOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('added-param-1.1.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('minor')
  })

  it('description-only change: PASSES regardless of (same) version', () => {
    const res = checkOpenApiCompat(base, load('description-only-1.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.structuralChange).toBe(false)
  })

  it('identical document: PASSES', () => {
    const res = checkOpenApiCompat(base, base)
    expect(res.ok).toBe(true)
  })
})

describe('runOasdiffBreaking — T5: fail closed with no verdict', () => {
  it('throws when no oasdiff on PATH and no docker daemon reachable', () => {
    // An intentionally hostile PATH: it resolves neither `oasdiff` nor
    // `docker`, on Windows or POSIX. This proves the gate fails CLOSED —
    // it does not report "clean" just because nothing could check.
    const hostileEnv = { ...process.env, PATH: '', Path: '' }
    expect(() => runOasdiffBreaking(base, load('removed-endpoint-1.0.0.json'), { env: hostileEnv }))
      .toThrow(/no oasdiff verdict/)
  })

  it('checkOpenApiCompat itself throws (no silent pass) under the same hostile PATH, for a structural change', () => {
    const hostileEnv = { ...process.env, PATH: '', Path: '' }
    expect(() => checkOpenApiCompat(base, load('removed-endpoint-1.0.0.json'), { env: hostileEnv }))
      .toThrow(/no oasdiff verdict/)
  })
})
