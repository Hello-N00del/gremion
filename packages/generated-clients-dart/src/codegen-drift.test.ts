// Drift + hand-written-client checks, driven by an injected generator (brief
// §6 tests 1-4, 6 run without Docker/Java/Dart).
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { checkDartCodegenDrift, STAMP_FILE } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo, MINI_SPEC, writeFile, writeGenerated } from './fixture.ts'
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

describe('test 2b — whole file set, not per output', () => {
  it('names an extra hand-written file inside a surface package', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    const rel = `${s.packageDir}/lib/src/hand_client.dart`
    writeFile(root, rel, 'class HandClient {}\n')
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${rel}:`) && /extra/.test(p))).toBe(true)
  })

  it('ignores .dart_tool/ at the package root only', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    writeFile(root, `${s.packageDir}/.dart_tool/package_config.json`, '{}')
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems).toEqual([])
    writeFile(root, `${s.packageDir}/lib/.dart_tool/sneaky.dart`, 'class X {}\n')
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems.join('\n')).toMatch(/lib\/\.dart_tool\/sneaky\.dart: extra/)
  })

  it('names a package directory that is not a registered surface', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    generated(root)
    writeFile(root, 'packages/generated-clients-dart/hand-made/pubspec.yaml', 'name: hand_made\n')
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith('packages/generated-clients-dart/hand-made:'))).toBe(true)
  })

  it('names a .dart file hidden in the Node tooling side of the package', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    generated(root)
    writeFile(root, 'packages/generated-clients-dart/src/client.dart', 'class C {}\n')
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith('packages/generated-clients-dart/src/client.dart:'))).toBe(true)
  })
})

describe('test 3 — spec changed without regeneration', () => {
  it('names the stale package file and says the spec changed', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    const mutated = { ...MINI_SPEC, paths: { ...MINI_SPEC.paths, '/api/widgets': { get: { operationId: 'listWidgets', responses: { '200': { description: 'ok' } } } } } }
    writeFile(root, s.specFile, JSON.stringify(mutated, null, 2))
    const { problems, checked } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${s.packageDir}/${STAMP_FILE}: stale`) && p.includes(`${s.specFile} changed since this package was generated`))).toBe(true)
    expect(checked).toBe(0)
  })

  it('names a missing provenance stamp', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    rmSync(`${root}/${s.packageDir}/${STAMP_FILE}`)
    const { problems } = checkDartCodegenDrift(root, { generate: fakeGenerate })
    expect(problems.some((p) => p.startsWith(`${s.packageDir}/${STAMP_FILE}: stale`) && /provenance stamp is missing/.test(p))).toBe(true)
  })

  it('a CRLF checkout of the same spec is not stale', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    const s = generated(root)
    writeFile(root, s.specFile, JSON.stringify(MINI_SPEC, null, 2).replace(/\n/g, '\r\n'))
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems).toEqual([])
  })
})
