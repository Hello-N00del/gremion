// TASK-198 TDD 6 + 8: the chat module's Synapse in the state project, and the
// lint-synapse wiring. Renders with docker compose config (never `up`).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { REPO_ROOT, readEnvFile } from './compose-edge.mjs'
import {
  POOLED_FIXTURE,
  START_PERIOD_S,
  moduleSuites,
  renderExample,
  renderProfileOn,
  renderViolations,
  repoRelative,
  requiredFormViolations,
  wiringViolations,
} from './check-synapse-stack.mjs'
import { CARVE_LINT_TARGETS } from './verify/suites/carve-lint.mjs'

const fx = readEnvFile(POOLED_FIXTURE)
const CTX = { stack: fx.STACK, project: fx.COMPOSE_PROJECT_NAME, domain: fx.PLATFORM_DOMAIN }
const COMPOSE = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
const MAKEFILE = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8')

let cached = null
const profileOn = () => (cached ??= renderProfileOn())

test('profile on: messaging-postgres and matrix render exactly as granted', () => {
  const r = profileOn()
  assert.ok(r.services.matrix && r.services['messaging-postgres'], `services: ${Object.keys(r.services).join(', ')}`)
  assert.deepEqual(renderViolations(r, CTX), [])
})

test('repo-relative paths are POSIX on every host: a win32 render (backslashes, drive letter) compares equal', () => {
  const root = 'C:\\Users\\op\\kernel'
  assert.equal(repoRelative('C:\\Users\\op\\kernel\\modules\\messaging\\synapse', { root, pathImpl: path.win32 }), 'modules/messaging/synapse')
  assert.equal(
    repoRelative('c:\\users\\op\\kernel\\modules\\messaging\\synapse\\postgres-init\\10-synapse-db.sh', { root, pathImpl: path.win32 }),
    'modules/messaging/synapse/postgres-init/10-synapse-db.sh',
  )
  assert.equal(repoRelative('/srv/kernel/modules/messaging/synapse', { root: '/srv/kernel', pathImpl: path.posix }), 'modules/messaging/synapse')
  // Outside the repo stays visibly outside (never silently equal to a module path).
  assert.equal(repoRelative('D:\\elsewhere\\synapse', { root, pathImpl: path.win32 }), 'D:/elsewhere/synapse')
})

test('profile on: matrix is the honest probe with its start_period, and messaging-postgres the :ro init bind', () => {
  const r = profileOn()
  assert.deepEqual(r.services.matrix.healthcheck.test, ['CMD', '/synapse-healthcheck.sh'])
  assert.equal(START_PERIOD_S, 30 * 7 + 30)
  const init = r.services['messaging-postgres'].volumes.filter((v) => v.type === 'bind')
  assert.equal(init.length, 1)
  assert.equal(init[0].read_only, true)
})

test('the render guard catches ports, a bind, a named volume, a wrong probe, a second network and a missing key', () => {
  const base = profileOn()
  const cases = [
    [(r) => (r.services.matrix.ports = [{ target: 8008, published: '8008' }]), /publishes ports/],
    [(r) => r.services.matrix.volumes.push({ type: 'bind', source: REPO_ROOT, target: '/src' }), /exactly synapse-data/],
    // the one bind matrix may carry is the host's secrets directory, read-only, never created by Docker, never in the repo
    [(r) => (r.services.matrix.volumes.find((v) => v.type === 'bind').read_only = false), /secrets bind is not read-only/],
    [(r) => (r.services.matrix.volumes.find((v) => v.type === 'bind').bind = { create_host_path: true }), /would create a missing host directory/],
    [(r) => (r.services.matrix.volumes.find((v) => v.type === 'bind').target = '/run/secrets/other'), /secrets bind targets \/run\/secrets\/other/],
    [(r) => (r.services.matrix.volumes.find((v) => v.type === 'bind').source = path.join(REPO_ROOT, 'secrets')), /want <GREMION_ROOT>\/etc\/secrets\/synapse/],
    [(r) => r.services.matrix.volumes.splice(r.services.matrix.volumes.findIndex((v) => v.type === 'bind'), 1), /exactly synapse-data:\/data and one read-only bind/],
    [(r) => delete r.services.matrix.environment.SYNAPSE_OIDC_CLIENT_SECRET_FILE, /lacks SYNAPSE_OIDC_CLIENT_SECRET_FILE/],
    [(r) => (r.volumes['synapse-data'].name = 'gremion_synapse_data'), /realises as gremion_synapse_data/],
    [(r) => (r.services.matrix.healthcheck.test = ['CMD-SHELL', 'curl -sf http://127.0.0.1:8008/_matrix/client/versions']), /versions/],
    [(r) => (r.services.matrix.healthcheck.start_period = '60s'), /start_period/],
    // matrix is on _edge AND _state since the pilot routes /_matrix to it: dropping _edge, adding the
    // socket proxy's network, or a state-only messaging-postgres gaining _edge are each a violation
    [(r) => (r.services.matrix.networks = { state: null }), /matrix: networks .*, want .*_edge, .*_state\] only/],
    [(r) => (r.services.matrix.networks = { state: null, edge: null, socket: null }), /matrix: networks/],
    [(r) => (r.services['messaging-postgres'].networks = { state: null, edge: null }), /messaging-postgres: networks/],
    [(r) => delete r.services.matrix.environment.SYNAPSE_DB_PASSWORD, /lacks SYNAPSE_DB_PASSWORD/],
    [(r) => (r.services.matrix.environment.LIVEKIT_JWT_SERVICE_URL = 'x'), /dropped key/],
    [(r) => (r.services['messaging-postgres'].labels['org.gremion.postgres'] = 'module:chat'), /module:messaging/],
    [(r) => (r.services['messaging-postgres'].volumes.find((v) => v.type === 'bind').read_only = false), /read-only/],
    [(r) => delete r.services.matrix.depends_on, /service_healthy/],
    [(r) => (r.services.matrix.profiles = []), /profiles/],
    [(r) => (r.services['messaging-postgres'].healthcheck.test = ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U x']), /synapse database/],
    [(r) => (r.services['messaging-postgres'].image = 'registry.example.org/other-db:1'), /kernel pin/],
  ]
  for (const [mutate, want] of cases) {
    const r = structuredClone(base)
    mutate(r)
    const v = renderViolations(r, CTX)
    assert.ok(v.some((x) => want.test(x)), `${want.source}: not caught; got ${JSON.stringify(v)}`)
  }
})

test('matrix carries a login limit per address sized for one shared address, and the pin catches its removal', () => {
  const base = profileOn()
  const env = base.services.matrix.environment
  // every request reaches Synapse from the one app container address: the default 5-login burst locks the 6th user out
  assert.equal(String(env.SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND), '1')
  assert.equal(String(env.SYNAPSE_RC_LOGIN_ADDRESS_BURST), '100')
  // the per-account limit stays at the render default
  assert.equal(env.SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND, undefined)
  assert.equal(env.SYNAPSE_RC_LOGIN_ACCOUNT_BURST, undefined)
  for (const key of ['SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND', 'SYNAPSE_RC_LOGIN_ADDRESS_BURST']) {
    const r = structuredClone(base)
    delete r.services.matrix.environment[key]
    const v = renderViolations(r, CTX)
    assert.ok(v.some((x) => x.includes(`lacks ${key}`)), `${key}: removal not caught; got ${JSON.stringify(v)}`)
  }
})

test('profile off: .env.example as shipped renders, without the chat services', () => {
  const r = renderExample()
  assert.ok(Object.keys(r.services ?? {}).length > 0)
  assert.equal(r.services.matrix, undefined)
  assert.equal(r.services['messaging-postgres'], undefined)
})

test('no ${VAR:?} in the chat service blocks; the scan catches one', () => {
  assert.deepEqual(requiredFormViolations(COMPOSE), [])
  const broken = COMPOSE.replace('SYNAPSE_DB_PASSWORD: ${SYNAPSE_DB_PASSWORD}', 'SYNAPSE_DB_PASSWORD: ${SYNAPSE_DB_PASSWORD:?required}')
  assert.notEqual(broken, COMPOSE, 'the fixture edit found nothing to replace')
  assert.ok(requiredFormViolations(broken).some((x) => /SYNAPSE_DB_PASSWORD:\?/.test(x)))
})

test('wiring: lint-synapse in lint: and CARVE_LINT_TARGETS (docker), every module suite in its recipe, synapse-proof in neither', () => {
  const suites = moduleSuites()
  assert.ok(suites.length >= 4, `module suites: ${suites.join(', ')}`)
  assert.deepEqual(wiringViolations(MAKEFILE, CARVE_LINT_TARGETS, suites), [])
})

test('wiring guard: catches lint-synapse off lint:, a missing carve row, synapse-proof in lint: and an unnamed suite', () => {
  const suites = moduleSuites()
  const off = MAKEFILE.replace(/^(lint:[^\n]*) lint-synapse/m, '$1')
  assert.notEqual(off, MAKEFILE)
  assert.ok(wiringViolations(off, CARVE_LINT_TARGETS, suites).some((x) => /prerequisite of `lint:`/.test(x)))
  const noRow = CARVE_LINT_TARGETS.filter((t) => t.name !== 'lint-synapse')
  assert.ok(wiringViolations(MAKEFILE, noRow, suites).some((x) => /no lint-synapse row/.test(x)))
  const inLint = MAKEFILE.replace(/^(lint:[^\n]*)$/m, '$1 synapse-proof')
  assert.ok(wiringViolations(inLint, CARVE_LINT_TARGETS, suites).some((x) => /synapse-proof is in `lint:`/.test(x)))
  const extra = [...suites, 'modules/messaging/synapse/test/unlisted.test.mjs']
  assert.ok(wiringViolations(MAKEFILE, CARVE_LINT_TARGETS, extra).some((x) => /unlisted\.test\.mjs/.test(x)))
})

test('every suite lint-synapse runs declares at least one top-level test(', () => {
  for (const s of [...moduleSuites(), 'scripts/check-synapse-stack.test.mjs']) {
    const n = (readFileSync(path.join(REPO_ROOT, s), 'utf8').match(/^test\(/gm) ?? []).length
    assert.ok(n > 0, `${s} declares no top-level test(`)
  }
})
