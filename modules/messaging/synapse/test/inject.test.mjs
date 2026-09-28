// TASK-198 (scratch-proof 7c finding): the realm-key injection. With a key,
// jwt_config.secret carries the PEM; without one, JWT login is disabled in a
// shape Synapse still LOADS -- its JWTConfig.read_config reads
// jwt_config["secret"] whenever the jwt_config block exists (1.160), so the
// key must stay present (empty). Popping it crash-looped Synapse instead of
// degrading, and the probe then reported a dead listener, not the missing arm.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('with the realm key, jwt_config.secret carries it as PEM and stays enabled', () => {
  const f = join(scratchDir(), 'realm.json')
  writeFileSync(f, JSON.stringify({ realm: 'r', public_key: 'A'.repeat(100) }))
  const r = run(`file://${f}`)
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

test('an unreachable realm or a document without public_key disables JWT login, never crashes', () => {
  const f = join(scratchDir(), 'realm.json')
  writeFileSync(f, JSON.stringify(['not', 'a', 'realm']))
  for (const url of ['http://192.0.2.1:9/realm', `file://${f}`, 'file:///nonexistent/realm.json']) {
    const r = run(url)
    assert.equal(r.status, 0, `${url}: ${r.stderr}`)
    assert.equal(r.cfg.jwt_config.enabled, false, url)
    assert.equal(r.cfg.jwt_config.secret, '', url)
  }
})
