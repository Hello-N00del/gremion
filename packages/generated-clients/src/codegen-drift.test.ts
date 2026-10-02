// T6: codegen drift — hand edit, stale spec, missing output, each named.
// RED because: there was no codegen at all before this commit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodegenDrift } from './codegen-drift.js'
import { generateClientSource, type GeneratedClientSpec } from './codegen.js'
import { REPO_ROOT } from './repo-root.js'

const MINI_SPEC = {
  openapi: '3.1.0',
  info: { title: 'drift fixture', version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        summary: 'ping',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}

describe('checkCodegenDrift — scratch fixtures', () => {
  let dir: string
  let spec: GeneratedClientSpec

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codegen-drift-fixture-'))
    mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'generated-clients', 'src', 'generated'), { recursive: true })
    writeFileSync(join(dir, 'contracts', 'kernel', 'openapi.drift-fixture.json'), JSON.stringify(MINI_SPEC, null, 2))
    spec = {
      specFile: 'contracts/kernel/openapi.drift-fixture.json',
      outputFile: 'packages/generated-clients/src/generated/drift-fixture-client.ts',
      factoryName: 'createDriftFixtureClient',
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names a missing output', () => {
    const problems = checkCodegenDrift(dir, [spec])
    expect(problems.some((p) => p.includes(spec.outputFile) && /missing output/.test(p))).toBe(true)
  })

  it('passes when the output matches what the spec generates today', () => {
    const source = generateClientSource(dir, spec)
    writeFileSync(join(dir, spec.outputFile), source, 'utf8')
    expect(checkCodegenDrift(dir, [spec])).toEqual([])
    // 60 s: runs the real codegen twice; took 6-11 s under whole-tree gate load, over the 5 s default (R29-KHYG-K).
  }, 60_000)

  it('names a hand edit (output present, does not match current codegen)', () => {
    const source = generateClientSource(dir, spec)
    writeFileSync(join(dir, spec.outputFile), `${source}\n// a human added this line by hand\n`, 'utf8')
    const problems = checkCodegenDrift(dir, [spec])
    expect(problems.some((p) => p.includes(spec.outputFile))).toBe(true)
  })

  it('names a spec changed without regeneration (output is stale)', () => {
    const source = generateClientSource(dir, spec)
    writeFileSync(join(dir, spec.outputFile), source, 'utf8')
    // Now change the spec (add a path) WITHOUT regenerating the output.
    const changed = { ...MINI_SPEC, paths: { ...MINI_SPEC.paths, '/pong': { get: { summary: 'pong', responses: { '200': { description: 'ok' } } } } } }
    writeFileSync(join(dir, spec.specFile), JSON.stringify(changed, null, 2))
    const problems = checkCodegenDrift(dir, [spec])
    expect(problems.some((p) => p.includes(spec.outputFile))).toBe(true)
  })
})

describe('checkCodegenDrift — the real tree', () => {
  it('the committed kernel-governance-client.ts matches what the governance spec generates today', () => {
    expect(checkCodegenDrift(REPO_ROOT)).toEqual([])
    // 60 s: runs the real codegen; took 6-11 s under whole-tree gate load, over the 5 s default (R29-KHYG-K, gate r29-11).
  }, 60_000)

  it('the generated client carries no `node:` import (T7)', () => {
    const outPath = join(REPO_ROOT, 'packages/generated-clients/src/generated/kernel-governance-client.ts')
    const content = readFileSync(outPath, 'utf8')
    expect(content).not.toMatch(/from ['"]node:/)
    expect(content).not.toMatch(/require\(['"]node:/)
  })
})
