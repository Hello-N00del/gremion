// @vitest-environment node
//
// TASK-028 (TRD-099): a working copy that has not been set up must fail the
// app-port binding check and the hygiene check's g2 with "run setup first" --
// never with a security-invariant failure it did not measure. And the
// setup-first answer must fire ONLY on absent files: a real non-loopback
// binding in a set-up working copy is still a FAIL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { FILE_SETS, SERVICE, isLoopback, main, portViolations } from '../../scripts/check-app-port-binding.mjs'
import { missingLocalEnvFiles, LOCAL_ENV_FILES, SETUP_FIRST } from '../../../scripts/env/local-setup.mjs'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const PORT_CHECK = path.join(REPO_ROOT, 'gremion-ui', 'scripts', 'check-app-port-binding.mjs')
const HYGIENE = path.join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs')
// TASK-040: gremion-ui lives in the per-colour app tier, so the copy carries
// the app file and its dev layer beside the root files.
const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.override.yml',
  'docker-compose.prod.yml',
  'docker-compose.app.yml',
  'docker-compose.app.dev.yml',
]

// Windows only allows symlinkSync without elevation/Developer Mode; probe once
// and skip the symlink-dependent tests with a loud reason instead of failing
// on an environment limitation unrelated to the behaviour under test.
const symlinksSupported = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'symlink-probe-'))
  try {
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
if (!symlinksSupported) {
  console.warn(
    '[check-app-port-binding.test] symlinkSync is not permitted on this host ' +
      '(Windows without admin/Developer Mode) -- skipping the symlink-dependent cases',
  )
}

const dockerUp = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0

let tmp: string

/** A copy of the composition, with none of the local env files. */
function composeCopy(): string {
  for (const f of COMPOSE_FILES) cpSync(path.join(REPO_ROOT, f), path.join(tmp, f))
  return tmp
}

// Time budget for the two docker tests (R26-FLAKES, R27 scope). Each runs the
// port-check CLI on a SET-UP tree, and the CLI renders the composition twice
// (`docker compose ... config` for the dev and the prod file set). Measured
// 2026-09-28 on the 16-CPU dev box, "loaded" = 32 CPU-spinning + 4 file-I/O node
// processes on top of the other agents on the box:
//
//   the port-check CLI on a SET-UP tree   idle p95 0.73 s (n=5)   loaded 49.8-63.8 s (n=6, p95 >= 63.8 s)
//   `docker version` alone (daemon trip)  idle p95 0.16 s (n=5)   loaded 2.6-12.5 s (n=6)
//   the docker tests themselves           idle 0.54-1.48 s (n=10) loaded 24.2 / 39.4 s (one loaded file run)
//
// They ran on the 5 s default and failed an integration gate at 8.7 s. The
// test budget is 3x the loaded p95, rounded up; the CLI's own spawn timeout sits
// 10 s under it, so a hung render fails on the status assertion (and is killed)
// instead of being cut off by vitest. No global raise.
const DOCKER_RENDER_MS = 195_000

function runCli(script: string, root: string, timeout = 120_000) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, GREMION_REPO_ROOT: root },
    timeout,
  })
}

/**
 * An env for the hygiene script whose PATH provably holds no tool at all: one
 * empty scratch directory, and every case-variant of PATH (Windows' `Path`)
 * dropped so none can leak the parent's search path back in. The script needs
 * nothing from PATH to start -- it is launched by absolute process.execPath and
 * never spawns `node` by name -- so every tool it does spawn (git, kubectl,
 * bats) is absent. The old PATH, `path.dirname(process.execPath)`, only lacked
 * git by accident of this box's layout: where node and git share a directory
 * (/usr/bin), git was found and the "no git" tests ran with git.
 */
function emptyPathEnv(root: string): NodeJS.ProcessEnv {
  const bin = path.join(tmp, 'empty-path-bin')
  mkdirSync(bin)
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v
  env.PATH = bin
  env.GREMION_REPO_ROOT = root
  return env
}

// Time budget for the three tests that run the WHOLE hygiene script on a clone
// (R26-FLAKES r4, R28). The kubectl g2 test failed integration gate d3f8ad6 at
// 129 s: its spawn timeout (120 s, equal to the test's own) killed the run, and
// the empty output then read as "expected '' to match /dev: render FAILED/" --
// a cut-off run misreported as a g2 verdict. Measured 2026-09-29 on the 16-CPU
// dev box, no extra load, other agents running:
//
//   git clone --shared of the repo           1.0-2.0 s (n=5)
//   the hygiene run, real `bats` on PATH     30.7 / 43.8 s (n=2); the vitest test 51.0 s
//   the hygiene run, bats stub on PATH       13.0-18.8 s (n=3)
//   the two PATH-stripped runs (no tools)    6.3 s / 2.9 s (one file run)
//
// Cause: check a9 (`bats --version`) cold-starts a bash through the Windows
// .cmd shim (17.3 s of an idle 29.5 s run, measured in hygiene-j.test.ts). The
// g2 test asserts g2 only, so its run gets a stub `bats` first on PATH that
// leaves a marker (asserted, so a stub nothing resolves cannot silently cost the
// time again). Everything else -- the script, kubectl, git, the clone -- is real.
//
// The loaded numbers are the ones packages/edge-routers/test/hygiene-j.test.ts
// measured for this same script with this same stub: 16 CPU-spinning processes
// 198.7-275.2 s per run (n=11), the heaviest level at which it completes. The
// child timeout is 3x that worst sample (the same 840 s), git 30 s >= 3x its
// loaded worst (7.6 s), and each test's budget is the sum of its children's
// timeouts plus 30 s, so a slow child always fails first, by name, via
// runHygiene's completion check. No global raise.
const GIT_CLONE_MS = 30_000
const HYGIENE_RUN_MS = 840_000
const HYGIENE_TEST_MS = GIT_CLONE_MS + HYGIENE_RUN_MS + 30_000

/** A fresh shared clone of this repository under the test's tmp dir. */
function cloneRepo(): string {
  const clone = path.join(tmp, 'clone')
  const cl = spawnSync('git', ['clone', '-q', '--shared', REPO_ROOT, clone], { encoding: 'utf8', timeout: GIT_CLONE_MS })
  expect(cl.status, `git clone: status=${cl.status} signal=${cl.signal} ${cl.error?.message ?? ''}\n${cl.stderr}`).toBe(0)
  return clone
}

/**
 * The parent env with GREMION_REPO_ROOT set and a stub `bats` first on PATH
 * (under whatever case the parent spells the key). The stub answers
 * `--version` at once and touches `usedMarker`.
 */
function batsStubEnv(root: string): { env: NodeJS.ProcessEnv; usedMarker: string } {
  const bin = path.join(tmp, 'bats-stub-bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'bats.cmd'), '@type nul > "%~dp0used"\r\n@echo Bats 0.0.0 (port-binding test stub)\r\n')
  writeFileSync(path.join(bin, 'bats'), '#!/bin/sh\n: > "$(dirname "$0")/used"\necho "Bats 0.0.0 (port-binding test stub)"\n', {
    mode: 0o755,
  })
  const env: NodeJS.ProcessEnv = { ...process.env, GREMION_REPO_ROOT: root }
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) ?? 'PATH'
  env[key] = env[key] ? `${bin}${path.delimiter}${env[key]}` : bin
  return { env, usedMarker: path.join(bin, 'used') }
}

// Printed only by a run that got to the end of the script.
const HYGIENE_REPORT = /^\[kernel-hygiene\] (OK — \d+ checks passed|\d+\/\d+ check\(s\) FAILED:)/m

/**
 * Run the real hygiene script and return its combined output. Fails, naming the
 * exit, unless the run COMPLETED (exit 0 or 1 with its report line printed): a
 * killed or crashed run has no verdicts, and reading one as "no g2 line" is how
 * a timeout used to surface as a wrong-verdict assertion.
 */
function runHygiene(env: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [HYGIENE], { encoding: 'utf8', env, timeout: HYGIENE_RUN_MS })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const completed = !res.error && !res.signal && (res.status === 0 || res.status === 1) && HYGIENE_REPORT.test(out)
  expect(
    completed,
    `the hygiene run did not complete: status=${res.status} signal=${res.signal} error=${res.error?.message ?? '-'}\n${out.slice(-2000)}`,
  ).toBe(true)
  return out
}

/**
 * The precondition the PATH-stripped tests rest on: `tool` cannot be resolved
 * from `env` in `cwd` (the hygiene script's own cwd for its git calls). Asserted
 * before the verdicts, so a host where the tool is still reachable fails here,
 * by name, instead of passing or failing for the wrong reason.
 */
function expectUnresolvable(tool: string, env: NodeJS.ProcessEnv, cwd: string): void {
  const probe = spawnSync(tool, ['--version'], { env, cwd, encoding: 'utf8' })
  const code = probe.error && 'code' in probe.error ? probe.error.code : undefined
  expect(
    code,
    `${tool} must NOT be resolvable on the test's PATH (${env.PATH}); it ran: ${probe.stdout}`,
  ).toBe('ENOENT')
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'task028-setup-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('missingLocalEnvFiles (the D1 preflight)', () => {
  it('names both files on an empty tree, in declaration order', () => {
    expect(missingLocalEnvFiles(tmp)).toEqual(['.env', 'legal/legal.env'])
    expect(LOCAL_ENV_FILES).toEqual(['.env', 'legal/legal.env'])
  })

  it('names only legal/legal.env when .env exists', () => {
    writeFileSync(path.join(tmp, '.env'), 'A=1\n')
    expect(missingLocalEnvFiles(tmp)).toEqual(['legal/legal.env'])
  })

  it('is empty once both files exist (an EMPTY file is present, not absent)', () => {
    writeFileSync(path.join(tmp, '.env'), '')
    mkdirSync(path.join(tmp, 'legal'))
    writeFileSync(path.join(tmp, 'legal', 'legal.env'), '')
    expect(missingLocalEnvFiles(tmp)).toEqual([])
  })

  it('does NOT call a directory at .env absent -- that is broken, not un-set-up', () => {
    mkdirSync(path.join(tmp, '.env'))
    expect(missingLocalEnvFiles(tmp)).not.toContain('.env')
  })

  it.skipIf(!symlinksSupported)('treats a dangling symlink as absent', () => {
    symlinkSync(path.join(tmp, 'nowhere'), path.join(tmp, '.env'))
    expect(missingLocalEnvFiles(tmp)).toContain('.env')
  })

  it('refuses an empty root instead of answering for the cwd', () => {
    expect(() => missingLocalEnvFiles('')).toThrow(/root/)
  })
})

describe('check-app-port-binding on a working copy that is not set up', () => {
  it('main() returns non-zero with the setup-first text and no security finding', () => {
    const root = composeCopy()
    writeFileSync(path.join(root, '.env'), 'A=1\n') // .env present, legal/legal.env absent
    const lines: string[] = []
    const orig = { error: console.error, warn: console.warn, info: console.info }
    console.error = console.warn = console.info = (...a: unknown[]) => void lines.push(a.join(' '))
    let rc: number
    try {
      rc = main({ root })
    } finally {
      Object.assign(console, orig)
    }
    const out = lines.join('\n')
    expect(rc).not.toBe(0)
    expect(out).toContain(SETUP_FIRST)
    expect(out).toContain('legal/legal.env')
    expect(out).not.toContain('non-loopback')
    expect(out).not.toContain('SAFETY')
  })

  it('the CLI exits non-zero with the setup-first text (GREMION_REPO_ROOT override)', () => {
    const res = runCli(PORT_CHECK, composeCopy())
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).not.toBe(0)
    expect(out).toContain(SETUP_FIRST)
    expect(out).not.toContain('non-loopback')
    expect(out).not.toContain('SAFETY')
  })

  it('importing the script runs nothing (import-safe main), in a fresh process', () => {
    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(PORT_CHECK).href)}); console.log('IMPORTED')`,
      ],
      { encoding: 'utf8', env: { ...process.env, GREMION_REPO_ROOT: composeCopy() }, timeout: 60_000 },
    )
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('IMPORTED')
    expect(res.stderr).not.toContain('port-binding')
  })

  it.skipIf(!symlinksSupported)('the CLI still RUNS when invoked through a symlinked path (review finding HIGH)', () => {
    const root = composeCopy()
    const link = path.join(tmp, 'linked-scripts')
    symlinkSync(path.dirname(PORT_CHECK), link)
    const res = runCli(path.join(link, path.basename(PORT_CHECK)), root)
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).not.toBe(0)
    expect(out).toContain(SETUP_FIRST)
  })
})

describe.skipIf(!dockerUp)('check-app-port-binding on a SET-UP working copy (needs docker)', () => {
  it('a real 0.0.0.0 publish is still a FAIL, not a setup-first message', () => {
    const root = composeCopy()
    cpSync(path.join(REPO_ROOT, '.env.example'), path.join(root, '.env'))
    mkdirSync(path.join(root, 'legal'))
    writeFileSync(path.join(root, 'legal', 'legal.env'), '')
    // Publish gremion-ui on every interface in the dev file set (TASK-040:
    // the app tier's dev layer is the file that publishes its ports).
    writeFileSync(
      path.join(root, 'docker-compose.app.dev.yml'),
      'services:\n  gremion-ui:\n    ports:\n      - "3999:3000"\n',
    )
    const res = runCli(PORT_CHECK, root, DOCKER_RENDER_MS - 10_000)
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).toBe(1)
    expect(out).toContain('non-loopback')
    expect(out).not.toContain(SETUP_FIRST)
  }, DOCKER_RENDER_MS)
})

describe.skipIf(!dockerUp)('the stderr second net answers setup-first ONLY for the local env files (needs docker)', () => {
  it('a missing env_file that is NOT one of them is a render ERROR, not "run setup first"', () => {
    const root = composeCopy()
    cpSync(path.join(REPO_ROOT, '.env.example'), path.join(root, '.env'))
    mkdirSync(path.join(root, 'legal'))
    writeFileSync(path.join(root, 'legal', 'legal.env'), '')
    writeFileSync(
      path.join(root, 'docker-compose.app.dev.yml'),
      'services:\n  gremion-ui:\n    env_file: [secrets/typo.env]\n',
    )
    const res = runCli(PORT_CHECK, root, DOCKER_RENDER_MS - 10_000)
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).toBe(1)
    expect(out).toContain('ERROR')
    expect(out).not.toContain(SETUP_FIRST)
    expect(out).not.toContain('not a security finding')
  }, DOCKER_RENDER_MS)
})

const kubectlUp = spawnSync('kubectl', ['version', '--client'], { encoding: 'utf8' }).status === 0

describe.skipIf(!kubectlUp)('kernel-hygiene g2 second net (needs kubectl)', () => {
  it(
    'a dev overlay naming a DIFFERENT missing env file is "render FAILED", not "run setup first"',
    () => {
      const clone = cloneRepo()
      writeFileSync(path.join(clone, '.env'), 'A=1\n')
      mkdirSync(path.join(clone, 'legal'), { recursive: true })
      writeFileSync(path.join(clone, 'legal', 'legal.env'), '')
      const k = path.join(clone, 'k8s', 'overlays', 'dev', 'kustomization.yaml')
      writeFileSync(k, readFileSync(k, 'utf8').replace('../../../legal/legal.env', '../../../legal/legl.env'))
      const { env, usedMarker } = batsStubEnv(clone)
      const out = runHygiene(env)
      const g2 = out.split('\n').find((l) => l.includes('✗ g2 ')) ?? ''
      expect(g2).toMatch(/dev: render FAILED/)
      expect(g2).not.toContain(SETUP_FIRST)
      expect(existsSync(usedMarker), 'the hygiene run never resolved the bats stub').toBe(true)
    },
    HYGIENE_TEST_MS,
  )
})

describe('kernel-hygiene g2 on a working copy that is not set up', () => {
  it(
    'reports the dev overlay as NOT CHECKED with the setup-first text, before any render',
    () => {
      // A fresh clone of this repository: exactly what a new contributor has.
      const clone = cloneRepo()
      expect(missingLocalEnvFiles(clone)).toEqual(['.env', 'legal/legal.env'])
      // PATH without kubectl: the preflight must answer before a render is tried,
      // so the verdict cannot depend on whether kustomize is installed.
      const env = emptyPathEnv(clone)
      expectUnresolvable('kubectl', env, clone)
      const out = runHygiene(env)
      const g2 = out.split('\n').find((l) => l.includes('✗ g2 ')) ?? ''
      expect(out).toMatch(/\[kernel-hygiene\] \d+\/\d+ check\(s\) FAILED:/)
      expect(g2).toMatch(/dev: NOT CHECKED/)
      expect(g2).toContain(SETUP_FIRST)
      expect(g2).toContain('.env')
      expect(g2).not.toMatch(/dev: render FAILED/)
      expect(out).not.toContain('non-loopback')
      expect(out).not.toContain('SAFETY')
    },
    HYGIENE_TEST_MS,
  )

  // Merge train 4 (TASK-034 x TASK-028): section (j) read `git ls-files` at
  // module load, outside check(). On a PATH without git that threw before
  // the report, so g2's setup-first line never printed. A check may FAIL on a
  // missing tool; it must never abort the run and take every other verdict
  // with it.
  it(
    'completes without git on PATH: every check reports, j2-j4 fail loudly as "threw", none aborts the run',
    () => {
      const clone = cloneRepo()
      const env = emptyPathEnv(clone)
      expectUnresolvable('git', env, clone)
      const out = runHygiene(env)
      expect(out, 'an uncaught throw escaped check()').not.toMatch(/node:internal|^\s+at .*kernel-hygiene-check\.mjs/m)
      // Every check() in the script reported: the denominator is the number of
      // check( calls, so a run cut short by a top-level throw cannot pass.
      const declared = (readFileSync(HYGIENE, 'utf8').match(/^check\(/gm) ?? []).length
      expect(declared).toBeGreaterThan(40)
      expect(out).toMatch(new RegExp(`\\[kernel-hygiene\\] \\d+/${declared} check\\(s\\) FAILED:`))
      const lines = out.split('\n')
      for (const id of ['j2', 'j3', 'j4']) {
        const line = lines.find((l) => l.includes(`✗ ${id} `)) ?? ''
        expect(line, `${id} must fail, not pass, when it cannot list the tracked files`).toMatch(/threw/)
      }
      expect(lines.find((l) => l.includes('✗ g2 ')) ?? '').toMatch(/dev: NOT CHECKED/)
    },
    HYGIENE_TEST_MS,
  )
})

// TASK-040: gremion-ui and gremion-public live in the per-colour app tier
// (docker-compose.app.yml), and the dev layer that publishes :3001/:3002 is
// docker-compose.app.dev.yml. These pin the file sets and the verdict on a
// render shaped like `docker compose config --format json`.

const port = (host_ip: string | undefined, published: string, target = 3000) => ({
  mode: 'ingress',
  ...(host_ip === undefined ? {} : { host_ip }),
  target,
  published,
  protocol: 'tcp',
})

describe('check-app-port-binding — file sets', () => {
  it('dev renders the app file plus the dev layer that publishes the ports, as DEV_APP does', () => {
    const dev = FILE_SETS.find((s: { name: string }) => s.name === 'dev')
    expect(dev?.args).toEqual(expect.arrayContaining(['docker-compose.app.yml', 'docker-compose.app.dev.yml']))
    expect(dev?.args).not.toContain('docker-compose.yml')
    expect(dev?.env).toMatchObject({ STACK: 'dev', COLOUR: 'blue', IMAGE_TAG: 'dev', COMPOSE_PROFILES: '*' })
  })

  it('prod renders the app file alone, once per colour, with every profile', () => {
    const prod = FILE_SETS.filter((s: { name: string }) => s.name.startsWith('prod'))
    expect(prod.map((s: { env: { COLOUR: string } }) => s.env.COLOUR).toSorted()).toEqual(['blue', 'green'])
    for (const s of prod) {
      expect(s.args.filter((a: string) => a.endsWith('.yml'))).toEqual(['docker-compose.app.yml'])
      expect(s.env.COMPOSE_PROFILES).toBe('*')
    }
  })

  it('never renders the root state files, which no longer carry gremion-ui', () => {
    for (const s of FILE_SETS) {
      expect(s.args).not.toContain('docker-compose.override.yml')
      expect(s.args).not.toContain('docker-compose.prod.yml')
    }
  })
})

describe('check-app-port-binding — portViolations', () => {
  it('accepts loopback-only bindings on every service', () => {
    const parsed = {
      services: {
        [SERVICE]: { ports: [port('127.0.0.1', '3001'), port('::1', '3001')] },
        'gremion-public': { ports: [port('127.0.0.1', '3002')] },
      },
    }
    expect(portViolations(parsed, 'dev')).toEqual([])
  })

  it('accepts a render with zero published ports (the host colours)', () => {
    expect(portViolations({ services: { [SERVICE]: {}, 'gremion-public': { ports: [] } } }, 'prod-blue')).toEqual([])
  })

  it('flags an unset host_ip (0.0.0.0) on gremion-ui', () => {
    const v = portViolations({ services: { [SERVICE]: { ports: [port(undefined, '3001')] } } }, 'dev')
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('gremion-ui publishes 0.0.0.0:3001')
  })

  it('flags a non-loopback bind on any other app service (gremion-public :3002)', () => {
    const v = portViolations(
      { services: { [SERVICE]: {}, 'gremion-public': { ports: [port('0.0.0.0', '3002')] } } },
      'dev',
    )
    expect(v).toEqual([expect.stringContaining('gremion-public publishes 0.0.0.0:3002')])
  })

  it('fails a render without gremion-ui: the wrong file set is not a clean one', () => {
    expect(portViolations({ services: { postgres: {} } }, 'dev')).toEqual([
      expect.stringContaining("service 'gremion-ui' absent from the dev render"),
    ])
    expect(portViolations({}, 'prod-green')).toHaveLength(1)
  })

  it('isLoopback: 127/8 and ::1 only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('[::1]')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })
})
