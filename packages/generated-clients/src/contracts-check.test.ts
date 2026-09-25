// T9: real tree green; non-vacuity count equals the registry length. RED
// because: before this commit tools/contracts-check-core.mjs did not exist,
// so `pnpm contracts:check` had nothing wired to it (item Q2 default: ship
// this since `verify`/TASK-045 did not exist at commit time).
//
// This imports the CORE module (not the CLI) via a dynamic import AFTER an
// explicit build, for the same reason contracts-check-core.mjs itself
// documents: it resolves its dependencies from dist/, which must exist.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root.js'
import { validateRegistry } from './registry.js'

const PKG_DIR = join(REPO_ROOT, 'packages', 'generated-clients')

/** True when `file` exists at `ref` in the real repo — used only to compute
 *  the expected non-vacuity count in the T9 real-tree test (a spec new since
 *  the base ref is correctly NOT compat-checked, so entryCount is the wrong
 *  thing to compare compatChecked against; see the test for the full
 *  rationale). */
function existsAtRef(repoRoot: string, ref: string, file: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

type RunContractsCheck = (repoRoot: string, opts?: { env?: NodeJS.ProcessEnv }) => {
  ok: boolean; problems: string[]; entryCount: number; compatChecked: number; baseRef: string | null
}
type ResolveBaseRef = (repoRoot: string, env?: NodeJS.ProcessEnv) => string | null

let runContractsCheck: RunContractsCheck
let resolveBaseRef: ResolveBaseRef

beforeAll(async () => {
  execFileSync(process.platform === 'win32' ? 'cmd' : 'pnpm', process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', 'build'] : ['build'], { cwd: PKG_DIR, encoding: 'utf8' })
  // tools/contracts-check-core.mjs ships no .d.ts (tools/ is deliberately out
  // of the package's compiled/exported surface — see its own header comment).
  // A dynamic import of a declaration-less module is `any` under strict mode
  // unless cast explicitly; the cast target is the same two function shapes
  // this file already declares above, so a real signature drift here still
  // fails at the call sites below, not silently.
  // @ts-expect-error tools/*.mjs ships no .d.ts by design (see that file's own header) — the cast below still type-checks the shape used at every call site
  const core = (await import('../tools/contracts-check-core.mjs')) as unknown as {
    runContractsCheck: RunContractsCheck
    resolveBaseRef: ResolveBaseRef
  }
  runContractsCheck = core.runContractsCheck
  resolveBaseRef = core.resolveBaseRef
}, 60_000)

describe('runContractsCheck — the real tree (T9)', () => {
  it('is green: ok, and every spec present at the base ref was compat-checked (non-vacuity)', () => {
    const result = runContractsCheck(REPO_ROOT)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.entryCount).toBeGreaterThan(0)
    // MEDIUM finding (round 1): asserting `compatChecked === entryCount`
    // makes this test go RED on every future branch that registers a spec
    // NEW since the base ref (TASK-077/080/081/204 all add specs) even
    // though nothing is wrong — a spec new since base is CORRECTLY skipped
    // by the compat step (it has no prior version to diff), just registered.
    // The non-vacuity intent (brief: nothing was silently skipped) is
    // instead checked against the count of specs that actually EXISTED at
    // the base ref, which is what should have been, and was, diffed.
    const baseRef = result.baseRef
    expect(baseRef).not.toBeNull()
    const { entries } = validateRegistry(REPO_ROOT)
    const presentAtBase = entries.filter((e) => existsAtRef(REPO_ROOT, baseRef as string, e.file)).length
    expect(presentAtBase).toBeGreaterThan(0)
    expect(result.compatChecked).toBe(presentAtBase)
  })

  it('resolveBaseRef finds a real, resolvable commit', () => {
    const ref = resolveBaseRef(REPO_ROOT)
    expect(ref).toMatch(/^[0-9a-f]{40}$/)
  })

  it('CONTRACTS_BASE_REF overrides discovery (resolveBaseRef itself does not validate — runContractsCheck does, see below)', () => {
    const ref = resolveBaseRef(REPO_ROOT, { CONTRACTS_BASE_REF: 'deadbeef' })
    expect(ref).toBe('deadbeef')
  })

  // Round-1 verifier HIGH finding, reproduced verbatim: an unresolvable
  // CONTRACTS_BASE_REF must fail closed, not silently report "OK ... 0
  // compat-checked" with exit 0. Before the fix, readAtRef() turned the
  // resulting `git show` failure into `null` ("new since base"), the vacuity
  // guard saw `allNew === true`, and stayed quiet.
  it('an unresolvable CONTRACTS_BASE_REF fails CLOSED — named, not silently skipped', () => {
    const env = { ...process.env, CONTRACTS_BASE_REF: 'no-such-ref-xyz' }
    const result = runContractsCheck(REPO_ROOT, { env })
    expect(result.ok).toBe(false)
    expect(result.compatChecked).toBe(0)
    expect(result.problems.some((p) => /does not resolve to a real commit/.test(p))).toBe(true)
  })
})

describe('runContractsCheck — vacuity guard on a scratch tree', () => {
  let dir: string

  function scratchTree(): string {
    const d = mkdtempSync(join(tmpdir(), 'contracts-check-fixture-'))
    execFileSync('git', ['init', '-q'], { cwd: d })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: d })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: d })
    writeFileSync(join(d, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    return d
  }

  it('an empty registry is named as vacuity, not silently "ok"', () => {
    dir = scratchTree()
    try {
      mkdirSync(join(dir, 'contracts'), { recursive: true })
      writeFileSync(join(dir, 'contracts', 'registry.json'), JSON.stringify({ specs: [] }))
      const result = runContractsCheck(dir)
      expect(result.ok).toBe(false)
      expect(result.problems.some((p) => /empty/.test(p))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unresolvable base ref (no candidate branch exists, no override) fails CLOSED — named, not silently skipped', () => {
    dir = scratchTree()
    try {
      mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true })
      const spec = { openapi: '3.1.0', info: { title: 't', version: '1.0.0' }, paths: { '/x': { get: { summary: 's', responses: { '200': { description: 'ok' } } } } } }
      writeFileSync(join(dir, 'contracts', 'kernel', 'openapi.x.json'), JSON.stringify(spec))
      writeFileSync(join(dir, 'contracts', 'registry.json'), JSON.stringify({
        specs: [{ name: 'x', type: 'openapi', file: 'contracts/kernel/openapi.x.json', status: 'active', owner: 'gov' }],
      }))
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
      // A fresh repo with only one commit and none of the candidate branch
      // names (release-1/local-integration, main, ...) has no base ref to
      // resolve, and CONTRACTS_BASE_REF is not set. (Real PATH inherited so
      // `git` itself is still found — the absence under test is candidate
      // BRANCHES, not the git binary.)
      const envNoOverride = { ...process.env }
      delete envNoOverride.CONTRACTS_BASE_REF
      const resolved = resolveBaseRef(dir, envNoOverride)
      expect(resolved).toBeNull()
      const result = runContractsCheck(dir, { env: envNoOverride })
      expect(result.ok).toBe(false)
      expect(result.baseRef).toBeNull()
      expect(result.problems.some((p) => /could not resolve a base ref/.test(p))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
