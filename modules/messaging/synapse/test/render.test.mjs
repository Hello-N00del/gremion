// TDD 1 (TASK-198): the rendered homeserver.yaml. PostgreSQL only, federation
// off, no media offload or RTC focus, the registration secret only in a
// bootstrap render, and the key-fetch URL derived from the issuer.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { TEMPLATE, baseEnv, render, scratchDir } from './helpers.mjs'

test('the template names no SQLite database', () => {
  const text = readFileSync(TEMPLATE, 'utf8')
  assert.doesNotMatch(text, /sqlite3/)
  assert.doesNotMatch(text, /homeserver\.db/)
})

test('renders a psycopg2 database with the section 5.2 keys, pool 5/10 and the password in args', () => {
  const r = render(baseEnv())
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.text, /sqlite3|homeserver\.db/)
  const db = r.cfg.database
  assert.equal(db.name, 'psycopg2')
  assert.deepEqual(
    { ...db.args },
    { user: 'synapse', password: 'dbpwTESTvalue01', dbname: 'synapse', host: 'messaging-postgres', port: 5432, cp_min: 5, cp_max: 10 },
  )
})

test('the database defaults are messaging-postgres/5432/synapse/synapse when the keys are unset', () => {
  const env = baseEnv()
  for (const k of ['SYNAPSE_DB_HOST', 'SYNAPSE_DB_PORT', 'SYNAPSE_DB_NAME', 'SYNAPSE_DB_USER']) delete env[k]
  const r = render(env)
  assert.equal(r.status, 0, r.stderr)
  const a = r.cfg.database.args
  assert.deepEqual([a.host, a.port, a.dbname, a.user], ['messaging-postgres', 5432, 'synapse', 'synapse'])
})

test('a non-integer SYNAPSE_DB_PORT is refused by name and nothing is rendered', () => {
  const r = render(baseEnv({ SYNAPSE_DB_PORT: '5432x' }))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /SYNAPSE_DB_PORT/)
  assert.equal(r.text, null, 'a refused render must not leave a config behind')
})

test('the non-secret keys are rendered non-empty: server name, base URL, issuers, provider name', () => {
  const r = render(baseEnv())
  assert.equal(r.status, 0, r.stderr)
  const c = r.cfg
  assert.equal(c.server_name, 'chat.example.org')
  assert.equal(c.public_baseurl, 'https://chat.example.org/')
  assert.equal(c.jwt_config.issuer, 'https://idp.example.org/auth/realms/council')
  assert.deepEqual(c.jwt_config.audiences, ['gremion-ui'])
  const p = c.oidc_providers[0]
  assert.equal(p.idp_id, 'keycloak')
  assert.equal(p.idp_name, 'Gremion')
  assert.equal(p.issuer, 'https://idp.example.org/auth/realms/council')
  assert.equal(p.token_endpoint, 'https://idp.example.org/auth/realms/council/protocol/openid-connect/token')
  assert.equal(p.client_secret, 'oidcTESTsecret02')
})

test('federation is off: empty whitelist, no trusted key servers, a client-only listener', () => {
  const r = render(baseEnv())
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.cfg.federation_domain_whitelist, [])
  assert.deepEqual(r.cfg.trusted_key_servers, [])
  assert.equal(r.cfg.listeners.length, 1)
  const names = r.cfg.listeners[0].resources.flatMap((x) => x.names)
  assert.deepEqual(names, ['client'])
})

test('no media storage provider and no RTC focus, even with the dropped S3 switch set', () => {
  const r = render(baseEnv({ SYNAPSE_MEDIA_S3_ENABLED: 'true', LIVEKIT_JWT_SERVICE_URL: 'https://lk.example.org' }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.cfg.media_storage_providers, undefined)
  assert.doesNotMatch(JSON.stringify(r.cfg), /rtc_foci|livekit/i)
})

test('registration_shared_secret is rendered only with BOOTSTRAP_MODE=1', () => {
  const off = render(baseEnv())
  assert.equal(off.status, 0, off.stderr)
  assert.equal(off.cfg.registration_shared_secret, undefined)
  assert.doesNotMatch(off.text, /regTESTsecret03/)
  const on = render(baseEnv({ BOOTSTRAP_MODE: '1' }))
  assert.equal(on.status, 0, on.stderr)
  assert.equal(on.cfg.registration_shared_secret, 'regTESTsecret03')
})

test('the key-fetch URL is derived from the issuer realm when blank; an explicit one wins', () => {
  const d = render(baseEnv({ SYNAPSE_KEYCLOAK_FETCH_URL: '' }), { args: ['--fetch-url'] })
  assert.equal(d.status, 0, d.stderr)
  assert.equal(d.stdout.trim(), 'http://keycloak:8080/auth/realms/council')
  const e = render(baseEnv({ SYNAPSE_KEYCLOAK_FETCH_URL: 'http://idp-stub:8080/realm' }), { args: ['--fetch-url'] })
  assert.equal(e.status, 0, e.stderr)
  assert.equal(e.stdout.trim(), 'http://idp-stub:8080/realm')
})

test('the OIDC client secret file wins over the env value; a named file that cannot be read is refused', () => {
  const dir = scratchDir()
  const f = join(dir, 'synapse-oidc-client-secret')
  writeFileSync(f, 'fileTESTsecret04\n')
  const r = render(baseEnv({ SYNAPSE_OIDC_CLIENT_SECRET_FILE: f }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.cfg.oidc_providers[0].client_secret, 'fileTESTsecret04')
  const missing = render(baseEnv({ SYNAPSE_OIDC_CLIENT_SECRET_FILE: join(dir, 'absent') }))
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /SYNAPSE_OIDC_CLIENT_SECRET_FILE/)
})
