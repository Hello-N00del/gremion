// TDD 6 (registry read), brief s.1 "Registry", lane note A1 and the skew rule
// (s.5): the declarations the image carries are the REAL modules/*/module.json
// (count read from the tree, never a literal), every runtime block the
// registry can serve is one the module-catalogue validator accepts
// (validateModuleJson, test-time: the image has no compose file, C17), and
// GET /api/v1/modules returns exactly the customer's enabled rows.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCatalogue } from '@gremion/module-catalogue'
import { describe, expect, it } from 'vitest'
import { DeclarationError, loadDeclarations } from '../../src/registry/declarations.ts'
import { A_HOST, A_ID, appWith, B_HOST, B_ID, DECL, edge, world } from '../harness/fakes.ts'

const KERNEL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const MODULES = join(KERNEL_ROOT, 'modules')
const moduleDirs = readdirSync(MODULES).filter((d) => statSync(join(MODULES, d)).isDirectory())

describe('module declarations (A1, C17)', () => {
  it('loads one declaration per modules/<dir> of the tree (count from the tree, not a literal)', () => {
    const decls = loadDeclarations(MODULES)
    expect(moduleDirs.length).toBeGreaterThanOrEqual(11)
    expect([...decls.keys()].sort()).toEqual([...moduleDirs].sort())
  })

  it('every module.json it serves is one the module-catalogue validator accepts (validateModuleJson)', () => {
    const r = checkCatalogue(MODULES)
    expect(r.problems).toEqual([])
    expect(r.valid).toBe(moduleDirs.length)
  })

  it('refuses a module root that declares nothing, or a broken declaration (boot refusal)', () => {
    expect(() => loadDeclarations(join(KERNEL_ROOT, 'docs'))).toThrow(DeclarationError)
    expect(() => loadDeclarations(join(KERNEL_ROOT, 'no-such-dir'))).toThrow(/not a directory/)
  })
})

describe('GET /api/v1/modules (TDD 6)', () => {
  it("returns exactly A's enabled modules with the image's runtime block; B (none enabled) gets []", async () => {
    const w = world()
    w.enabled.set(A_ID, [
      { moduleKey: 'calendar', semver: '1.0.0' },
      { moduleKey: 'votes', semver: '1.0.0' },
    ])
    w.declarations.set('votes', { ...DECL, database: null, export: null })
    const { app, rec } = appWith(w)
    const a = await app.inject({ url: '/api/v1/modules', headers: edge(A_HOST, 'token-a') })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual({
      customerId: A_ID,
      modules: [
        { moduleKey: 'calendar', semver: '1.0.0', runtime: DECL },
        { moduleKey: 'votes', semver: '1.0.0', runtime: { ...DECL, database: null, export: null } },
      ],
    })
    const b = await app.inject({ url: '/api/v1/modules', headers: edge(B_HOST, 'token-b') })
    expect(b.json()).toEqual({ customerId: B_ID, modules: [] })
    // each read named the resolved customer, and only it
    expect(rec.registryReads).toEqual([`list:${A_ID}`, `list:${B_ID}`])
    await app.close()
  })

  it('skew: an enabled version the image does not carry -> 503 for THAT customer, logged, no declaration served', async () => {
    const w = world()
    w.enabled.set(A_ID, [{ moduleKey: 'calendar', semver: '2.0.0' }])
    const { app, rec } = appWith(w)
    const res = await app.inject({ url: '/api/v1/modules', headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toMatch(/calendar|postgresService/)
    expect(rec.logs.some((l) => l.msg === 'kernel-api: module declaration skew')).toBe(true)
    expect((await app.inject({ url: '/api/v1/modules', headers: edge(B_HOST, 'token-b') })).statusCode).toBe(200)
    await app.close()
  })

  it('skew: an enabled module the image has no declaration for -> 503', async () => {
    const w = world()
    w.enabled.set(A_ID, [{ moduleKey: 'ghost', semver: '1.0.0' }])
    const { app } = appWith(w)
    expect((await app.inject({ url: '/api/v1/modules', headers: edge(A_HOST, 'token-a') })).statusCode).toBe(503)
    await app.close()
  })

  it('a registry outage is a 503 for the request, never an empty list', async () => {
    const { app } = appWith(world(), {
      registry: {
        listEnabled: async () => {
          throw new Error('platform down')
        },
        isEnabled: async () => false,
      },
    })
    const res = await app.inject({ url: '/api/v1/modules', headers: edge(A_HOST, 'token-a') })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBeDefined()
    await app.close()
  })
})
