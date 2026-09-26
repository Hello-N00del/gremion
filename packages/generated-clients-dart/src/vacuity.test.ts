// Test 6: vacuity. The check reports `N of M` with M taken from the registry;
// 0 of 0 passes on a fixture, but the real tree must have M >= 1 and N == M.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checkDartCodegenDrift, finalizeCheck, type GenerateFn } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo } from './fixture.ts'
import { syncDartPackages } from './writer.ts'
import { REPO_ROOT } from './repo-root.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture(...a: Parameters<typeof makeFixtureRepo>): string {
  const r = makeFixtureRepo(...a)
  roots.push(r)
  return r
}

describe('test 6 — vacuity', () => {
  it('reports N of M and passes on an all-AsyncAPI fixture (0 of 0)', () => {
    const root = fixture([{ name: 'events', type: 'asyncapi' }])
    const v = finalizeCheck(checkDartCodegenDrift(root, { generate: fakeGenerate }), { requireSurfaces: false })
    expect(v).toMatchObject({ ok: true, summary: expect.stringContaining('0 of 0') })
  })

  it('fails 0 of 0 when surfaces are required (the real-tree mode)', () => {
    const root = fixture([{ name: 'events', type: 'asyncapi' }])
    const v = finalizeCheck(checkDartCodegenDrift(root, { generate: fakeGenerate }), { requireSurfaces: true })
    expect(v.ok).toBe(false)
    expect(v.problems.join('\n')).toMatch(/0 of 0/)
  })

  it('N != M alone fails the verdict, even when no surface reported a problem of its own', () => {
    // defence in depth: pins the N == M rule in finalizeCheck itself, not only
    // via the per-surface problems that normally accompany a short count
    const v = finalizeCheck({ problems: [], checked: 1, expected: 2 }, { requireSurfaces: true })
    expect(v.ok).toBe(false)
    expect(v.problems.join('\n')).toContain('only 1 of 2')
  })

  it('fails when fewer surfaces were checked than the registry lists, naming N of M', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }, { name: 'gadgets', type: 'openapi' }])
    syncDartPackages(root, fakeGenerate)
    rmSync(join(root, 'packages/generated-clients-dart/gadgets'), { recursive: true })
    const v = finalizeCheck(checkDartCodegenDrift(root, { generate: fakeGenerate }), { requireSurfaces: true })
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('1 of 2')
  })

  it('a generator that emits no lib/**/*.dart for a surface is not a clean surface', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const noLib: GenerateFn = (r, s) => new Map([...fakeGenerate(r, s)].filter(([k]) => !k.startsWith('lib/')))
    syncDartPackages(root, noLib)
    const r = checkDartCodegenDrift(root, { generate: noLib })
    expect(r.checked).toBe(0)
    expect(r.problems.join('\n')).toMatch(/no lib\/\*\*\/\*\.dart/)
  })

  it('on the real tree M equals an independent count of openapi+active registry entries, and M >= 1', () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'registry.json'), 'utf8')) as { specs: { type: string; status: string }[] }
    const independent = raw.specs.filter((s) => s.type === 'openapi' && s.status === 'active').length
    const r = checkDartCodegenDrift(REPO_ROOT, { generate: fakeGenerate })
    expect(independent).toBeGreaterThanOrEqual(1)
    expect(r.expected).toBe(independent)
  })
})
