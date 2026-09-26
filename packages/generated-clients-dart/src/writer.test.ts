// Test 4: AsyncAPI exclusion, through the writer and the check. Also the
// writer's sync semantics (it removes files the generator no longer emits).
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checkDartCodegenDrift, type GenerateFn } from './codegen-drift.ts'
import { fakeGenerate, makeFixtureRepo, writeFile } from './fixture.ts'
import { syncDartPackages } from './writer.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function fixture(...a: Parameters<typeof makeFixtureRepo>): string {
  const r = makeFixtureRepo(...a)
  roots.push(r)
  return r
}
const surfaceDirs = (root: string) => readdirSync(join(root, 'packages/generated-clients-dart')).sort()

describe('test 4 — AsyncAPI exclusion', () => {
  it('an AsyncAPI-only registry produces zero Dart output and the check passes on 0 of 0', () => {
    const root = fixture([{ name: 'events-a', type: 'asyncapi' }, { name: 'events-b', type: 'asyncapi' }])
    const calls: string[] = []
    const spy: GenerateFn = (r, s) => { calls.push(s.name); return fakeGenerate(r, s) }
    expect(syncDartPackages(root, spy)).toEqual([])
    expect(calls).toEqual([])
    expect(surfaceDirs(root)).toEqual([])
    expect(checkDartCodegenDrift(root, { generate: spy })).toEqual({ problems: [], checked: 0, expected: 0 })
  })

  it('a mixed registry with one OpenAPI entry produces exactly one client', () => {
    const root = fixture([{ name: 'events-a', type: 'asyncapi' }, { name: 'widgets', type: 'openapi' }, { name: 'events-b', type: 'asyncapi' }])
    expect(syncDartPackages(root, fakeGenerate)).toEqual(['packages/generated-clients-dart/widgets'])
    expect(surfaceDirs(root)).toEqual(['widgets'])
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate })).toEqual({ problems: [], checked: 1, expected: 1 })
  })
})

describe('syncDartPackages', () => {
  it('removes files the generator no longer emits, keeps .dart_tool/, and a second sync changes nothing', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    syncDartPackages(root, fakeGenerate)
    writeFile(root, 'packages/generated-clients-dart/widgets/lib/src/old_model.dart', 'x')
    writeFile(root, 'packages/generated-clients-dart/widgets/.dart_tool/cache', 'x')
    syncDartPackages(root, fakeGenerate)
    expect(existsSync(join(root, 'packages/generated-clients-dart/widgets/lib/src'))).toBe(false)
    expect(existsSync(join(root, 'packages/generated-clients-dart/widgets/.dart_tool/cache'))).toBe(true)
    expect(checkDartCodegenDrift(root, { generate: fakeGenerate }).problems).toEqual([])
  })

  it('removes a previously generated package whose surface left the registry, never a hand-made dir', () => {
    const root = fixture([{ name: 'widgets', type: 'openapi' }])
    writeFile(root, 'packages/generated-clients-dart/gone/.generated-from', 'contracts/gone.json\nsha256:0\n')
    writeFile(root, 'packages/generated-clients-dart/hand-made/pubspec.yaml', 'name: x\n')
    syncDartPackages(root, fakeGenerate)
    expect(surfaceDirs(root)).toEqual(['hand-made', 'widgets'])
  })
})
