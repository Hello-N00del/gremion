// TASK-043 TDD 16 (Q11) and the sender-less customer realm (G2, R-E5a):
//  - PROVISIONER_SECRET_CLIENTS is exactly the base template's secret placeholders;
//  - gremion-mobile is public, PKCE S256, secret-less, no direct grants,
//    fullScopeAllowed false, redirect <reversed platform domain>.app:/oauthredirect;
//  - synapse is a confidential code-flow client with no direct grants;
//  - a customer realm (smtp: null) carries NO smtpServer and no sentinel: the
//    host stamps the customer's own principal before any user exists.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIENCES } from '$lib/auth/audience'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { buildTenantRealmDoc, mobileRedirectUri, PROVISIONER_SECRET_CLIENTS } from './realm-doc'

const KC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'docker', 'keycloak')
const raw = readFileSync(join(KC, 'realm-export.base.json'), 'utf-8')
const APEX = 'council.example'
const base = JSON.parse(raw.split('__APEX_DOMAIN__').join(APEX))
type Client = Record<string, unknown> & { clientId: string }
const clients = base.clients as Client[]

function customerRealm() {
  return buildTenantRealmDoc({
    base,
    manifests: MODULE_MANIFESTS,
    config: { modules: {} },
    slug: 'musterstadt',
    realmName: 'musterstadt',
    tenantHost: 'rat.musterstadt.example',
    apexDomain: APEX,
    clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, `secret-${c}`])),
    smtp: null,
  })
}

describe('PROVISIONER_SECRET_CLIENTS (Q11)', () => {
  it('is exactly the set of base clients whose secret is a __*__ placeholder', () => {
    const placeholders = clients
      .filter((c) => typeof c.secret === 'string' && /^__[A-Z0-9_]+__$/.test(c.secret as string))
      .map((c) => c.clientId)
      .sort()
    expect([...PROVISIONER_SECRET_CLIENTS].sort()).toEqual(placeholders)
  })
})

// TASK-033-a / TRD-147: a token without `sub` has no session. The template imports no `basic` client scope
// (the 25+ source of sub), so every client whose tokens reach the Bearer branch carries its own access-token
// sub mapper; reconcile check bearer-clients-sub holds live realms to the same.
describe('every Bearer client of the base template issues sub in its access token', () => {
  it.each([...DEFAULT_AUDIENCES])('%s carries an access-token sub mapper', (clientId) => {
    const c = clients.find((x) => x.clientId === clientId)
    expect(c, `${clientId} is a JWT audience but absent from the base realm`).toBeDefined()
    const mappers = (c!.protocolMappers ?? []) as Array<{ protocolMapper?: string; config?: Record<string, string> }>
    expect(
      mappers.some((m) => (m.protocolMapper === 'oidc-sub-mapper' || m.config?.['claim.name'] === 'sub') && m.config?.['access.token.claim'] === 'true'),
    ).toBe(true)
  })
})

describe('the gremion-mobile and synapse clients (Q11)', () => {
  it('gremion-mobile: public, S256, no secret, no direct grants, no implicit, fullScopeAllowed false', () => {
    const m = clients.find((c) => c.clientId === 'gremion-mobile')!
    expect(m).toBeDefined()
    expect(m.publicClient).toBe(true)
    expect(m.secret).toBeUndefined()
    expect(m.directAccessGrantsEnabled).toBe(false)
    expect(m.implicitFlowEnabled).toBe(false)
    expect(m.serviceAccountsEnabled).toBe(false)
    expect(m.fullScopeAllowed).toBe(false)
    expect((m.attributes as Record<string, string>)['pkce.code.challenge.method']).toBe('S256')
  })

  it('the provisioned realm gives gremion-mobile exactly the reversed-domain private-use redirect', () => {
    const doc = customerRealm()
    const m = (doc.clients as Client[]).find((c) => c.clientId === 'gremion-mobile')!
    expect(m.redirectUris).toEqual(['example.council.app:/oauthredirect'])
    expect(mobileRedirectUri('platform.example.org')).toBe('org.example.platform.app:/oauthredirect')
    expect(() => mobileRedirectUri('localhost')).toThrow(/not a DNS name/)
  })

  it('synapse: confidential, code flow, no direct grants, its secret generated', () => {
    const s = clients.find((c) => c.clientId === 'synapse')!
    expect(s).toMatchObject({ publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false, fullScopeAllowed: false })
    const doc = customerRealm()
    expect((doc.clients as Client[]).find((c) => c.clientId === 'synapse')!.secret).toBe('secret-synapse')
  })
})

describe('a customer realm is created without a sender (smtp: null)', () => {
  it('carries no smtpServer, no __SMTP_*__ sentinel and no platform@ sender', () => {
    const doc = customerRealm()
    expect(doc.smtpServer).toBeUndefined()
    const text = JSON.stringify(doc)
    expect(text).not.toMatch(/__[A-Z][A-Z0-9_]*__/)
    expect(text).not.toMatch(/platform@/)
  })
})
