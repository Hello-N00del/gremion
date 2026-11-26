// The SYNAPSE_JWT_LOGIN switch (on|off, default on) of the render shim and the probe.
//   on / unset: the render is byte-identical to the one recorded before the switch existed
//               (fixtures/render-on*.golden.yaml), and the probe judges what it always judged.
//   off:        neither jwt_config nor oidc_providers is rendered, no issuer and no OIDC secret
//               is needed, and the probe is UNHEALTHY while a JWT or SSO login flow is offered.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROBE, baseEnv, editedTemplate, render, requireTools, scratchDir } from './helpers.mjs'

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8').replaceAll('\r\n', '\n')
const lf = (text) => text.replaceAll('\r\n', '\n')

// The top-level keys of the rendered config with the two login blocks gone.
const OFF_KEYS = [
  'server_name',
  'signing_key_path',
  'database',
  'media_store_path',
  'listeners',
  'federation_domain_whitelist',
  'trusted_key_servers',
  'enable_registration',
  'enable_registration_without_verification',
  'allow_guest_access',
  'public_baseurl',
  'experimental_features',
  'alias_creation_rules',
  'max_event_delay_duration',
  'password_config',
  'report_stats',
  'log_config',
  'media_retention',
  'rc_login',
  'rc_message',
  'rc_delayed_event_mgmt',
  'caches',
  'enable_metrics',
  'web_client_location',
]

const offEnv = (extra = {}) => baseEnv({ SYNAPSE_JWT_LOGIN: 'off', SYNAPSE_KEYCLOAK_ISSUER_URL: '', SYNAPSE_OIDC_CLIENT_SECRET: '', ...extra })

test('switch unset: the render is byte-identical to the recorded one, plain and in a bootstrap window', () => {
  const plain = render(baseEnv())
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(lf(plain.text), fixture('render-on.golden.yaml'))
  const boot = render(baseEnv({ BOOTSTRAP_MODE: '1' }))
  assert.equal(boot.status, 0, boot.stderr)
  assert.equal(lf(boot.text), fixture('render-on-bootstrap.golden.yaml'))
})

test('switch on: the render equals the unset one, byte for byte', () => {
  const on = render(baseEnv({ SYNAPSE_JWT_LOGIN: 'on' }))
  assert.equal(on.status, 0, on.stderr)
  assert.equal(lf(on.text), fixture('render-on.golden.yaml'))
})

test('switch off: the parsed render holds exactly the expected top-level keys', () => {
  const r = render(offEnv())
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(Object.keys(r.cfg), OFF_KEYS)
})

test('switch off: needs no issuer and no OIDC secret, and never reads a named secret file', () => {
  const r = render(offEnv({ SYNAPSE_OIDC_CLIENT_SECRET_FILE: join(scratchDir(), 'absent') }))
  assert.equal(r.status, 0, r.stderr)
  const unset = offEnv()
  delete unset.SYNAPSE_KEYCLOAK_ISSUER_URL
  delete unset.SYNAPSE_OIDC_CLIENT_SECRET
  const u = render(unset)
  assert.equal(u.status, 0, u.stderr)
  assert.deepEqual(Object.keys(u.cfg), OFF_KEYS)
})

test('switch off: an issuer and an OIDC secret that are set still reach nothing in the render', () => {
  const r = render(baseEnv({ SYNAPSE_JWT_LOGIN: 'off' }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.text.includes('oidcTESTsecret02'), false)
  assert.equal(r.text.includes('idp.example.org'), false)
  assert.deepEqual(Object.keys(r.cfg), OFF_KEYS)
})

test('switch off: every other guarantee of the render still holds', () => {
  const r = render(offEnv())
  assert.equal(r.status, 0, r.stderr)
  const c = r.cfg
  assert.equal(c.database.name, 'psycopg2')
  assert.equal(c.server_name, 'chat.example.org')
  assert.equal(c.enable_registration, false)
  assert.deepEqual(c.federation_domain_whitelist, [])
  assert.equal(c.alias_creation_rules[0].user_id, '@gremion-admin-bot:chat.example.org')
  assert.equal(c.registration_shared_secret, undefined)
  const boot = render(offEnv({ BOOTSTRAP_MODE: '1' }))
  assert.equal(boot.status, 0, boot.stderr)
  assert.equal(boot.cfg.registration_shared_secret, 'regTESTsecret03')
})

test('switch off: the other required keys are still refused by name', () => {
  for (const key of ['SYNAPSE_SERVER_NAME', 'SYNAPSE_DB_PASSWORD', 'SYNAPSE_ADMIN_BOT_USER_ID']) {
    const r = render(offEnv({ [key]: '' }))
    assert.notEqual(r.status, 0, `${key}= rendered`)
    assert.match(r.stderr, new RegExp(key))
    assert.equal(r.text, null)
  }
})

test('anything but on or off is refused by name and nothing is rendered', () => {
  for (const bad of ['ON', 'Off', 'true', '0', 'yes', '', ' off']) {
    const r = render(baseEnv({ SYNAPSE_JWT_LOGIN: bad }))
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(bad)}`)
    assert.match(r.stderr, /SYNAPSE_JWT_LOGIN/)
    assert.equal(r.text, null)
  }
})

test('switch off: a render that still carries a login block is refused by its YAML key', () => {
  // a quoted key is not the shape the strip removes; the post-render assertion must still see it
  const tpl = editedTemplate((t) => t.replace(/^jwt_config:/m, '"jwt_config":'))
  const r = render(offEnv(), { template: tpl })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /jwt_config/)
  assert.equal(r.text, null)
  const sso = editedTemplate((t) => `${t}\ncas_config:\n  enabled: true\n`)
  const s = render(offEnv(), { template: sso })
  assert.notEqual(s.status, 0)
  assert.match(s.stderr, /cas_config/)
  assert.equal(s.text, null)
})

// ---- the probe ----

const JWT = { type: 'org.matrix.login.jwt' }
const SSO = (id) => ({ type: 'm.login.sso', identity_providers: [{ id, name: 'Gremion' }] })
const APP_SERVICE = { type: 'm.login.application_service' }

function probe(body, { raw = false, env = {} } = {}) {
  requireTools(['sh', 'curl', 'python3'])
  const f = join(scratchDir(), 'login.json')
  writeFileSync(f, raw ? body : JSON.stringify(body))
  const r = spawnSync('sh', [PROBE], { env: { PATH: process.env.PATH, SYNAPSE_PROBE_URL: `file://${f}`, ...env }, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const OFF = { SYNAPSE_JWT_LOGIN: 'off' }

test('probe, switch off: a JWT login flow is UNHEALTHY and named', () => {
  const r = probe({ flows: [JWT, APP_SERVICE] }, { env: OFF })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /org\.matrix\.login\.jwt/)
})

test('probe, switch off: an SSO flow, with or without a provider list, is UNHEALTHY and named', () => {
  const withIdp = probe({ flows: [SSO('oidc-keycloak'), APP_SERVICE] }, { env: OFF })
  assert.equal(withIdp.status, 1, withIdp.out)
  assert.match(withIdp.out, /m\.login\.sso/)
  const bare = probe({ flows: [{ type: 'm.login.sso' }] }, { env: OFF })
  assert.equal(bare.status, 1, bare.out)
  assert.match(bare.out, /m\.login\.sso/)
})

test('probe, switch off: a login list without a JWT or SSO flow is healthy', () => {
  assert.equal(probe({ flows: [APP_SERVICE] }, { env: OFF }).status, 0)
  assert.equal(probe({ flows: [] }, { env: OFF }).status, 0)
})

test('probe, switch off: an unreachable listener and a body that is not a flows document still fail', () => {
  assert.equal(probe('not json', { raw: true, env: OFF }).status, 1)
  assert.equal(probe('{"versions":["v1.11"]}', { raw: true, env: OFF }).status, 1)
  const r = spawnSync('sh', [PROBE], {
    env: { PATH: process.env.PATH, SYNAPSE_PROBE_URL: 'http://192.0.2.1:8008/_matrix/client/v3/login', SYNAPSE_PROBE_MAX_TIME: '2', ...OFF },
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
})

test('probe: unset and on judge what they always judged (JWT and oidc-keycloak both offered)', () => {
  const good = { flows: [{ type: 'm.login.token' }, SSO('oidc-keycloak'), JWT] }
  assert.equal(probe(good).status, 0)
  assert.equal(probe(good, { env: { SYNAPSE_JWT_LOGIN: 'on' } }).status, 0)
  const bare = { flows: [APP_SERVICE] }
  assert.equal(probe(bare).status, 1)
  assert.equal(probe(bare, { env: { SYNAPSE_JWT_LOGIN: 'on' } }).status, 1)
})

test('probe: a switch value other than on or off is UNHEALTHY and named', () => {
  const r = probe({ flows: [APP_SERVICE] }, { env: { SYNAPSE_JWT_LOGIN: 'maybe' } })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /SYNAPSE_JWT_LOGIN/)
})
