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
type DiscoverBaseRef = (repoRoot: string, env?: NodeJS.ProcessEnv) => { ref: string | null; baseIsHead: boolean }

let runContractsCheck: RunContractsCheck
let resolveBaseRef: ResolveBaseRef
let discoverBaseRef: DiscoverBaseRef

/** The env the real-tree tests run under. On a feature branch that is the
 *  inherited env (automatic discovery). On trunk itself (HEAD === main, e.g.
 *  CI after a merge) discovery correctly fails closed (TASK-018-FU), so the
 *  real-tree run pins CONTRACTS_BASE_REF=HEAD~1 — gating the last commit, the
 *  same invocation contracts/README.md documents for trunk. */
function realTreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // An inherited override (e.g. CONTRACTS_BASE_REF=HEAD left exported from
  // the README demo) would make this run whatever the shell says; discovery
  // is what the real-tree test is about.
  delete env.CONTRACTS_BASE_REF
  if (discoverBaseRef(REPO_ROOT, env).baseIsHead) env.CONTRACTS_BASE_REF = 'HEAD~1'
  return env
}

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
    discoverBaseRef: DiscoverBaseRef
  }
  runContractsCheck = core.runContractsCheck
  resolveBaseRef = core.resolveBaseRef
  discoverBaseRef = core.discoverBaseRef
}, 60_000)

describe('runContractsCheck — the real tree (T9)', () => {
  it('is green: ok, and every spec present at the base ref was compat-checked (non-vacuity)', () => {
    const result = runContractsCheck(REPO_ROOT, { env: realTreeEnv() })
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

  it('resolveBaseRef finds a real, resolvable commit other than HEAD — or, on trunk itself, reports base === HEAD', () => {
    const env = { ...process.env }
    delete env.CONTRACTS_BASE_REF
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const { ref, baseIsHead } = discoverBaseRef(REPO_ROOT, env)
    if (ref === null) {
      expect(baseIsHead).toBe(true)
    } else {
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(ref).not.toBe(head)
    }
    expect(resolveBaseRef(REPO_ROOT, env)).toBe(ref)
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
    execFileSync('git', ['init', '-q', '-b', 'scratch'], { cwd: d }) // not a candidate branch name, whatever init.defaultBranch says
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
      // names (origin/main, main) has no base ref to
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

// TASK-018-FU finding 1 (CAP-BASE whole-branch audit, MEDIUM): with HEAD ON a
// candidate branch (a clone of main, CI on main after a merge), `git
// merge-base HEAD main` IS HEAD, so the gate diffed every spec against itself
// and reported "OK ... N compat-checked" — reproduced on trunk with a removed
// endpoint at an unchanged 1.0.0, exit 0. The vacuity guard only fires at
// compatChecked === 0, so it never saw this. Discovery must fail CLOSED when
// the only base it can find is HEAD, naming CONTRACTS_BASE_REF; an explicit
// CONTRACTS_BASE_REF is the operator's own choice and is honoured as given.
describe('runContractsCheck — a discovered base equal to HEAD fails closed (TASK-018-FU)', () => {
  const git = (d: string, args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' }).trim()
  const specV1 = { openapi: '3.1.0', info: { title: 't', version: '1.0.0' }, paths: {
    '/x': { get: { summary: 's', responses: { '200': { description: 'ok' } } } },
    '/y': { get: { summary: 's', responses: { '200': { description: 'ok' } } } },
  } }
  // The audit's reproduction: an endpoint removed with NO version bump.
  const specRemoved = { ...specV1, paths: { '/x': specV1.paths['/x'] } }

  function writeSpec(d: string, spec: unknown) {
    writeFileSync(join(d, 'contracts', 'kernel', 'openapi.x.json'), JSON.stringify(spec))
  }

  /** A scratch repo on branch `main`: commit 1 registers the spec, commit 2
   *  removes an endpoint at the same version. HEAD is main itself. */
  function trunkTree(): string {
    const d = mkdtempSync(join(tmpdir(), 'contracts-check-trunk-'))
    git(d, ['init', '-q', '-b', 'main'])
    git(d, ['config', 'user.email', 'test@example.com'])
    git(d, ['config', 'user.name', 'test'])
    writeFileSync(join(d, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    mkdirSync(join(d, 'contracts', 'kernel'), { recursive: true })
    writeFileSync(join(d, 'contracts', 'registry.json'), JSON.stringify({
      specs: [{ name: 'x', type: 'openapi', file: 'contracts/kernel/openapi.x.json', status: 'active', owner: 'gov' }],
    }))
    writeSpec(d, specV1)
    git(d, ['add', '-A'])
    git(d, ['commit', '-q', '-m', 'v1'])
    writeSpec(d, specRemoved)
    git(d, ['commit', '-q', '-am', 'remove /y, no bump'])
    return d
  }

  function envWithout(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    delete env.CONTRACTS_BASE_REF
    return env
  }

  it('HEAD on main (base === HEAD): fails CLOSED, names CONTRACTS_BASE_REF, diffs nothing against itself', () => {
    const d = trunkTree()
    try {
      const env = envWithout()
      expect(resolveBaseRef(d, env)).toBeNull()
      const result = runContractsCheck(d, { env })
      expect(result.ok).toBe(false)
      expect(result.compatChecked).toBe(0)
      expect(result.baseRef).toBeNull()
      expect(result.problems.some((p) => /equals HEAD/.test(p) && /CONTRACTS_BASE_REF/.test(p))).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('HEAD on main with an explicit CONTRACTS_BASE_REF: honoured, and the removed endpoint is caught', () => {
    const d = trunkTree()
    try {
      const env = { ...envWithout(), CONTRACTS_BASE_REF: 'HEAD~1' }
      expect(resolveBaseRef(d, env)).toBe('HEAD~1')
      const result = runContractsCheck(d, { env })
      expect(result.compatChecked).toBe(1)
      expect(result.problems.some((p) => /openapi\.x\.json: breaking change/.test(p))).toBe(true)
      expect(result.problems.some((p) => /equals HEAD/.test(p))).toBe(false)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  // Round-1 review MEDIUM: an explicit ref that RESOLVES to HEAD (`HEAD`,
  // `main`, `origin/main` on a trunk push) with no spec edits in the working
  // tree diffs every spec against itself — the same vacuous OK, one step
  // sideways. It fails closed; HEAD as the base for an UNCOMMITTED spec edit
  // (the README's acceptance-demo invocation) is still honoured.
  it('an explicit CONTRACTS_BASE_REF resolving to HEAD with no spec edits: fails CLOSED', () => {
    const d = trunkTree()
    try {
      for (const ref of ['HEAD', 'main']) {
        const result = runContractsCheck(d, { env: { ...envWithout(), CONTRACTS_BASE_REF: ref } })
        expect(result.ok).toBe(false)
        expect(result.compatChecked).toBe(0)
        expect(result.problems.some((p) => /resolves to HEAD/.test(p) && /CONTRACTS_BASE_REF/.test(p))).toBe(true)
      }
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('an explicit CONTRACTS_BASE_REF=HEAD with an UNCOMMITTED spec edit is honoured (acceptance-demo invocation)', () => {
    const d = trunkTree()
    try {
      writeSpec(d, { ...specRemoved, paths: {} })
      const result = runContractsCheck(d, { env: { ...envWithout(), CONTRACTS_BASE_REF: 'HEAD' } })
      expect(result.baseRef).toBe('HEAD')
      expect(result.compatChecked).toBe(1)
      expect(result.problems.some((p) => /resolves to HEAD/.test(p))).toBe(false)
      expect(result.problems.some((p) => /openapi\.x\.json: breaking change/.test(p))).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  // Round-1 verifier HIGH (pre-existing): `git mv` of a spec plus a break made
  // the new path "new since base", so it was never diffed and the check said
  // OK. A renamed spec is diffed against its base copy under the OLD path.
  it('a renamed spec with a break is still diffed against its base copy under the old path', () => {
    const d = trunkTree()
    try {
      git(d, ['reset', '-q', '--hard', 'HEAD~1']) // main = v1 with /x and /y
      git(d, ['checkout', '-q', '-b', 'unit/rename'])
      git(d, ['mv', 'contracts/kernel/openapi.x.json', 'contracts/kernel/openapi.z.json'])
      writeFileSync(join(d, 'contracts', 'kernel', 'openapi.z.json'), JSON.stringify(specRemoved))
      writeFileSync(join(d, 'contracts', 'registry.json'), JSON.stringify({
        specs: [{ name: 'x', type: 'openapi', file: 'contracts/kernel/openapi.z.json', status: 'active', owner: 'gov' }],
      }))
      git(d, ['commit', '-q', '-am', 'rename + remove /y, no bump'])
      const result = runContractsCheck(d, { env: envWithout() })
      expect(result.compatChecked).toBe(1)
      expect(result.problems.some((p) => /openapi\.z\.json: breaking change/.test(p))).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('HEAD on main with unpushed commits: origin/main (behind HEAD) is the base, not HEAD', () => {
    const d = trunkTree()
    try {
      const v1 = git(d, ['rev-parse', 'HEAD~1'])
      git(d, ['update-ref', 'refs/remotes/origin/main', v1])
      const env = envWithout()
      expect(resolveBaseRef(d, env)).toBe(v1)
      const result = runContractsCheck(d, { env })
      expect(result.compatChecked).toBe(1)
      expect(result.problems.some((p) => /openapi\.x\.json: breaking change/.test(p))).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('HEAD on a feature branch off main: the merge-base with main is the base', () => {
    const d = trunkTree()
    try {
      const mainTip = git(d, ['rev-parse', 'HEAD'])
      git(d, ['checkout', '-q', '-b', 'unit/feature'])
      writeSpec(d, { ...specRemoved, info: { ...specRemoved.info, version: '1.0.1' } })
      git(d, ['commit', '-q', '-am', 'patch bump'])
      expect(resolveBaseRef(d, envWithout())).toBe(mainTip)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
