// TASK-198 (scratch-proof 7c finding): the realm-key injection. With a key,
// jwt_config.secret carries the PEM; without one, JWT login is disabled in a
// shape Synapse still LOADS -- its JWTConfig.read_config reads
// jwt_config["secret"] whenever the jwt_config block exists (1.160), so the
// key must stay present (empty). Popping it crash-looped Synapse instead of
// degrading, and the probe then reported a dead listener, not the missing arm.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { requireTools, scratchDir } from './helpers.mjs'

const INJECT = fileURLToPath(new URL('../inject-jwt-key.py', import.meta.url))

// Mirrors synapse/config/jwt.py read_config (1.160): the keys it indexes.
const RUN = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("inject", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cfg = {"jwt_config": {"enabled": True, "secret": "", "algorithm": "RS256", "issuer": "https://idp.example.org/r"}}
pem = m.fetch_pem(sys.argv[2]) if sys.argv[2] else None
m.apply(cfg, pem)
jwt = cfg["jwt_config"]
if jwt:
    jwt.get("enabled", False); jwt["secret"]; jwt["algorithm"]
print(json.dumps(cfg))
`

function run(url = '') {
  requireTools(['python3'])
  const r = spawnSync('python3', ['-c', RUN, INJECT, url], { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr, cfg: r.status === 0 ? JSON.parse(r.stdout) : null }
}

// fetch_pem accepts http(s) only (a file:// URL is refused on purpose), so the
// realm document is served from a loopback http server. The child is async
// (spawnSync would block the event loop that answers it) and bypasses any
// ambient HTTP proxy for the loopback fetch.
async function runServed(body) {
  requireTools(['python3'])
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/realm`
    const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
    return await new Promise((resolve) => {
      const child = spawn('python3', ['-c', RUN, INJECT, url], { env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => resolve({ status, stderr, cfg: status === 0 ? JSON.parse(stdout) : null }))
    })
  } finally {
    server.close()
  }
}

test('with the realm key, jwt_config.secret carries it as PEM and stays enabled', async () => {
  const r = await runServed({ realm: 'r', public_key: 'A'.repeat(100) })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.cfg.jwt_config.enabled, true)
  assert.match(r.cfg.jwt_config.secret, /^-----BEGIN PUBLIC KEY-----\nA{64}\nA{36}\n-----END PUBLIC KEY-----\n$/)
})

test('without a key, JWT login is disabled in a shape Synapse still loads (secret present)', () => {
  const r = run('')
  assert.equal(r.status, 0, `Synapse's config read would fail: ${r.stderr}`)
  assert.equal(r.cfg.jwt_config.enabled, false)
  assert.equal(r.cfg.jwt_config.secret, '')
  assert.match(r.stderr, /jwt_config disabled/)
})

test('an unreachable realm or a document without public_key disables JWT login, never crashes', async () => {
  const f = join(scratchDir(), 'realm.json')
  writeFileSync(f, JSON.stringify(['not', 'a', 'realm']))
  const results = [
    ['http://192.0.2.1:9/realm', run('http://192.0.2.1:9/realm')],
    ['a non-object document', await runServed(['not', 'a', 'realm'])],
    ['a document without public_key', await runServed({ realm: 'r' })],
    // file:// is refused outright, even for a readable realm document
    [`file://${f}`, run(`file://${f}`)],
    ['file:///nonexistent/realm.json', run('file:///nonexistent/realm.json')],
  ]
  for (const [what, r] of results) {
    assert.equal(r.status, 0, `${what}: ${r.stderr}`)
    assert.equal(r.cfg.jwt_config.enabled, false, what)
    assert.equal(r.cfg.jwt_config.secret, '', what)
  }
  assert.match(results[3][1].stderr, /not http\(s\)/)
})

// ---- the command line (what the entrypoint runs): no key set yet is exit 3 and the config stays as rendered ----

const RENDERED = 'jwt_config:\n  enabled: true\n  secret: placeholder\n  algorithm: RS256\n'

/** Runs inject-jwt-key.py on a scratch config against `respond(res)` served on loopback (null: nothing listens). */
async function runCli(respond) {
  requireTools(['python3'])
  const dir = scratchDir()
  const cfgPath = join(dir, 'homeserver.yaml')
  writeFileSync(cfgPath, RENDERED)
  let url
  let server = null
  if (respond) {
    server = createServer((_req, res) => respond(res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/realm`
  } else {
    // a port that was just free: nothing listens, the connection is refused
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${probe.address().port}/realm`
    await new Promise((resolve) => probe.close(resolve))
  }
  try {
    const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', KEYCLOAK_FETCH_URL: url }
    return await new Promise((resolve) => {
      const child = spawn('python3', [INJECT, cfgPath], { env })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (status) => resolve({ status, stderr, after: readFileSync(cfgPath, 'utf8') }))
    })
  } finally {
    server?.close()
  }
}

const page = (code, type, body) => (res) => {
  res.statusCode = code
  res.setHeader('content-type', type)
  res.end(body)
}

test('command line: a realm that does not (yet) serve a usable key set exits 3 and leaves the rendered config untouched', async () => {
  const cases = [
    ['an edge fallback page (HTTP 404)', await runCli(page(404, 'text/html', '<html>404 page not found</html>'))],
    ['a 200 body that is not JSON', await runCli(page(200, 'text/html', '<html>starting</html>'))],
    ['a JSON body without a key', await runCli(page(200, 'application/json', JSON.stringify({ realm: 'r' })))],
    ['a JSON array', await runCli(page(200, 'application/json', JSON.stringify(['x'])))],
    ['a public_key that is not base64', await runCli(page(200, 'application/json', JSON.stringify({ public_key: 'not base64 !!' })))],
    ['an empty public_key', await runCli(page(200, 'application/json', JSON.stringify({ public_key: '' })))],
    ['a refused connection', await runCli(null)],
  ]
  for (const [what, r] of cases) {
    assert.equal(r.status, 3, `${what}: exit ${r.status}: ${r.stderr}`)
    assert.equal(r.after, RENDERED, `${what}: the config was written`)
    assert.equal(/jwt_config disabled/.test(r.stderr), false, `${what}: degraded instead of failing`)
  }
})

test('command line: a realm that serves a key set gets it injected as PEM and the config stays enabled', async () => {
  const r = await runCli(page(200, 'application/json', JSON.stringify({ realm: 'r', public_key: 'A'.repeat(100) })))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.after, /enabled: true/)
  assert.match(r.after, /-----BEGIN PUBLIC KEY-----/)
  assert.equal(r.stderr.includes('A'.repeat(20)), false, 'the key is never logged')
})
