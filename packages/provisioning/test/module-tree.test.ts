// R29-LOW-07 L5 (Q20 shared loader): loadModuleJsons is the ONE reader of the
// modules/ tree that the tenant-provision CLI and the two provisioning tests
// share. Its rule, unchanged from the three inline copies it replaces: sorted
// directory names, only directories that hold a module.json, JSON.parse.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadModuleJsons } from '../src/module-tree.ts'

const root = mkdtempSync(join(tmpdir(), 'r29-module-tree-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function mod(id: string, json: string | null): void {
  mkdirSync(join(root, id), { recursive: true })
  if (json !== null) writeFileSync(join(root, id, 'module.json'), json)
}

describe('loadModuleJsons', () => {
  it('returns one entry per modules/<id> with a module.json, sorted, parsed, with its dir', () => {
    mod('zeta', '{"id":"zeta","runtime":{"export":null}}')
    mod('alpha', '{"id":"alpha","runtime":{"export":{"retentionProfile":"rp-x"}}}')
    mod('no-json', null) // a directory without module.json is skipped
    writeFileSync(join(root, 'stray.txt'), 'not a module') // a plain file is skipped

    const out = loadModuleJsons(root)

    expect(out.map((m) => m.id)).toEqual(['alpha', 'zeta'])
    expect(out[0]).toEqual({
      id: 'alpha',
      dir: join(root, 'alpha'),
      moduleJson: { id: 'alpha', runtime: { export: { retentionProfile: 'rp-x' } } },
    })
    expect(out[1]!.moduleJson).toEqual({ id: 'zeta', runtime: { export: null } })
  })

  it('a malformed module.json throws (never silently dropped)', () => {
    mod('broken', '{ not json')
    expect(() => loadModuleJsons(root)).toThrow()
  })
})
