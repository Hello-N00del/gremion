// scripts/kernel-hygiene-check.test.mjs -- g9's compose surfaces (TASK-040-FU 3).
//
// g9 ("no shipped manifest or deploy doc names a gremion image outside
// ghcr.io/hello-n00del") listed its root compose files by hand, and when
// TASK-040 moved gremion-ui / gremion-public / migrate into
// docker-compose.app.yml the list was not updated: a Docker-Hub coordinate
// planted there passed the whole run. Its compose surface is now DERIVED and
// ROOT-ANCHORED: the tracked docker-compose*.yml at the repository root plus
// infra/host/<name>/docker-compose.yml -- never a recursive search, which
// would sweep in test fixtures (packages/*/test/fixtures/compose,
// test/host/fixtures/**).
//
// Fast by design: g9Surfaces / g9Check run on a small fixture git repository
// under the worktree's git-excluded .scratch/ (never the OS temp dir), not the
// whole hygiene check (minutes under load). The planted coordinates are
// assembled from parts, so no file in the repository carries the literal g9
// hunts for.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { g9Check, g9Surfaces } from './lib/image-surfaces.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(REPO_ROOT, '.scratch', 'hygiene-g9')

const BAD_UI = `${['gremion', 'ui'].join('/')}:0.1.0`
const BAD_PUBLIC = `${['gremion', 'public'].join('/')}:0.1.0`
const GHCR = (s) => `ghcr.io/hello-n00del/gremion-${s}:\${IMAGE_TAG:-dev}`

// git with no inherited GIT_* (a hook or a worktree would point it elsewhere)
function git(cwd, ...args) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const CLEAN = {
  // the five first-party coordinates g9's vacuity guard needs to see
  'docker-compose.yml': `services:\n  legal:\n    image: ${GHCR('legal')}\n  vector:\n    image: ${GHCR('vector')}\n`,
  'docker-compose.prod.yml': `services:\n  fallback:\n    image: ${GHCR('fallback')}\n`,
  'docker-compose.app.yml': `services:\n  ui:\n    build: .\n    image: ${GHCR('ui')}\n  public:\n    image: ${GHCR('public')}\n`,
  'docker-compose.app.dev.yml': 'services:\n  ui:\n    build: .\n',
  'infra/host/mail/docker-compose.yml': 'services:\n  mail:\n    image: stalwart:1\n',
  // as in the real tree, the docs also name the ui image, so a compose plant
  // is reported as the plant and not as g9's vacuity guard
  'README.md': `# fixture\n\nPull \`${GHCR('ui')}\`.\n`,
  // decoys: a recursive search would pick these up
  'packages/module-catalogue/test/fixtures/compose/docker-compose.yml': `services:\n  x:\n    image: ${BAD_UI}\n`,
  'test/host/fixtures/pooled/docker-compose.state.yml': `services:\n  x:\n    image: ${BAD_UI}\n`,
  'infra/host/mail/nested/docker-compose.yml': `services:\n  x:\n    image: ${BAD_UI}\n`,
}

let root
let n = 0

/** A fresh fixture repository: CLEAN, then `extra` (tracked), then `untracked`. */
function fixture(extra = {}, untracked = {}) {
  const dir = join(root, `t${++n}`)
  const put = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
  }
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  put({ ...CLEAN, ...extra })
  git(dir, 'add', '-A')
  put(untracked)
  return dir
}

before(() => {
  mkdirSync(SCRATCH, { recursive: true })
  root = mkdtempSync(join(SCRATCH, 'run-'))
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const composeOf = (dir) => g9Surfaces(dir).filter((f) => /docker-compose/.test(f)).toSorted((a, b) => a.localeCompare(b, 'en'))

test('g9 compose surfaces: every tracked root docker-compose*.yml and infra/host/*/docker-compose.yml, no fixtures', () => {
  const dir = fixture({}, { 'docker-compose.untracked.yml': `services:\n  x:\n    image: ${BAD_UI}\n` })
  assert.deepEqual(composeOf(dir), [
    'docker-compose.app.dev.yml',
    'docker-compose.app.yml',
    'docker-compose.prod.yml',
    'docker-compose.yml',
    'infra/host/mail/docker-compose.yml',
  ])
})

test('g9 is GREEN on the clean fixture (positive control: decoys and untracked files are not read)', () => {
  assert.equal(g9Check(fixture({}, { 'docker-compose.untracked.yml': `services:\n  x:\n    image: ${BAD_UI}\n` })), null)
})

test('g9 sees a Docker-Hub gremion image planted in docker-compose.app.yml (the brief\'s plant)', () => {
  const app = CLEAN['docker-compose.app.yml'].replace(GHCR('ui'), BAD_UI)
  const verdict = g9Check(fixture({ 'docker-compose.app.yml': app }))
  assert.match(verdict ?? '', /docker-compose\.app\.yml:4 image: gremion\/ui:0\.1\.0/)
})

test('g9 derives its surfaces: a root compose file nobody has heard of yet is scanned', () => {
  const verdict = g9Check(fixture({ 'docker-compose.tier9.yml': `services:\n  t:\n    image: ${BAD_PUBLIC}\n` }))
  assert.match(verdict ?? '', /docker-compose\.tier9\.yml:3 image: gremion\/public:0\.1\.0/)
})

test('g9 derives its surfaces: a new infra/host/<name>/docker-compose.yml is scanned', () => {
  const verdict = g9Check(fixture({ 'infra/host/relay/docker-compose.yml': `services:\n  r:\n    image: ${BAD_PUBLIC}\n` }))
  assert.match(verdict ?? '', /infra\/host\/relay\/docker-compose\.yml:3 image: gremion\/public:0\.1\.0/)
})

test('g9 fails loudly when the root carries no tracked compose file (vacuity)', () => {
  const dir = fixture()
  git(dir, 'rm', '-q', '--cached', 'docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.app.yml', 'docker-compose.app.dev.yml')
  assert.match(g9Check(dir) ?? '', /zero tracked docker-compose\*\.yml at the root/)
})

test('the real tree: g9 reads both app-tier compose files and is GREEN', () => {
  const compose = composeOf(REPO_ROOT)
  for (const f of ['docker-compose.app.yml', 'docker-compose.app.dev.yml']) assert.ok(compose.includes(f), `${f} missing from ${compose.join(', ')}`)
  assert.ok(!compose.some((f) => /fixtures\//.test(f)), `a fixture leaked into the surface: ${compose.join(', ')}`)
  assert.equal(g9Check(REPO_ROOT), null)
})

test('the hygiene check runs g9 through the shared helper, not a private copy', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs'), 'utf8')
  assert.match(src, /import \{[^}]*\bg9Check\b[^}]*\} from '\.\/lib\/image-surfaces\.mjs'/)
  assert.match(src, /check\('g9 [^']*', \(\) =>\s*g9Check\(ROOT\)\)/)
  assert.doesNotMatch(src, /G9_SURFACE_FILES/)
})
