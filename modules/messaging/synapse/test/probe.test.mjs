// TDD 3 (TASK-198, TRD-178): healthcheck.sh is honest. It exits 0 only when
// GET /_matrix/client/v3/login lists the JWT login flow AND the SSO flow names
// the provider oidc-keycloak -- the two arms the entrypoint may silently drop
// when the identity provider is unreachable. /versions would answer 200 either
// way. Bodies come from file:// URLs (curl reads them like any other URL).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { PROBE, requireTools, scratchDir } from './helpers.mjs'

const JWT = { type: 'org.matrix.login.jwt' }
const SSO = (id) => ({ type: 'm.login.sso', identity_providers: [{ id, name: 'Gremion' }] })

function probe(body, { raw = false, url = null, env = {} } = {}) {
  requireTools(['sh', 'curl', 'python3'])
  let target = url
  if (!target) {
    const f = join(scratchDir(), 'login.json')
    writeFileSync(f, raw ? body : JSON.stringify(body))
    target = `file://${f}`
  }
  const t0 = Date.now()
  const r = spawnSync('sh', [PROBE], { env: { PATH: process.env.PATH, SYNAPSE_PROBE_URL: target, ...env }, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 }
}

test('passes when the login flows list jwt and the oidc-keycloak provider', () => {
  const r = probe({ flows: [{ type: 'm.login.token' }, SSO('oidc-keycloak'), JWT] })
  assert.equal(r.status, 0, r.out)
})

test('fails naming jwt when the JWT flow is missing (jwt_config disabled)', () => {
  const r = probe({ flows: [SSO('oidc-keycloak'), { type: 'm.login.token' }] })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /org\.matrix\.login\.jwt/)
})

test('fails when the SSO flow does not list oidc-keycloak, or there is no SSO flow', () => {
  const none = probe({ flows: [JWT] })
  assert.notEqual(none.status, 0)
  assert.match(none.out, /oidc-keycloak/)
  const other = probe({ flows: [JWT, SSO('oidc-other')] })
  assert.notEqual(other.status, 0)
  assert.match(other.out, /oidc-keycloak/)
})

test('tolerates whitespace and key order in the body', () => {
  const body = '\n {  "flows" : [ { "identity_providers": [ {"name":"x", "id" : "oidc-keycloak"} ],\n "type":"m.login.sso" },\n\t{ "type" :  "org.matrix.login.jwt" } ] }  \n'
  const r = probe(body, { raw: true })
  assert.equal(r.status, 0, r.out)
})

test('fails on a body that is not a login-flows document', () => {
  assert.notEqual(probe('{"versions":["v1.11"]}', { raw: true }).status, 0)
  assert.notEqual(probe('not json', { raw: true }).status, 0)
  assert.notEqual(probe('', { raw: true }).status, 0)
})

test('fails on an unreachable URL within its --max-time', () => {
  // TEST-NET-1 (RFC 5737) is never routed: the connect hangs until --max-time.
  const r = probe(null, { url: 'http://192.0.2.1:8008/_matrix/client/v3/login', env: { SYNAPSE_PROBE_MAX_TIME: '2' } })
  assert.notEqual(r.status, 0)
  assert.ok(r.ms < 8000, `the probe took ${r.ms} ms`)
})

test('probes /_matrix/client/v3/login by default, never /versions', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(PROBE, 'utf8')
  assert.match(text, /\/_matrix\/client\/v3\/login/)
  assert.doesNotMatch(text.replace(/^#.*$/gm, ''), /\/_matrix\/client\/versions/)
})
