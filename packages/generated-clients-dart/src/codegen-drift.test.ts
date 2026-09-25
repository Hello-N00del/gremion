// Drift + hand-written-client checks, driven by an injected generator (brief
// §6 tests 1-4, 6 run without Docker/Java/Dart).
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { checkDartCodegenDrift } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo, writeFile, writeGenerated } from './fixture.ts'
import { loadDartSurfaces } from './registry.ts'

const roots: string[] = []
function fixture(...a: Parameters<typeof makeFixtureRepo>): string {
  const r = makeFixtureRepo(...a)
  roots.push(r)
  return r
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

describe('test 1 — missing output', () => {
  it('names the surface whose package was never generated', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.includes('packages/generated-clients-dart/widgets') && /missing/.test(p))).toBe(true)
  })
})

function generated(root: string) {
  const [s] = loadDartSurfaces(root).surfaces
  writeGenerated(root, fakeGenerate, s)
  return s
}

describe('test 2 — hand edit at an expected output path', () => {
  it('passes on an untouched regeneration', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    generated(root)
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate })).toEqual({ problems: [], checked: 1, expected: 1 })
  })

  it('names the file whose content differs from what the generator emits', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    const rel = `${s.packageDir}/lib/${s.pubName}.dart`
    writeFile(root, rel, "// hand-written client\nconst base = '/api/widgets';\n")
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${rel}:`) && /differs/.test(p))).toBe(true)
  })

  it('names a generated file that was deleted', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    rmSync(`${root}/${s.packageDir}/pubspec.yaml`)
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${s.packageDir}/pubspec.yaml:`) && /missing/.test(p))).toBe(true)
  })

  it('names the surface when its generator throws, and does not count it as checked', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    generated(root)
    const r = checkDartCodegenDrift(root, { generate: () => { throw new Error('boom') } })
    expect(r.checked).toBe(0)
    expect(r.problems.some((p) => p.includes('widgets') && /boom/.test(p))).toBe(true)
  })
})
