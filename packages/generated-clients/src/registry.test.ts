// T1: registry validation — unregistered spec, missing file, empty registry.
// RED because: there is no registry (contracts/registry.json did not exist).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRegistry } from './registry.js'
import { REPO_ROOT } from './repo-root.js'

describe('validateRegistry — the real tree', () => {
  it('the committed registry is clean and non-empty', () => {
    const { problems, entries } = validateRegistry(REPO_ROOT)
    expect(problems).toEqual([])
    expect(entries.length).toBeGreaterThan(0)
  })

  it('every real contracts/**/{openapi,asyncapi}.*.json file is registered (no unregistered spec)', () => {
    const { problems } = validateRegistry(REPO_ROOT)
    expect(problems.join('\n')).not.toMatch(/discovered on disk but has no/)
  })
})

describe('validateRegistry — scratch fixtures', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'registry-fixture-'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails closed on an empty registry', () => {
    writeFileSync(join(dir, 'contracts', 'registry.json'), JSON.stringify({ specs: [] }))
    const { problems } = validateRegistry(dir)
    expect(problems.some((p) => /empty/.test(p))).toBe(true)
  })

  it('fails closed when contracts/registry.json does not exist at all', () => {
    const { problems } = validateRegistry(dir)
    expect(problems.some((p) => /does not exist/.test(p))).toBe(true)
  })

  it('names an entry with no file', () => {
    writeFileSync(
      join(dir, 'contracts', 'registry.json'),
      JSON.stringify({ specs: [{ name: 'x', type: 'openapi', status: 'active', owner: 'gov' }] }),
    )
    const { problems } = validateRegistry(dir)
    expect(problems.some((p) => /entry has no "file"/.test(p))).toBe(true)
  })

  it('names an entry whose file does not exist on disk', () => {
    writeFileSync(
      join(dir, 'contracts', 'registry.json'),
      JSON.stringify({
        specs: [{ name: 'x', type: 'openapi', file: 'contracts/kernel/openapi.ghost.json', status: 'active', owner: 'gov' }],
      }),
    )
    const { problems } = validateRegistry(dir)
    expect(problems.some((p) => /does not exist on disk/.test(p))).toBe(true)
  })

  it('names a spec discovered on disk with no registry entry (unregistered spec)', () => {
    writeFileSync(join(dir, 'contracts', 'kernel', 'openapi.ghost.json'), '{}')
    writeFileSync(
      join(dir, 'contracts', 'registry.json'),
      JSON.stringify({
        specs: [{ name: 'other', type: 'openapi', file: 'contracts/kernel/openapi.other.json', status: 'active', owner: 'gov' }],
      }),
    )
    writeFileSync(join(dir, 'contracts', 'kernel', 'openapi.other.json'), '{}')
    const { problems } = validateRegistry(dir)
    expect(problems.some((p) => /openapi\.ghost\.json.*no contracts\/registry\.json entry/.test(p))).toBe(true)
  })
})
