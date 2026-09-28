// TDD 2 (TASK-198): the render shim fails closed. A non-psycopg2 engine is
// refused naming the engine, each blank required key by name, and no refusal
// prints a secret. jwt_config.secret is empty after the render by design (the
// entrypoint injects it later; the probe judges it), so it alone is no refusal.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baseEnv, editedTemplate, render } from './helpers.mjs'

const REQUIRED = [
  'SYNAPSE_SERVER_NAME',
  'MATRIX_PUBLIC_URL',
  'SYNAPSE_DB_HOST',
  'SYNAPSE_DB_PORT',
  'SYNAPSE_DB_NAME',
  'SYNAPSE_DB_USER',
  'SYNAPSE_DB_PASSWORD',
  'SYNAPSE_KEYCLOAK_ISSUER_URL',
  'SYNAPSE_OIDC_CLIENT_SECRET',
]

const SQLITE_BLOCK = 'database:\n  name: sqlite3\n  args:\n    database: /data/homeserver.db\n'

test('a template whose database is SQLite is refused, naming sqlite3', () => {
  const tpl = editedTemplate((t) => t.replace(/^database:\n(?:[ ].*\n)+/m, SQLITE_BLOCK))
  const r = render(baseEnv(), { template: tpl })
  assert.notEqual(r.status, 0, 'a SQLite render must not pass')
  assert.match(r.stderr, /sqlite3/)
  assert.equal(r.text, null, 'a refused render must not leave a config behind')
})

test('any other engine name is refused naming it, even with the PostgreSQL args intact', () => {
  const tpl = editedTemplate((t) => t.replace(/^  name: psycopg2$/m, '  name: psycopg2cffi'))
  const r = render(baseEnv(), { template: tpl })
  assert.notEqual(r.status, 0, 'a non-psycopg2 engine must not pass')
  assert.match(r.stderr, /psycopg2cffi/)
  assert.equal(r.text, null)
})

test('each blank required key is refused by name', () => {
  for (const key of REQUIRED) {
    const r = render(baseEnv({ [key]: '' }))
    assert.notEqual(r.status, 0, `${key}= rendered`)
    assert.match(r.stderr, new RegExp(key), `${key}: the refusal does not name it: ${r.stderr}`)
    assert.equal(r.text, null, `${key}: a refused render left a config behind`)
  }
})

test('the post-render assertion refuses a rendered database without a password, by its YAML key', () => {
  const tpl = editedTemplate((t) => t.replace(/^\s+password: "\$\{SYNAPSE_DB_PASSWORD\}"\n/m, ''))
  const r = render(baseEnv(), { template: tpl })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /database\.args\.password/)
})

test('no refusal prints a secret value', () => {
  const env = baseEnv({ SYNAPSE_SERVER_NAME: '' })
  const r = render(env)
  assert.notEqual(r.status, 0)
  for (const k of ['SYNAPSE_DB_PASSWORD', 'SYNAPSE_OIDC_CLIENT_SECRET', 'SYNAPSE_REGISTRATION_SHARED_SECRET']) {
    assert.ok(!r.stderr.includes(env[k]), `${k}'s value is on stderr`)
    assert.ok(!r.stdout.includes(env[k]), `${k}'s value is on stdout`)
  }
  const tpl = editedTemplate((t) => t.replace(/^database:\n(?:[ ].*\n)+/m, SQLITE_BLOCK))
  const s = render(baseEnv(), { template: tpl })
  assert.ok(!s.stderr.includes('oidcTESTsecret02') && !s.stderr.includes('dbpwTESTvalue01'), s.stderr)
})

test('an empty jwt_config.secret alone is not refused (the entrypoint injects it)', () => {
  const r = render(baseEnv({ KEYCLOAK_JWT_PUBLIC_KEY: 'ignored-by-the-shim' }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.cfg.jwt_config.secret, '')
  assert.equal(r.cfg.jwt_config.enabled, true)
})

test('a value that could break out of its YAML quoting is refused by key: newline, CR, double quote, backslash', () => {
  const cases = [
    { key: 'SYNAPSE_REGISTRATION_SHARED_SECRET', value: 'abc\nenable_registration: true', extra: {} },
    { key: 'SYNAPSE_REGISTRATION_SHARED_SECRET', value: 'abc"\nenable_registration: true', extra: { BOOTSTRAP_MODE: '1' } },
    { key: 'SYNAPSE_DB_PASSWORD', value: 'pw"x', extra: {} },
    { key: 'SYNAPSE_OIDC_CLIENT_SECRET', value: 'a\\b', extra: {} },
    { key: 'SYNAPSE_SERVER_NAME', value: 'chat.example.org\r', extra: {} },
  ]
  for (const { key, value, extra } of cases) {
    const r = render(baseEnv({ [key]: value, ...extra }))
    assert.notEqual(r.status, 0, `${key}=${JSON.stringify(value)} rendered`)
    assert.match(r.stderr, new RegExp(key), `${key}: the refusal does not name it`)
    assert.equal(r.text, null)
    assert.ok(!r.stderr.includes(value), `${key}: the refusal prints the value`)
  }
})

test('registration stays closed: a template that opens it is refused', () => {
  const tpl = editedTemplate((t) => t.replace(/^enable_registration: false$/m, 'enable_registration: true'))
  const r = render(baseEnv(), { template: tpl })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /enable_registration/)
})

test('a rate-limit knob that is only a dot is refused by name', () => {
  const r = render(baseEnv({ SYNAPSE_RC_MESSAGE_PER_SECOND: '.' }))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /SYNAPSE_RC_MESSAGE_PER_SECOND/)
})
