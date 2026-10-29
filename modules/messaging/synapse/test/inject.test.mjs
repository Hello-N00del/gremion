// TASK-198 (scratch-proof 7c finding): the realm-key injection. With a key,
// jwt_config.secret carries the PEM; without one, JWT login is disabled in a
// shape Synapse still LOADS -- its JWTConfig.read_config reads
// jwt_config["secret"] whenever the jwt_config block exists (1.160), so the
// key must stay present (empty). Popping it crash-looped Synapse instead of
// degrading, and the probe then reported a dead listener, not the missing arm.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
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
