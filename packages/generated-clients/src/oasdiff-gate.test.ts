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

// Time budget (R26-FLAKES, R27 scope). Every T3 fixture test with a structural
// change spawns the oasdiff binary twice (`breaking` + the `--version` probe;
// the docker fallback when no binary is on PATH). Measured 2026-09-28 on the
// 16-CPU dev box, "loaded" = 32 CPU-spinning + 4 file-I/O node processes on top
// of the other agents on the box:
//
//   one oasdiff-spawning T3 test   idle p95 0.37 s (n=45, max 0.88 s)   loaded p95 42.0 s (n=48, p50 4.1 s, max 114.5 s)
//
// The loaded tail is CPU-scheduling starvation of the spawned process, not this
// file: timing `oasdiff breaking` alone under CPU-only load gives max 24.7 s,
// under I/O-only load max 45 ms. It failed the 5 s default in integration gates.
// Budget = 3x the loaded p95, rounded up; the pure and hostile-PATH tests stay
// on the default (loaded max 0.2 s). No global raise.
const OASDIFF_VERDICT_MS = 130_000

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
  }, OASDIFF_VERDICT_MS)

  it('remove (breaking) with a MAJOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('removed-endpoint-2.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('major')
  }, OASDIFF_VERDICT_MS)

  // MEDIUM finding (round 1): surviving mutant G1b — `bump === 'major'`
  // loosened to `bump === 'major' || bump === 'minor'` in both
  // oasdiff-gate.ts and asyncapi-compat.ts, and all 38 existing tests stayed
  // green because none of the T3/T4 fixtures covered a breaking change with
  // only a MINOR bump.
  it('remove (breaking) with only a MINOR bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('removed-endpoint-1.1.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
    expect(res.bump).toBe('minor')
  }, OASDIFF_VERDICT_MS)

  it('narrow (breaking) with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('narrowed-param-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
  }, OASDIFF_VERDICT_MS)

  it('narrow (breaking) with a MAJOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('narrowed-param-2.0.0.json'))
    expect(res.ok).toBe(true)
  }, OASDIFF_VERDICT_MS)

  it('add (non-breaking) with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(base, load('added-param-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(false)
    expect(res.structuralChange).toBe(true)
  }, OASDIFF_VERDICT_MS)

  it('add (non-breaking) with a MINOR bump: PASSES', () => {
    const res = checkOpenApiCompat(base, load('added-param-1.1.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('minor')
  }, OASDIFF_VERDICT_MS)

  it('description-only change: PASSES regardless of (same) version', () => {
    const res = checkOpenApiCompat(base, load('description-only-1.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.structuralChange).toBe(false)
  })

  it('identical document: PASSES', () => {
    const res = checkOpenApiCompat(base, base)
    expect(res.ok).toBe(true)
  })

  // Acceptance demo (brief §6 footer): "remove a governance response field
  // with no bump; record it passing before wiring and failing after." Own
  // base+variant pair (not the shared `base` above) because it needs a
  // response schema with a removable property, which base-1.0.0.json has
  // none of. Verified empirically this was a real gap: oasdiff classifies
  // "response-optional-property-removed" as WARN, not ERR — at the gate's
  // original `--fail-on ERR` this exact case passed with NO bump, which is
  // the acceptance criterion's "remove ... without a major bump fails"
  // failing to hold for an optional field. `--fail-on WARN` closes it.
  const respBase = load('base-with-response-property-1.0.0.json')
  it('remove optional response property with NO bump: FAILS', () => {
    const res = checkOpenApiCompat(respBase, load('removed-response-property-1.0.0.json'))
    expect(res.ok).toBe(false)
    expect(res.breaking).toBe(true)
  }, OASDIFF_VERDICT_MS)
  it('remove optional response property with a MAJOR bump: PASSES', () => {
    const res = checkOpenApiCompat(respBase, load('removed-response-property-2.0.0.json'))
    expect(res.ok).toBe(true)
    expect(res.bump).toBe('major')
  }, OASDIFF_VERDICT_MS)
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
