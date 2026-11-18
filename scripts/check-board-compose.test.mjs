// The board leaf in the app compose (docker-compose.app.yml `board-service`): what the render must say, and that the
// leaf starts on exactly that environment.
//
// Four things are pinned here, each a post-condition read out of a real `docker compose config`, never an exit code:
//   1. the shape: profile board, colour alias on _app and _state only, no published port, no Traefik label, the
//      hardening of the other leaves, and a database URL that names the module APP role and never the server admin
//      (the Karenz block revokes CONNECT from that role; a superuser would ignore the revoke);
//   2. the required variables: with the secret or the role password unset or empty the render fails by variable NAME
//      (a recreate without the env must not start a leaf that answers 403 to every call, or one that is refused
//      with 28P01 for every customer while /healthz stays green);
//   3. no leak: a secret reaches only the services that need it, and a refusal names a variable, never a value;
//   4. the leaf boots on the rendered environment: /healthz answers and the guard answers 403 without the secret.
// The password's single source (the file the module lifecycle sets the role from) is test/host/board-compose.bats,
// and its authentication against a real Postgres is modules/board/test/compose-password.integration.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile, renderState } from './compose-edge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_ENV = 'test/host/fixtures/pooled-stack/app-blue.env'
const STATE_ENV = 'test/host/fixtures/pooled-stack/state.env'
// distinctive values, so a leak is a plain substring search (the fixture's own values are not unique)
const SECRET = 'bd-secret-0f3a9c1e7b5d2a48'
const PASSWORD = 'bd-pw-4e6b8d0a2c9f1357'

const render = (profiles, env = {}) =>
  renderState({ envFile: APP_ENV, env: { COMPOSE_PROFILES: profiles, INTERNAL_BOARD_SECRET: SECRET, BOARD_APP_PASSWORD: PASSWORD, ...env } })

test('board-service renders with the profile board only, on _app and _state under its colour alias, hardened like the other leaves', () => {
  const fx = readEnvFile(APP_ENV)
  const withBoard = render('board')
  const svc = withBoard.services['board-service']
  assert.ok(svc, 'board-service is absent from the render with the profile board')
  assert.deepEqual(svc.profiles, ['board'])
  assert.equal(render('production').services['board-service'], undefined, 'board-service renders without its profile')

  assert.deepEqual(Object.keys(svc.networks).sort(), ['app', 'state'])
  for (const att of Object.values(svc.networks)) assert.deepEqual(att.aliases, [`board-service-${fx.COLOUR}`])
  assert.equal(svc.ports, undefined, 'a published port')
  const labels = Array.isArray(svc.labels) ? Object.fromEntries(svc.labels.map((l) => l.split('='))) : (svc.labels ?? {})
  assert.equal(String(labels['traefik.enable']), 'false')
  assert.deepEqual(Object.keys(labels).filter((k) => k.startsWith('traefik.http.')), [])
  assert.deepEqual(svc.cap_drop, ['ALL'])
  assert.ok((svc.security_opt ?? []).includes('no-new-privileges:true'))
  assert.ok(Number(svc.deploy?.resources?.limits?.cpus) > 0 && svc.deploy.resources.limits.memory, 'no resource limits')
  assert.equal(String(svc.environment.PORT), '8080')
  assert.equal(svc.environment.COLOUR, fx.COLOUR)
  // the image is the module's own, built from the repo root
  assert.match(svc.image, /^ghcr\.io\/hello-n00del\/gremion-board:/)
  assert.equal(svc.build?.dockerfile, 'modules/board/Dockerfile')
})

test('GREMION_BOARD_PG_URL names board-postgres and the module APP role, never the server admin; gremion-ui carries the same secret', () => {
  const r = render('board')
  const url = new URL(r.services['board-service'].environment.GREMION_BOARD_PG_URL)
  assert.equal(url.hostname, 'board-postgres')
  assert.equal(url.port, '5432')
  assert.equal(url.pathname, '/postgres', 'the leaf replaces the database name per customer')
  // the role is the lifecycle's: m_<module>_app (packages/tenant-store/src/lifecycle/guards.ts moduleRoles)
  assert.match(readFileSync(join(ROOT, 'packages/tenant-store/src/lifecycle/guards.ts'), 'utf8'), /app: `m_\$\{moduleId\}_app`/)
  assert.equal(decodeURIComponent(url.username), 'm_board_app')
  const state = readEnvFile(STATE_ENV)
  for (const admin of [state.BOARD_PG_USER, 'board', 'postgres']) {
    if (admin) assert.notEqual(decodeURIComponent(url.username), admin, 'the leaf must not connect as the server admin: a superuser ignores the Karenz CONNECT revoke')
  }
  assert.equal(decodeURIComponent(url.password), PASSWORD)
  assert.equal(r.services['board-service'].environment.INTERNAL_BOARD_SECRET, SECRET)

  const ui = r.services['gremion-ui'].environment
  assert.equal(ui.BOARD_BACKEND, 'auto')
  assert.equal(ui.BOARD_SERVICE_URL, `http://board-service-${readEnvFile(APP_ENV).COLOUR}:8080`)
  assert.equal(ui.INTERNAL_BOARD_SECRET, SECRET, 'gremion-ui presents the secret the leaf expects')
})

test('an unset or empty INTERNAL_BOARD_SECRET or BOARD_APP_PASSWORD fails the render by variable name, with or without the profile', () => {
  for (const profiles of ['board', 'production']) {
    for (const { variable, other } of [
      { variable: 'INTERNAL_BOARD_SECRET', other: { BOARD_APP_PASSWORD: PASSWORD } },
      { variable: 'BOARD_APP_PASSWORD', other: { INTERNAL_BOARD_SECRET: SECRET } },
    ]) {
      assert.throws(
        () => renderState({ envFile: APP_ENV, env: { COMPOSE_PROFILES: profiles, ...other, [variable]: '' } }),
        (err) => {
          assert.match(String(err.message), new RegExp(`required variable ${variable} is missing a value`), `${profiles}/${variable}`)
          // a refusal names a variable and never a value (the other secret is set, to a value we can search for)
          for (const v of [SECRET, PASSWORD]) assert.ok(!String(err.message).includes(v), `the refusal for ${variable} carries a secret value`)
          return true
        },
      )
    }
  }
})

test('no leak: the password reaches board-service only, the secret reaches board-service and gremion-ui only', () => {
  const r = render('board')
  const holders = (needle) =>
    Object.entries(r.services)
      .filter(([, svc]) => JSON.stringify(svc).includes(needle))
      .map(([name]) => name)
      .sort()
  assert.deepEqual(holders(PASSWORD), ['board-service'])
  assert.deepEqual(holders(SECRET), ['board-service', 'gremion-ui'])
  // not in a label or an image reference either
  const board = r.services['board-service']
  for (const v of [SECRET, PASSWORD]) {
    assert.ok(!JSON.stringify(board.labels ?? {}).includes(v))
    assert.ok(!String(board.image).includes(v))
  }
})

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

test('the leaf boots on the rendered environment: /healthz answers 200, the guard answers 403 without or with a wrong secret, 400 without tenant headers', async () => {
  const env = render('board').services['board-service'].environment
  // the image layout in a scratch directory: dist/index.js beside migrations/ (modules/board/Dockerfile), the bundle
  // carrying its own dependencies so no node_modules is needed there
  const dir = mkdtempSync(join(tmpdir(), 'bd-board-leaf-'))
  let child
  try {
    const boardRequire = createRequire(join(ROOT, 'modules/board/package.json'))
    const esbuild = boardRequire.resolve('esbuild/bin/esbuild')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    cpSync(join(ROOT, 'modules/board/migrations'), join(dir, 'migrations'), { recursive: true })
    const built = spawnSync(process.execPath, [esbuild, 'src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${join(dir, 'dist/index.js')}`, '--log-level=error', '--banner:js=import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'], {
      cwd: join(ROOT, 'modules/board'),
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(built.status, 0, `esbuild failed: ${built.stderr.slice(0, 400)}`)
    // the bundle is ESM (--format=esm); the scratch directory has no package.json to say so
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')

    const port = await freePort()
    // exactly the rendered environment of the container, only the port is ours
    const childEnv = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env, PORT: String(port) }
    child = spawn(process.execPath, [join(dir, 'dist/index.js')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    let exited = null
    child.once('exit', (code) => (exited = code))

    const until = Date.now() + 10_000
    let health = null
    while (Date.now() < until && exited === null) {
      health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => null)
      if (health) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(health, `no /healthz answer (exit ${exited}); stderr: ${stderr.slice(0, 300).replaceAll(SECRET, '<secret>').replaceAll(PASSWORD, '<password>')}`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })

    const base = `http://127.0.0.1:${port}/api/v1/boards`
    assert.equal((await fetch(base)).status, 403, 'no secret')
    assert.equal((await fetch(base, { headers: { 'x-internal-auth': `${SECRET}x` } })).status, 403, 'a wrong secret')
    assert.equal((await fetch(base, { headers: { 'x-internal-auth': SECRET } })).status, 400, 'the right secret, no tenant headers: the guard goes on to the tenant check')
  } finally {
    if (child) child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
