// T6: codegen drift — hand edit, stale spec, missing output, each named.
// RED because: there was no codegen at all before this commit.
//
// Time budget (R26-FLAKES). Every generateClientSource() / checkCodegenDrift()
// call spawns a fresh `node openapi-typescript` process, and that cold start is
// the whole cost of this file. Measured 2026-09-27 on the 16-CPU dev box; "loaded"
// = 32 CPU-spinning + 4 file-I/O node processes on top of the other agents
// already running on the box (baseline CPU ~50 %):
//
//   one spawn (MINI_SPEC or a real spec)  idle 0.43-1.1 s   loaded p95 10.5 s (n=48, max 23.7 s)
//   the real tree (2 spawns, real specs)  idle 1.1-1.9 s    loaded p95 17.0 s (n=16)
//
// The scratch tests used to spawn TWICE each (once to build the expected output,
// once inside checkCodegenDrift), so under load they took 5.8-9.7 s against the
// 5 s default timeout (4 of 6 RED in one loaded run here) and failed in kernel
// gates 50a3c78 and c2810a8. MINI_SPEC is a constant, so its generated source is
// computed ONCE (beforeAll) and every scratch test now spawns only inside the
// function under test. Each spawning test carries an explicit budget of >= 3x
// the loaded p95 — no global raise. Fixed file under the same load, 10 runs
// in a row: 10/10 green, file 6.1-22.1 s, slowest test 6.6 s.
//
// Not a timeout: one earlier loaded run failed 4.1 s into the real-tree test
// with "codegen tool errored ... Command failed: node openapi-typescript ..."
// and no stderr (the child exited non-zero or was killed, and codegen-drift.ts
// reports only the message). 102 back-to-back loaded spawns of both real specs
// did not reproduce it (0 failures, p95 2.9 s, max 22.2 s). If it recurs, the
// drift check's message needs the child's status/signal to say which.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCodegenDrift } from './codegen-drift.js'
import { generateClientSource, type GeneratedClientSpec } from './codegen.js'
import { REPO_ROOT } from './repo-root.js'

/** One openapi-typescript spawn: 3x the loaded p95 (10.5 s), rounded up. */
const ONE_SPAWN_MS = 35_000
/** checkCodegenDrift over the real registry (2 spawns, larger specs): 3x the loaded p95 (17.0 s), rounded up. */
const REAL_TREE_MS = 55_000

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

const SPEC: GeneratedClientSpec = {
  specFile: 'contracts/kernel/openapi.drift-fixture.json',
  outputFile: 'packages/generated-clients/src/generated/drift-fixture-client.ts',
  factoryName: 'createDriftFixtureClient',
}

/** A scratch repo root carrying MINI_SPEC at SPEC.specFile (and no output yet). */
function scratchTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codegen-drift-fixture-'))
  mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'generated-clients', 'src', 'generated'), { recursive: true })
  writeFileSync(join(dir, SPEC.specFile), JSON.stringify(MINI_SPEC, null, 2))
  return dir
}

describe('checkCodegenDrift — scratch fixtures', () => {
  let dir: string
  // What MINI_SPEC generates today, computed once. generateClientSource is a
  // pure function of the spec's content (codegen.ts), so re-running it per test
  // bought nothing but a second process per test. If the output ever came to
  // depend on anything else (e.g. the scratch path), the "passes when the
  // output matches" test below would go RED — it compares this cached text
  // against a fresh generation in a DIFFERENT scratch root.
  let miniSource: string

  beforeAll(() => {
    const seed = scratchTree()
    try {
      miniSource = generateClientSource(seed, SPEC)
    } finally {
      rmSync(seed, { recursive: true, force: true })
    }
    // A vacuous cache (empty text, a tool that printed nothing) would make the
    // tests below compare nothing against nothing. A throw (not expect(): the
    // vitest/no-standalone-expect lint rule forbids assertions in hooks) fails
    // every test in this block.
    for (const needle of ['"/ping"', `export function ${SPEC.factoryName}(`]) {
      if (!miniSource.includes(needle)) {
        throw new Error(`codegen-drift fixture: MINI_SPEC's generated source lacks ${needle} -- the cache is vacuous`)
      }
    }
  }, ONE_SPAWN_MS)

  beforeEach(() => {
    dir = scratchTree()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names a missing output', () => {
    const problems = checkCodegenDrift(dir, [SPEC])
    expect(problems.some((p) => p.includes(SPEC.outputFile) && /missing output/.test(p))).toBe(true)
  })

  it('passes when the output matches what the spec generates today', () => {
    writeFileSync(join(dir, SPEC.outputFile), miniSource, 'utf8')
    expect(checkCodegenDrift(dir, [SPEC])).toEqual([])
  }, ONE_SPAWN_MS)

  it('names a hand edit (output present, does not match current codegen)', () => {
    writeFileSync(join(dir, SPEC.outputFile), `${miniSource}\n// a human added this line by hand\n`, 'utf8')
    const problems = checkCodegenDrift(dir, [SPEC])
    expect(problems.some((p) => p.includes(SPEC.outputFile))).toBe(true)
  }, ONE_SPAWN_MS)

  it('names a spec changed without regeneration (output is stale)', () => {
    writeFileSync(join(dir, SPEC.outputFile), miniSource, 'utf8')
    // Now change the spec (add a path) WITHOUT regenerating the output.
    const changed = { ...MINI_SPEC, paths: { ...MINI_SPEC.paths, '/pong': { get: { summary: 'pong', responses: { '200': { description: 'ok' } } } } } }
    writeFileSync(join(dir, SPEC.specFile), JSON.stringify(changed, null, 2))
    const problems = checkCodegenDrift(dir, [SPEC])
    expect(problems.some((p) => p.includes(SPEC.outputFile))).toBe(true)
  }, ONE_SPAWN_MS)
})

describe('checkCodegenDrift — the real tree', () => {
  it('the committed kernel-governance-client.ts matches what the governance spec generates today', () => {
    expect(checkCodegenDrift(REPO_ROOT)).toEqual([])
  }, REAL_TREE_MS)

  it('the generated client carries no `node:` import (T7)', () => {
    const outPath = join(REPO_ROOT, 'packages/generated-clients/src/generated/kernel-governance-client.ts')
    const content = readFileSync(outPath, 'utf8')
    expect(content).not.toMatch(/from ['"]node:/)
    expect(content).not.toMatch(/require\(['"]node:/)
  })
})
