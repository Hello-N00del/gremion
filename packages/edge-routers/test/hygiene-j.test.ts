// Hygiene section (j) — j2, j3, j4 each watched RED on a seeded plant (TDD 8).
//
// The REAL scripts/kernel-hygiene-check.mjs runs against throwaway copies of
// the tracked tree (working-tree bytes, `git add`ed into a fresh repository
// so the script's git calls see the same index), once unplanted and once per
// plant. The script is never given a switch to scan somewhere else: a guard
// with a "look elsewhere" knob is a guard that can be pointed at nothing.
//
// Every planted name is assembled from parts, so neither this file nor the
// repository ever contains the literal the guard hunts for, and the planted
// credential is an obvious fake with no token shape at all.
//
// Determinism (round-3 fix of a flake that failed a DIFFERENT case on every
// run, each time next to a vitest "Worker exited unexpectedly"):
//   - A run of the script counts only if it COMPLETED: exit 0 or 1 and its
//     `[kernel-hygiene]` report line printed. A killed or crashed run used to
//     read as "zero j hits", so an outer kill of the worker surfaced as a
//     random case's assertion failure (whichever case was in flight), and the
//     unplanted case could pass on a run that checked nothing.
//   - The file no longer makes one full-tree copy per case. Thirteen serial
//     copy+add+run cycles took ~3 min, long enough for an outer time-box to
//     kill the worker mid-case, and the 13-tree teardown alone overran the
//     10 s default hook timeout. Now a fixed pool of LANES copies is made
//     once; every case runs on one lane, then the lane is restored to its
//     exact original bytes and PROVEN restored (after `git add -A` its index
//     tree hashes to the unplanted baseline again) before the next case.
//     Cases on different lanes share nothing; the script only reads.
//   - All the work happens in beforeAll; each `it` asserts on its recorded
//     outcome, so the verdicts do not depend on scheduling.
//   - Every child has an explicit timeout sized from measurements and no
//     inherited GIT_* variable (a hook's GIT_INDEX_FILE would point a copy's
//     `git add` at the real repository's index).
//   - The scratch directory is unique to this run; teardown removes only it.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './helpers.js'

const CDN_TOKEN_VAR = ['CF', 'API', 'TOKEN'].join('_')
const PLANNER = ['edge', 'plan'].join('-')

// Measured on the native-Windows intake box (2026-09-27, serial): git
// ls-files / init / add -A of the ~1.6k-file tree 0.03-3.2 s each, one tree
// copy ~1.6-2.0 s, one full hygiene run 8.3-12.1 s. Three lanes in parallel:
// see the commit message. The child timeouts are ~5x the worst observation;
// the setup budget covers the copies plus every case at the child timeout's
// fraction that three lanes can actually reach.
const LANES = 3
const GIT_TIMEOUT_MS = 30_000
const HYGIENE_TIMEOUT_MS = 90_000
const SETUP_TIMEOUT_MS = 200_000

// The tree copies belong under the worktree's own git-excluded scratch space,
// never under the OS temp dir (house MEDIUM finding: hygiene-j scratch trees).
// mkdtempSync needs the parent to exist; the run's own directory is unique, so
// two concurrent runs never share (or delete) each other's trees.
const SCRATCH_ROOT = join(REPO_ROOT, '.scratch', 'hygiene-j')

/** The child environment: the parent's, minus every GIT_* variable. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  return env
}

interface Exit {
  status: number | null
  signal: NodeJS.Signals | null
  error: Error | null
  timedOut: boolean
  out: string
  stdout: string
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<Exit> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let error: Error | null = null
    let timedOut = false
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const done = (status: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      resolve({ status, signal, error, timedOut, stdout, out: `${stdout}\n${stderr}` })
    }
    child.on('error', (e) => {
      error = e
      if (child.pid === undefined) done(null, null) // never started: no 'close' is owed
    })
    child.on('close', done)
  })
}

function describeExit(e: Exit): string {
  return `status=${e.status} signal=${e.signal} timedOut=${e.timedOut} error=${e.error?.message ?? '-'}`
}

async function git(cwd: string, args: string[]): Promise<string> {
  const e = await run('git', args, cwd, GIT_TIMEOUT_MS)
  if (e.error || e.timedOut || e.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${describeExit(e)}\n${e.out.slice(-2000)}`)
  return e.stdout
}

/**
 * Run the real script on `tree` and return its `✗ jN` lines. Throws unless
 * the run COMPLETED: exit 0 (all OK) or 1 (some check failed) with the report
 * line printed. Killed, timed out or crashed is not a result.
 */
async function runHygiene(tree: string): Promise<string[]> {
  await git(tree, ['add', '-A'])
  const e = await run(process.execPath, ['scripts/kernel-hygiene-check.mjs'], tree, HYGIENE_TIMEOUT_MS)
  const reported = /^\[kernel-hygiene\] (OK — \d+ checks passed|\d+\/\d+ check\(s\) FAILED:)/m.test(e.out)
  if (e.error || e.timedOut || e.signal || (e.status !== 0 && e.status !== 1) || !reported) {
    throw new Error(`the hygiene run did not complete: ${describeExit(e)} report=${reported}\n${e.out.slice(-2000)}`)
  }
  return e.out.split('\n').filter((l) => /✗ j\d/.test(l))
}

/** One tree copy. A plant is undone byte-exactly, then proven undone. */
class Lane {
  readonly tree: string
  baseline = ''
  private readonly originals = new Map<string, Buffer>()
  private readonly created: string[] = []

  constructor(readonly root: string, files: readonly string[]) {
    this.tree = join(root, 'tree')
    for (const rel of files) {
      const src = join(REPO_ROOT, rel)
      if (!existsSync(src)) continue // deleted in the working tree
      mkdirSync(dirname(join(this.tree, rel)), { recursive: true })
      copyFileSync(src, join(this.tree, rel))
    }
  }

  async init(): Promise<void> {
    await git(this.tree, ['init', '-q'])
    this.baseline = await this.stagedTree()
  }

  /** The index's tree hash after staging everything in the working tree. */
  async stagedTree(): Promise<string> {
    await git(this.tree, ['add', '-A'])
    return (await git(this.tree, ['write-tree'])).trim()
  }

  edit(rel: string, from: string | RegExp, to: string): void {
    const p = join(this.tree, rel)
    const before = readFileSync(p)
    if (!this.originals.has(rel)) this.originals.set(rel, before)
    const text = before.toString('utf8')
    const after = text.replace(from, to)
    if (after === text) throw new Error(`plant did not land in ${rel}`)
    writeFileSync(p, after)
  }

  create(rel: string, content: string): void {
    const p = join(this.tree, rel)
    if (existsSync(p)) throw new Error(`${rel} already exists; a plant must be new`)
    const firstNewDir = mkdirSync(dirname(p), { recursive: true })
    this.created.push(firstNewDir ?? p)
    writeFileSync(p, content)
  }

  async restore(): Promise<void> {
    for (const [rel, bytes] of this.originals) writeFileSync(join(this.tree, rel), bytes)
    for (const p of this.created) rmSync(p, { recursive: true, force: true })
    this.originals.clear()
    this.created.length = 0
    const now = await this.stagedTree()
    if (now !== this.baseline) throw new Error(`lane ${this.root} was not restored: tree ${now} != baseline ${this.baseline}`)
  }
}

type Plant = (lane: Lane) => void
type Outcome = { lines: string[] } | { error: Error }

const cases: Record<string, Plant> = {
  clean: () => {},
  dies: (l) => l.edit('scripts/kernel-hygiene-check.mjs', /^/, "throw new Error('hygiene died mid-run')\n"),
  j2Token: (l) => l.edit('infra/host/templates/env/app.env.tmpl', /$/, `\n${CDN_TOKEN_VAR}=obviously-fake-not-a-token\n`),
  j2Dns01: (l) =>
    l.edit('infra/host/templates/env/ops.env.tmpl', /$/, `\n${[['CLOUD', 'FLARE'].join(''), 'DNS', 'API', 'TOKEN'].join('_')}=obviously-fake-not-a-token\n`),
  j3Carrier: (l) => {
    l.create(`gremion-ui/src/lib/server/tenant/provisioner/${PLANNER}.ts`, 'export const plan = 1\n')
    l.edit('packages/edge-routers/src/index.ts', /$/, `\n// see ../${PLANNER}\n`)
  },
  j3Pascal: (l) => l.edit('packages/edge-routers/src/index.ts', /$/, `\n// ${['Edge', 'Plan'].join('')} was here\n`),
  j4Second: (l) =>
    l.edit('docker-compose.yml', '      - traefik-acme:/letsencrypt\n', '      - traefik-acme:/letsencrypt\n      - ${GREMION_ROOT}/etc/edge:/srv/edge-copy:ro\n'),
  j4Writable: (l) =>
    l.edit('docker-compose.yml', /(source: \$\{GREMION_ROOT\}\/etc\/edge\n(?:.*\n){0,2}?\s*)read_only: true/, '$1read_only: false'),
  j4OtherService: (l) =>
    l.edit('docker-compose.yml', /(\n {2}gremion-public:\n)/, '$1    volumes:\n      - ${GREMION_ROOT}/etc/edge:/etc/traefik/dynamic:ro\n'),
  j4Ancestor: (l) => l.edit('infra/host/ops/docker-compose.yml', '      - "/:/rootfs:ro"\n', '      - "/:/rootfs:rw"\n'),
  j4VolumesFrom: (l) => l.edit('docker-compose.yml', /(\n {2}gremion-public:\n)/, '$1    volumes_from:\n      - traefik\n'),
  j4Normalised: (l) =>
    l.edit('docker-compose.yml', '      - traefik-acme:/letsencrypt\n', '      - traefik-acme:/letsencrypt\n      - ${GREMION_ROOT}/etc//edge/:/srv/x:ro\n'),
}

let runDir = ''
const lanes: Lane[] = []
const outcomes = new Map<string, Outcome>()

async function runCase(lane: Lane, plant: Plant): Promise<Outcome> {
  try {
    plant(lane)
    return { lines: await runHygiene(lane.tree) }
  } catch (error) {
    return { error: error as Error }
  } finally {
    await lane.restore() // a lane that cannot be restored fails the whole setup
  }
}

beforeAll(async () => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  runDir = mkdtempSync(join(SCRATCH_ROOT, 'run-'))
  const files = (await git(REPO_ROOT, ['ls-files', '-z'])).split('\0').filter(Boolean)
  for (let i = 0; i < LANES; i++) lanes.push(new Lane(join(runDir, `lane-${i}`), files))
  await Promise.all(lanes.map((l) => l.init()))
  const queue = Object.entries(cases)
  // allSettled, not all: a lane that fails must not leave the other lanes'
  // children running (and holding files) while teardown deletes their trees.
  const settled = await Promise.allSettled(
    lanes.map(async (lane) => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) outcomes.set(next[0], await runCase(lane, next[1]))
    }),
  )
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (failed) throw failed.reason
}, SETUP_TIMEOUT_MS)

afterAll(() => {
  // retries: on Windows a just-closed git/node child or a file scanner can
  // hold a handle for a moment after exit (transient EBUSY/EPERM)
  if (runDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  try {
    rmdirSync(SCRATCH_ROOT) // only when empty: a concurrent run's directory keeps it
  } catch {
    // not empty (another run is live) or already gone: either way not ours to remove
  }
}, SETUP_TIMEOUT_MS)

/** The `✗ jN` lines of a case; rethrows the case's own failure. */
function lines(name: keyof typeof cases): string[] {
  const o = outcomes.get(name)
  if (!o) throw new Error(`case ${name} never ran`)
  if ('error' in o) throw o.error
  return o.lines
}

const ids = (ls: string[]) => [...new Set(ls.map((l) => /✗ (j\d)/.exec(l)![1]!))].sort((a, b) => a.localeCompare(b))

describe('kernel hygiene (j) — TDD 8', () => {
  it('declares j2, j3 and j4, and no check bans Vaultwarden (B18 j1 is dropped: R8-4, TRD-263)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs'), 'utf8')
    for (const id of ['j2', 'j3', 'j4']) expect(src.split(`check('${id} `)).toHaveLength(2)
    // the kernel's own pre-existing j1 is the k8s sentinel check, not B18's j1
    expect(src).toMatch(/check\('j1 the k8s apex/)
    expect(src).not.toMatch(/check\('[a-z]\d+[^']*vaultwarden/i)
  })

  it('is GREEN on the unplanted tree (zero hits today)', () => {
    expect(lines('clean')).toEqual([])
  })

  it('a hygiene run that dies before its report is an error, never a zero-hit (clean) run', () => {
    expect(() => lines('dies')).toThrow(/did not complete/)
  })

  it('j2 goes RED on a planted CDN API token variable in the kernel', () => {
    const out = lines('j2Token')
    expect(ids(out)).toEqual(['j2'])
    expect(out.join('\n')).toContain('infra/host/templates/env/app.env.tmpl')
  })

  it('j3 goes RED on a planted planner carrier (a file of that name, and a reference to it)', () => {
    const out = lines('j3Carrier')
    expect(ids(out)).toEqual(['j3'])
    expect(out.join('\n')).toContain(`${PLANNER}.ts`)
    expect(out.join('\n')).toContain('packages/edge-routers/src/index.ts')
  })

  it('j4 goes RED on a SECOND etc/edge mount', () => {
    const out = lines('j4Second')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/2 mounts/)
  })

  it('j4 goes RED on a WRITABLE etc/edge mount', () => {
    const out = lines('j4Writable')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/not read-only/)
  })

  it('j4 goes RED on an etc/edge mount held by a service other than traefik', () => {
    const out = lines('j4OtherService')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/gremion-public/)
  })

  it('j2 also catches the DNS-01 spelling lego reads (a <CDN>_DNS_API_TOKEN)', () => {
    const out = lines('j2Dns01')
    expect(ids(out)).toEqual(['j2'])
    expect(out.join('\n')).toContain('infra/host/templates/env/ops.env.tmpl')
  })

  it('j3 is case-insensitive (a PascalCase planner reference)', () => {
    expect(ids(lines('j3Pascal'))).toEqual(['j3'])
  })

  it('j4 catches a WRITABLE ancestor bind in the ops project (a second view of etc/edge)', () => {
    const out = lines('j4Ancestor')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/ancestor of etc\/edge, WRITABLE/)
  })

  it('j4 catches volumes_from naming traefik', () => {
    const out = lines('j4VolumesFrom')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/volumes_from names traefik/)
  })

  it('j4 normalises the source: an etc//edge spelling is still a second mount', () => {
    const out = lines('j4Normalised')
    expect(ids(out)).toEqual(['j4'])
    expect(out.join('\n')).toMatch(/2 mounts/)
  })

  it('every case ran, on identical lane copies, and every lane ended back on the unplanted baseline', async () => {
    expect([...outcomes.keys()].sort()).toEqual(Object.keys(cases).sort())
    expect(new Set(lanes.map((l) => l.baseline)).size).toBe(1)
    for (const l of lanes) expect(await l.stagedTree()).toBe(l.baseline)
  })
})
