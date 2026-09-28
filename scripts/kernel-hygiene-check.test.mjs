// scripts/kernel-hygiene-check.test.mjs -- g9's surface list (TASK-040-FU 3).
//
// g9 ("no shipped manifest or deploy doc names a gremion image outside
// ghcr.io/hello-n00del") listed its root compose files by hand, and when
// TASK-040 moved gremion-ui / gremion-public / migrate into
// docker-compose.app.yml the list was not updated: a Docker-Hub coordinate
// planted there passed the whole run. The surface is now every root
// docker-compose*.yml, so a compose file added later cannot fall out again.
//
// The REAL scripts/kernel-hygiene-check.mjs runs, through its own
// GREMION_REPO_ROOT override, on throwaway copies of exactly the surfaces g9
// reads (k8s/, docs/, the root compose files and docs) -- once clean, once per
// plant -- and only its g9 verdict is asserted: the copies are not a whole
// tree, so the other checks' verdicts there mean nothing. A run counts only if
// it COMPLETED (exit 0/1 with its report line).
//
// The planted coordinates are assembled from parts, so no file in the
// repository carries the literal g9 hunts for. The copies live under the
// worktree's git-excluded .scratch/, never the OS temp dir.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs')
const SCRATCH = join(REPO_ROOT, '.scratch', 'hygiene-g9')
// A full hygiene run was 8-12 s on the intake box and far slower under load.
const RUN_TIMEOUT_MS = 180_000

const BAD_UI = `${['gremion', 'ui'].join('/')}:0.1.0`
const BAD_PUBLIC = `${['gremion', 'public'].join('/')}:0.1.0`
const ROOT_DOCS = ['README.md', 'KNOWN_ISSUES.md', 'Makefile', 'package.json']
const ROOT_COMPOSE = /^docker-compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/

/**
 * The child's environment: GREMION_REPO_ROOT at the copy, no GIT_* variable,
 * and no PATH entry that carries a `bats` (the a-checks' `bats --version`
 * costs ~84 s through the npm wrapper on Windows and is not what this tests).
 */
function childEnv(tree) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = (env[pathKey] ?? '')
    .split(delimiter)
    .filter((d) => d && !['bats', 'bats.cmd', 'bats.exe'].some((b) => existsSync(join(d, b))))
    .join(delimiter)
  env.GREMION_REPO_ROOT = tree
  return env
}

function makeTree(root, name) {
  const tree = join(root, name)
  mkdirSync(tree, { recursive: true })
  for (const d of ['k8s', 'docs']) cpSync(join(REPO_ROOT, d), join(tree, d), { recursive: true })
  for (const f of readdirSync(REPO_ROOT)) {
    if (ROOT_COMPOSE.test(f) || ROOT_DOCS.includes(f)) cpSync(join(REPO_ROOT, f), join(tree, f))
  }
  // read at module load by an unrelated check; its absence would crash the run
  for (const d of ['gremion-ui/migrations', 'gremion-ui/migrations-control']) mkdirSync(join(tree, d), { recursive: true })
  return tree
}

/** Run the real script on `tree`; resolve with its `✗ g9` lines. */
function g9Lines(tree) {
  return new Promise((resolve, reject) => {
    let out = ''
    let timedOut = false
    const child = spawn(process.execPath, [SCRIPT], { cwd: tree, env: childEnv(tree), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      const reported = /^\[kernel-hygiene\] (OK — \d+ checks passed|\d+\/\d+ check\(s\) FAILED:)/m.test(out)
      if (timedOut || signal || (status !== 0 && status !== 1) || !reported) {
        reject(new Error(`hygiene run did not complete (status=${status} signal=${signal} timedOut=${timedOut})\n${out.slice(-2000)}`))
        return
      }
      resolve(out.split('\n').filter((l) => /✗ g9 /.test(l)))
    })
  })
}

let root
const results = {}

before(async () => {
  mkdirSync(SCRATCH, { recursive: true })
  root = mkdtempSync(join(SCRATCH, 'run-'))
  const clean = makeTree(root, 'clean')

  // the brief's plant: the app tier's gremion-ui image moved to Docker Hub
  const app = makeTree(root, 'app')
  const appFile = join(app, 'docker-compose.app.yml')
  const src = readFileSync(appFile, 'utf8')
  const planted = src.replace(/ghcr\.io\/hello-n00del\/gremion-ui:\$\{[^}\n]*\}/, BAD_UI)
  assert.notEqual(planted, src, 'docker-compose.app.yml no longer carries the gremion-ui image line this plant replaces')
  writeFileSync(appFile, planted)

  // a root compose file nobody has heard of yet: the list must be derived
  const fresh = makeTree(root, 'fresh')
  writeFileSync(join(fresh, 'docker-compose.tier9.yml'), `services:\n  tier9:\n    image: ${BAD_PUBLIC}\n`)

  const [c, a, f] = await Promise.all([g9Lines(clean), g9Lines(app), g9Lines(fresh)])
  Object.assign(results, { clean: c, app: a, fresh: f })
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test('g9 is GREEN on an unplanted copy of its surfaces (positive control)', () => {
  assert.deepEqual(results.clean, [])
})

test('g9 sees a Docker-Hub gremion image planted in docker-compose.app.yml', () => {
  assert.equal(results.app.length, 1, `expected one g9 failure line, got: ${JSON.stringify(results.app)}`)
  assert.match(results.app[0], /docker-compose\.app\.yml:\d+ image: gremion\/ui:0\.1\.0/)
})

test('g9 derives its compose surfaces: a new root docker-compose.*.yml is scanned too', () => {
  assert.equal(results.fresh.length, 1, `expected one g9 failure line, got: ${JSON.stringify(results.fresh)}`)
  assert.match(results.fresh[0], /docker-compose\.tier9\.yml:3 image: gremion\/public:0\.1\.0/)
})
