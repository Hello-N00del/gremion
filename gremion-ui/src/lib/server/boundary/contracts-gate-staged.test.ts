// TASK-018-FU finding 2 (CAP-BASE whole-branch audit, MEDIUM): the pre-commit
// contracts gate (scripts/contracts-gate.ts, the one that runs today via
// `boundary-lint --staged`) (a) ran the UNPINNED `tufin/oasdiff` image, so
// which tool version rendered a verdict drifted with `latest` — TASK-030 fixed
// the same LOW in its own port (packages/generated-clients/src/oasdiff-gate.ts)
// and this copy must carry the SAME digest; and (b) waved any break through
// under CONTRACTS_ALLOW_BREAKING=1 without checking that info.version's major
// was actually bumped, although the bypass's own message demands the bump.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as gate from '../../../../scripts/contracts-gate'

const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const repoRoot = join(gremionUiRoot, '..')

/** The digest-pinned image TASK-030's port uses — the single source this
 *  gate must agree with (gremion-ui does not depend on that package, and
 *  install-git-hooks.test.ts copies contracts-gate.ts into a scratch repo on
 *  its own, so the constant is duplicated and this equality is the guard). */
function pinnedImageInOasdiffGate(): string {
  const src = readFileSync(join(repoRoot, 'packages/generated-clients/src/oasdiff-gate.ts'), 'utf8')
  const m = src.match(/const OASDIFF_DOCKER_IMAGE = '([^']+)'/)
  if (!m) throw new Error('OASDIFF_DOCKER_IMAGE not found in packages/generated-clients/src/oasdiff-gate.ts')
  return m[1]
}

describe('contracts-gate — the docker fallback image is pinned (a)', () => {
  it('exports the same digest-pinned image as packages/generated-clients/src/oasdiff-gate.ts', () => {
    const expected = pinnedImageInOasdiffGate()
    expect(expected).toMatch(/^tufin\/oasdiff:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    expect((gate as Record<string, unknown>).OASDIFF_DOCKER_IMAGE).toBe(expected)
  })

  // Behavioural, not a source grep: with no `oasdiff` on PATH and a stub
  // `docker` whose daemon "answers", record the image `docker run` was handed.
  // POSIX-only (the stubs are sh scripts spawnSync cannot run on Windows); the
  // equality test above runs everywhere.
  it.skipIf(process.platform === 'win32')('docker run is handed the pinned image, never bare tufin/oasdiff', () => {
    const bin = mkdtempSync(join(tmpdir(), 'contracts-gate-bin-'))
    const log = join(bin, 'docker-args.log')
    try {
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = version ]; then echo 29.0.0; exit 0; fi\necho "$@" >> '${log}'\nexit 0\n`)
      chmodSync(join(bin, 'docker'), 0o755)
      // PATH = the stub dir + the dirs holding sh/echo, and nothing that
      // could resolve a real `oasdiff` or `docker`.
      vi.stubEnv('PATH', [bin, '/bin', '/usr/bin'].filter(Boolean).join(delimiter))
      const res = gate.runOasdiffBreaking('{}', '{}')
      expect(res.breaking).toBe(false)
      const args = readFileSync(log, 'utf8').trim().split(/\s+/)
      expect(args[0]).toBe('run')
      expect(args).toContain(pinnedImageInOasdiffGate())
      expect(args).not.toContain('tufin/oasdiff')
      expect(res.tool).toContain(pinnedImageInOasdiffGate())
    } finally {
      vi.unstubAllEnvs()
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('gateStagedSpecs — CONTRACTS_ALLOW_BREAKING=1 still requires a MAJOR bump (b)', () => {
  const SPEC_PATH = 'contracts/kernel/openapi.x.json'
  const git = (d: string, args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
  const spec = (version: string, withY: boolean) => JSON.stringify({
    openapi: '3.1.0',
    info: { title: 't', version },
    paths: {
      '/x': { get: { summary: 's', responses: { '200': { description: 'ok' } } } },
      ...(withY ? { '/y': { get: { summary: 's', responses: { '200': { description: 'ok' } } } } } : {}),
    },
  }, null, 2)
  // A genuinely breaking edit (/y removed) is staged; the oasdiff verdict is
  // injected so this runs hermetically, with or without oasdiff/docker.
  const breaking = () => ({ breaking: true, output: 'api-path-removed-without-deprecation', tool: 'stub' })
  const clean = () => ({ breaking: false, output: '', tool: 'stub' })
  let dir = ''

  function stagedBreak(newVersion: string): string {
    const d = mkdtempSync(join(tmpdir(), 'contracts-gate-staged-'))
    git(d, ['init', '-q'])
    git(d, ['config', 'user.email', 'test@example.com'])
    git(d, ['config', 'user.name', 'test'])
    mkdirSync(join(d, 'contracts', 'kernel'), { recursive: true })
    writeFileSync(join(d, SPEC_PATH), spec('1.4.2', true))
    git(d, ['add', '-A'])
    git(d, ['commit', '-q', '-m', 'base'])
    writeFileSync(join(d, SPEC_PATH), spec(newVersion, false))
    git(d, ['add', '-A'])
    return d
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('ALLOW_BREAKING=1 with an unchanged major (1.4.2 -> 1.5.0): FAILS, naming the missing major bump', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '1')
    dir = stagedBreak('1.5.0')
    const problems = gate.gateStagedSpecs(dir, { compare: breaking })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(SPEC_PATH)
    expect(problems[0]).toMatch(/major/i)
    expect(problems[0]).toContain('1.4.2')
    expect(problems[0]).toContain('1.5.0')
  })

  it('ALLOW_BREAKING=1 with the version untouched (1.4.2 -> 1.4.2): FAILS', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '1')
    dir = stagedBreak('1.4.2')
    expect(gate.gateStagedSpecs(dir, { compare: breaking })).toHaveLength(1)
  })

  it('ALLOW_BREAKING=1 with an unparseable version: FAILS closed', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '1')
    dir = stagedBreak('two')
    expect(gate.gateStagedSpecs(dir, { compare: breaking })).toHaveLength(1)
  })

  it('ALLOW_BREAKING=1 with a major bump (1.4.2 -> 2.0.0): allowed', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '1')
    dir = stagedBreak('2.0.0')
    expect(gate.gateStagedSpecs(dir, { compare: breaking })).toEqual([])
  })

  it('without ALLOW_BREAKING a break FAILS even with a major bump (the bypass is still opt-in)', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '')
    dir = stagedBreak('2.0.0')
    expect(gate.gateStagedSpecs(dir, { compare: breaking })).toHaveLength(1)
  })

  // Round-1 verifier HIGH (pre-existing): `git mv` + a break was staged as
  // R096, `git show HEAD:<new path>` failed and the spec was skipped as "new".
  it('a staged RENAME with a break is compared against HEAD under the old path', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '')
    dir = stagedBreak('1.4.2')
    git(dir, ['mv', SPEC_PATH, 'contracts/kernel/openapi.z.json'])
    const seen: Array<[string, string]> = []
    const problems = gate.gateStagedSpecs(dir, { compare: (o, n) => { seen.push([o, n]); return breaking() } })
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe(spec('1.4.2', true))
    expect(seen[0][1]).toBe(spec('1.4.2', false))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('contracts/kernel/openapi.z.json')
  })

  // Round-2 verifier HIGH: renamed AND mostly rewritten is below git's rename
  // similarity (staged as D + A); the registry name pairs it instead.
  it('a staged rename+rewrite below rename similarity is paired via contracts/registry.json', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '')
    dir = mkdtempSync(join(tmpdir(), 'contracts-gate-staged-'))
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'test'])
    mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true })
    const reg = (file: string) => JSON.stringify({ specs: [{ name: 'x', type: 'openapi', file, status: 'active', owner: 'gov' }] })
    const big = JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1.0.0' },
      paths: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/p${i}`, { get: { responses: { '200': { description: 'ok' } } } }])) }, null, 2)
    writeFileSync(join(dir, SPEC_PATH), big)
    writeFileSync(join(dir, 'contracts', 'registry.json'), reg(SPEC_PATH))
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'base'])
    git(dir, ['rm', '-q', SPEC_PATH])
    mkdirSync(join(dir, 'contracts', 'kernel'), { recursive: true }) // git rm drops the emptied dir
    const small = JSON.stringify({ openapi: '3.1.0', info: { title: 'rewritten', version: '1.0.0' }, paths: {} })
    writeFileSync(join(dir, 'contracts/kernel/openapi.z.json'), small)
    writeFileSync(join(dir, 'contracts', 'registry.json'), reg('contracts/kernel/openapi.z.json'))
    git(dir, ['add', '-A'])
    const seen: Array<[string, string]> = []
    const problems = gate.gateStagedSpecs(dir, { compare: (o, n) => { seen.push([o, n]); return breaking() } })
    expect(seen).toEqual([[big, small]])
    expect(problems).toHaveLength(1)
  })

  it('a non-breaking verdict passes regardless of version', () => {
    vi.stubEnv('CONTRACTS_ALLOW_BREAKING', '')
    dir = stagedBreak('1.4.2')
    expect(gate.gateStagedSpecs(dir, { compare: clean })).toEqual([])
  })
})
