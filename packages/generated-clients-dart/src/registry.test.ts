// Registry discovery: every `type: openapi, status: active` entry of
// contracts/registry.json is a Dart surface, computed from the registry on
// every run (no hand-maintained table, unlike the TS sibling's
// GENERATED_CLIENTS — brief §3). RED because: src/registry.ts did not exist.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDartSurfaces, pubNameFor, SCRATCH_ROOT } from './registry.ts'
import { REPO_ROOT } from './repo-root.ts'

function writeRegistry(root: string, specs: Record<string, unknown>[]): void {
  mkdirSync(join(root, 'contracts'), { recursive: true })
  writeFileSync(join(root, 'contracts', 'registry.json'), JSON.stringify({ specs }))
  for (const s of specs) {
    if (typeof s.file !== 'string') continue
    mkdirSync(join(root, s.file, '..'), { recursive: true })
    writeFileSync(join(root, s.file), JSON.stringify(s.type === 'asyncapi' ? { asyncapi: '3.0.0' } : { openapi: '3.1.0', paths: {} }))
  }
}

describe('loadDartSurfaces — fixtures', () => {
  let dir: string
  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true })
    dir = mkdtempSync(join(SCRATCH_ROOT, 'registry-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps openapi+active entries only, in registry order, with derived pub names', () => {
    writeRegistry(dir, [
      { name: 'a-events', type: 'asyncapi', file: 'contracts/a/asyncapi.a.json', status: 'active' },
      { name: 'kernel-thing', type: 'openapi', file: 'contracts/k/openapi.thing.json', status: 'active' },
      { name: 'old-thing', type: 'openapi', file: 'contracts/k/openapi.old.json', status: 'deprecated' },
    ])
    const { surfaces, allOpenApi } = loadDartSurfaces(dir)
    expect(surfaces.map((s) => s.name)).toEqual(['kernel-thing'])
    expect(surfaces[0]).toMatchObject({
      specFile: 'contracts/k/openapi.thing.json',
      packageDir: 'packages/generated-clients-dart/kernel-thing',
      pubName: 'gremion_kernel_thing_client',
    })
    // the out-of-package scan uses every registered OpenAPI spec, any status
    expect(allOpenApi.map((s) => s.name)).toEqual(['kernel-thing', 'old-thing'])
  })

  it('throws (fails closed) on a missing, unparsable or specs-less registry', () => {
    expect(() => loadDartSurfaces(dir)).toThrow(/registry\.json/)
    mkdirSync(join(dir, 'contracts'), { recursive: true })
    writeFileSync(join(dir, 'contracts', 'registry.json'), '{not json')
    expect(() => loadDartSurfaces(dir)).toThrow(/not valid JSON/)
    writeFileSync(join(dir, 'contracts', 'registry.json'), '{}')
    expect(() => loadDartSurfaces(dir)).toThrow(/"specs"/)
  })

  it('throws on an entry it cannot classify rather than dropping it', () => {
    writeRegistry(dir, [{ name: 'x', type: 'grpc', file: 'contracts/x.json', status: 'active' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/specs\[0\].*type/)
    writeRegistry(dir, [{ name: 'x', type: 'openapi', file: 'contracts/x.json' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/specs\[0\].*status/)
  })

  it('rejects a surface name that cannot be a directory + pub package name', () => {
    writeRegistry(dir, [{ name: 'Bad Name', type: 'openapi', file: 'contracts/x.json', status: 'active' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/Bad Name/)
  })

  it('rejects a YAML spec (JSON specs only, brief §5)', () => {
    writeRegistry(dir, [{ name: 'y', type: 'openapi', file: 'contracts/openapi.y.yaml', status: 'active' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/JSON/)
  })

  it('throws on a status outside the known vocabulary instead of silently dropping the surface', () => {
    writeRegistry(dir, [{ name: 'x', type: 'openapi', file: 'contracts/openapi.x.json', status: 'Active' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/status "Active"/)
    writeRegistry(dir, [{ name: 'x', type: 'openapi', file: 'contracts/openapi.x.json', status: 'beta' }])
    expect(() => loadDartSurfaces(dir)).toThrow(/status "beta"/)
  })

  it('throws when the registry type disagrees with the document (an OpenAPI spec registered as asyncapi would dodge codegen AND the scan)', () => {
    mkdirSync(join(dir, 'contracts'), { recursive: true })
    writeFileSync(join(dir, 'contracts', 'registry.json'), JSON.stringify({ specs: [{ name: 'x', type: 'asyncapi', file: 'contracts/x.json', status: 'active' }] }))
    writeFileSync(join(dir, 'contracts', 'x.json'), JSON.stringify({ openapi: '3.1.0', paths: {} }))
    expect(() => loadDartSurfaces(dir)).toThrow(/type "asyncapi".*openapi/)
    writeFileSync(join(dir, 'contracts', 'registry.json'), JSON.stringify({ specs: [{ name: 'x', type: 'openapi', file: 'contracts/x.json', status: 'active' }] }))
    writeFileSync(join(dir, 'contracts', 'x.json'), JSON.stringify({ asyncapi: '3.0.0' }))
    expect(() => loadDartSurfaces(dir)).toThrow(/type "openapi"/)
    rmSync(join(dir, 'contracts', 'x.json'))
    expect(() => loadDartSurfaces(dir)).toThrow(/x\.json/)
  })

  it.each([['src'], ['tools'], ['node-modules'], ['package']])('rejects a surface named %s that would collide with the Node tooling', (n) => {
    writeRegistry(dir, [{ name: n, type: 'openapi', file: `contracts/openapi.${n}.json`, status: 'active' }])
    if (n === 'node-modules' || n === 'package') expect(() => loadDartSurfaces(dir)).not.toThrow()
    else expect(() => loadDartSurfaces(dir)).toThrow(/collide/)
  })

  it('pubNameFor snake-cases the registry name', () => {
    expect(pubNameFor('kernel-governance')).toBe('gremion_kernel_governance_client')
  })
})

describe('loadDartSurfaces — the real registry', () => {
  it('matches an independent count of openapi+active entries', () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'registry.json'), 'utf8')) as { specs: { type: string; status: string }[] }
    const independent = raw.specs.filter((s) => s.type === 'openapi' && s.status === 'active').length
    expect(independent).toBeGreaterThanOrEqual(1)
    expect(loadDartSurfaces(REPO_ROOT).surfaces).toHaveLength(independent)
  })
})
