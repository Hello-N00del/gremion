// TASK-039 TDD 12 (static half): TRD-111, Q4/Q5. Grafana is reachable only
// through the operator's administrative identity with MFA, never through a
// council realm: the rendered Grafana environment and the grafana client of
// docker/keycloak/realm-export.ops.json, each with its RED copies (form on,
// basic on, anonymous on, a second issuer, strict off, the acr clause
// dropped). The refusals at runtime (council token, role-less user, operator
// at loa1) are observability-proof.sh's.
//
//   node --test compose/observability/access.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROJECTS, renderProject } from '../../scripts/check-pooled-stack.mjs'
import { grafanaAccessViolations, grafanaClientViolations, readText } from './checks.mjs'

const REAL = renderProject(PROJECTS.find((p) => p.id === 'ops'))
const ENV = REAL.services.grafana.environment
const REALM = JSON.parse(readText('docker/keycloak/realm-export.ops.json'))
const env = (patch) => ({ ...ENV, ...patch })
const realm = (mutate) => {
  const r = JSON.parse(JSON.stringify(REALM))
  mutate(r, r.clients.find((c) => c.clientId === 'grafana'))
  return r
}

test('the rendered Grafana signs in only through the platform realm, gated on operator AND acr loa2, strictly', () => {
  assert.deepEqual(grafanaAccessViolations(ENV), [])
  assert.match(ENV.GF_AUTH_GENERIC_OAUTH_AUTH_URL, /^https:\/\/guardstack\.invalid\/auth\/realms\/platform\//)
})

test('RED: login form, basic auth, anonymous access, a local admin and local sign-up each fail', () => {
  assert.match(grafanaAccessViolations(env({ GF_AUTH_DISABLE_LOGIN_FORM: 'false' })).join('\n'), /the login form is not disabled/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_BASIC_ENABLED: 'true' })).join('\n'), /basic auth is not off/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_ANONYMOUS_ENABLED: 'true' })).join('\n'), /anonymous access is not off/)
  assert.match(grafanaAccessViolations(env({ GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION: 'false' })).join('\n'), /a local admin is created/)
  assert.match(grafanaAccessViolations(env({ GF_USERS_ALLOW_SIGN_UP: 'true' })).join('\n'), /local sign-up is allowed/)
})

test('RED: a second provider, a second issuer, the master realm and a council realm each fail', () => {
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GITHUB_ENABLED: 'true' })).join('\n'), /a second provider is on \(GF_AUTH_GITHUB_ENABLED=true\)/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_JWT_ENABLED: 'true' })).join('\n'), /a second provider is on/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_OKTA_AUTH_URL: 'https://x/auth' })).join('\n'), /a second issuer URL/)
  assert.match(
    grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_AUTH_URL: 'https://guardstack.invalid/auth/realms/master/protocol/openid-connect/auth' })).join('\n'),
    /GF_AUTH_GENERIC_OAUTH_AUTH_URL=.* is not the platform realm/,
  )
  assert.match(
    grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_TOKEN_URL: 'https://guardstack.invalid/auth/realms/council-a/protocol/openid-connect/token' })).join('\n'),
    /GF_AUTH_GENERIC_OAUTH_TOKEN_URL=.* is not the platform realm/,
  )
  assert.match(
    grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_API_URL: 'http://keycloak:8080/auth/realms/platform/protocol/openid-connect/userinfo' })).join('\n'),
    /is not the platform realm by its public https URL/,
  )
})

test('RED: strict off, the acr clause dropped, the role clause dropped, a default role and an inline secret each fail', () => {
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT: 'false' })).join('\n'), /role_attribute_strict is off/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH: "contains(realm_access.roles[*], 'operator') && 'Admin' || ''" })).join('\n'), /does not require acr == 'loa2'/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH: "acr == 'loa2' && 'Admin' || ''" })).join('\n'), /does not require the realm role operator/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH: "contains(realm_access.roles[*], 'operator') && acr == 'loa2' && 'Admin' || 'Viewer'" })).join('\n'), /does not map a refusal to ''/)
  assert.match(grafanaAccessViolations(env({ GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: 'inline' })).join('\n'), /the client secret is an environment value/)
  assert.match(grafanaAccessViolations(env({ GF_SMTP_PASSWORD: 'inline' })).join('\n'), /the SMTP password is an environment value/)
})

test('the grafana client of the platform realm: confidential, PKCE, loopback callback, ACR loa2 default and minimum, both claims in the ID token, scope = operator', () => {
  assert.deepEqual(grafanaClientViolations(REALM), [])
})

test('RED: a public client, direct grants, a wildcard callback, no minimum ACR, no acr or role claim in the ID token, full scope, a committed secret each fail', () => {
  const fails = (mutate, re) => assert.match(grafanaClientViolations(realm(mutate)).join('\n'), re)
  fails((_, c) => { c.publicClient = true }, /not a confidential client/)
  fails((_, c) => { c.directAccessGrantsEnabled = true }, /directAccessGrantsEnabled is not false/)
  fails((_, c) => { c.redirectUris = ['http://127.0.0.1:3000/*'] }, /is not exactly the loopback callback/)
  fails((_, c) => { delete c.attributes['minimum.acr.value'] }, /minimum ACR is not loa2/)
  fails((_, c) => { c.attributes['default.acr.values'] = 'loa1' }, /default ACR is not loa2/)
  fails((_, c) => { c.protocolMappers.find((m) => m.protocolMapper === 'oidc-acr-mapper').config['id.token.claim'] = 'false' }, /no acr mapper into the ID token/)
  fails((_, c) => { c.protocolMappers = c.protocolMappers.filter((m) => m.protocolMapper !== 'oidc-usermodel-realm-role-mapper') }, /no multivalued realm-role mapper into the ID token/)
  fails((_, c) => { c.fullScopeAllowed = true }, /fullScopeAllowed is not false/)
  fails((_, c) => { c.secret = 'committed' }, /the template carries a client secret/)
  fails((r) => { r.scopeMappings.find((s) => s.client === 'grafana').roles.push('admin') }, /its scope is not exactly the realm role operator/)
  fails((r) => { r.realm = 'master' }, /belongs to the platform realm only/)
  fails((_, c) => { c.description = 'x'.repeat(256) }, /grafana: description is 256 characters, Keycloak's column holds 255/)
  assert.match(grafanaClientViolations({ realm: 'platform', clients: [] }).join('\n'), /carries no grafana client/)
})

test('Grafana shares no network with Keycloak and is the only ops service with a host port on OPS_BIND_IP', () => {
  const nets = Object.keys(REAL.services.grafana.networks ?? {}).map((k) => REAL.networks?.[k]?.name ?? k)
  assert.deepEqual(nets, ['guardstack-ops_ops'])
  const onUi = Object.entries(REAL.services).filter(([, s]) => (s.ports ?? []).some((p) => p.host_ip === '127.0.0.1')).map(([n]) => n)
  assert.deepEqual(onUi, ['grafana'])
})
