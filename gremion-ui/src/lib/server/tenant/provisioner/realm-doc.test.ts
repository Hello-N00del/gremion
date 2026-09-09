// P2.1c (T10) — pure realm-doc builder unit tests. No KC, no DB, no network.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import {
  buildTenantRealmDoc,
  issuerForTenant,
  kcInternalForTenant,
  assertServiceAccountsOnly,
  assertRoleVocabularyCarried,
  DEFAULT_KC_INTERNAL_BASE,
  PROVISIONER_SECRET_CLIENTS,
} from './realm-doc'

const KC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'docker', 'keycloak')
// The shipped base template carries the deployment apex host as the
// `__APEX_DOMAIN__` sentinel (resolved at Keycloak boot by
// docker/keycloak/substitute-realm-secrets.sh, and by loadBaseRealmDoc() in
// scripts/tenant-provision.ts). Resolve it to this suite's example apex so the
// fixtures exercise the same shape a real deployment gets.
const TEST_APEX = 'council.example'
const base = JSON.parse(
  readFileSync(join(KC, 'realm-export.base.json'), 'utf-8').split('__APEX_DOMAIN__').join(TEST_APEX),
)

// Governance-only kernel: there are no toggleable feature modules, so the module
// config is empty. (The former finance-ON/OFF distinction is moot — finance is
// carved out and contributes no realm fragment.)
const cfgOff = { modules: {} } as never

// Deterministic generated secret per client, so the test asserts exact placement.
const secretFor = (clientId: string) => `secret-${clientId}`

describe('issuer / kc-internal derivation (D-ISSUER-HOST)', () => {
  it('builds the per-tenant subdomain issuer', () => {
    expect(issuerForTenant('t2', 'verein', 'council.example')).toBe(
      'https://t2.council.example/auth/realms/verein',
    )
  })

  it('(A) #139/G-080: kcInternalForTenant returns an internal-TLS URL by default (https, not plaintext :8080)', () => {
    const url = kcInternalForTenant('verein')
    expect(url).toBe('https://keycloak:8443/auth/realms/verein')
    expect(url.startsWith('https://')).toBe(true)
    expect(url).not.toContain('http://keycloak:8080')
    expect(DEFAULT_KC_INTERNAL_BASE).toBe('https://keycloak:8443/auth')
  })

  it('(A) derives scheme/port from an AUTH_KEYCLOAK_INTERNAL base like the default tenant, stripping any realm suffix', () => {
    // a plain /auth base
    expect(kcInternalForTenant('verein', 'https://kc:8443/auth')).toBe('https://kc:8443/auth/realms/verein')
    // a realm-scoped AUTH_KEYCLOAK_INTERNAL (default tenant shape) -> stripped to the right per-tenant realm
    expect(kcInternalForTenant('verein', 'https://keycloak:8443/auth/realms/sturaos')).toBe(
      'https://keycloak:8443/auth/realms/verein',
    )
    // trailing slash tolerated
    expect(kcInternalForTenant('verein', 'https://keycloak:8443/auth/')).toBe(
      'https://keycloak:8443/auth/realms/verein',
    )
  })
})

describe('assertServiceAccountsOnly (#239)', () => {
  it('passes a service-accounts-only users array', () => {
    expect(() =>
      assertServiceAccountsOnly([{ username: 'service-account-gremion-admin', serviceAccountClientId: 'gremion-admin' }]),
    ).not.toThrow()
  })
  it('passes an empty/absent users array', () => {
    expect(() => assertServiceAccountsOnly(undefined)).not.toThrow()
    expect(() => assertServiceAccountsOnly([])).not.toThrow()
  })
  it('throws (loud, names the user) on a planted human user', () => {
    expect(() =>
      assertServiceAccountsOnly([
        { username: 'service-account-gremion-admin', serviceAccountClientId: 'gremion-admin' },
        { username: 'dev.admin', enabled: true },
      ]),
    ).toThrow(/dev\.admin/)
  })
})

describe('buildTenantRealmDoc (§4 realm contract)', () => {
  const build = (config: never) =>
    buildTenantRealmDoc({
      base,
      manifests: MODULE_MANIFESTS,
      config,
      slug: 't2',
      realmName: 'verein',
      tenantHost: 't2.council.example',
      apexDomain: 'council.example',
      clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, secretFor(c)])),
    })

  it('sets the per-tenant realm name and sslRequired:all literal (#139)', () => {
    const doc = build(cfgOff)
    expect(doc.realm).toBe('verein')
    expect(doc.sslRequired).toBe('all')
    // no placeholder left behind
    expect(JSON.stringify(doc)).not.toContain('__SSL_REQUIRED__')
  })

  it('strips hardcoded ids from authenticationFlows + authenticatorConfig so KC mints fresh per-realm ids (cross-realm collision)', () => {
    // The base template pins explicit ids for the #164 step-up flows + the
    // stepup-loa1/-loa2 authenticatorConfigs. Those ids are GLOBALLY unique in
    // KC and are preserved verbatim on the default realm's import, so a SECOND
    // realm built from the same template collides (ModelDuplicateException).
    // Executions reference configs/sub-flows by ALIAS, so the ids are droppable.
    const doc = build(cfgOff)
    const flows = (doc.authenticationFlows as any[]) ?? []
    const cfgs = (doc.authenticatorConfig as any[]) ?? []
    expect(flows.length).toBeGreaterThan(0)
    expect(cfgs.length).toBeGreaterThan(0)
    for (const f of flows) expect(f.id).toBeUndefined()
    for (const c of cfgs) expect(c.id).toBeUndefined()
    // the alias-referenced contract survives the strip
    const loa1 = cfgs.find((c) => c.alias === 'stepup-loa1')
    expect(loa1).toBeTruthy()
    expect(loa1.config['loa-condition-level']).toBe('1')
    // executions still reference the config by alias, not id
    expect(JSON.stringify(doc)).toContain('"authenticatorConfig":"stepup-loa1"')
  })

  it('injects each client generated secret (no __*__ placeholder remains)', () => {
    const doc = build(cfgOff)
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/__[A-Z_]+OIDC_CLIENT_SECRET__/)
    const ui = (doc.clients as any[]).find((c) => c.clientId === 'gremion-ui')
    expect(ui.secret).toBe(secretFor('gremion-ui'))
  })

  it('swaps the apex host for the tenant host in redirect URIs / web-origins (exact, never wildcard) (#240)', () => {
    const doc = build(cfgOff)
    const ui = (doc.clients as any[]).find((c) => c.clientId === 'gremion-ui')
    expect(ui.redirectUris).toContain('https://t2.council.example/auth/callback/keycloak')
    expect(ui.redirectUris).not.toContain('https://council.example/auth/callback/keycloak')
    expect(ui.webOrigins).toContain('https://t2.council.example')
    // never a path-wildcard
    expect(JSON.stringify(doc)).not.toContain('https://t2.council.example/*')
    // post-logout attribute is host-swapped too
    expect(ui.attributes['post.logout.redirect.uris']).toContain('https://t2.council.example/auth/login?loggedOut=1')
  })

  it('(C) #240: DROPS every localhost dev URI from a provisioned realm (redirect/web-origin/post-logout)', () => {
    const doc = build(cfgOff)
    const ui = (doc.clients as any[]).find((c) => c.clientId === 'gremion-ui')
    expect(ui.redirectUris).not.toContain('http://localhost:3000/auth/callback/keycloak')
    expect(ui.redirectUris.some((u: string) => u.includes('localhost'))).toBe(false)
    expect(ui.webOrigins.some((u: string) => u.includes('localhost'))).toBe(false)
    // the post-logout `##`-joined attribute is localhost-free too
    expect(ui.attributes['post.logout.redirect.uris']).not.toContain('localhost')
    // the provisioned gremion-ui client carries EXACTLY the tenant-host URIs
    expect(ui.redirectUris).toEqual(['https://t2.council.example/auth/callback/keycloak'])
    expect(ui.webOrigins).toEqual(['https://t2.council.example'])
    // whole-doc: no localhost anywhere
    expect(JSON.stringify(doc)).not.toContain('localhost')
  })

  it('(B) #240: NO provisioned client retains a foreign host (stura.example.org) on any client', () => {
    const doc = build(cfgOff)
    // base relic removed + provisioned-path filter both hold: zero stura.example.org refs
    expect(JSON.stringify(doc)).not.toContain('stura.example.org')
    for (const c of doc.clients as any[]) {
      for (const u of [...(c.redirectUris ?? []), ...(c.webOrigins ?? [])]) {
        expect(u).not.toContain('stura.example.org')
      }
    }
  })

  it('(B) strips a foreign host even if one were reintroduced into the base client URIs', () => {
    // Carve note: the nextcloud + gremion-mobile clients were removed from the base
    // realm template with the messages/files/mobile surfaces, so the foreign-host
    // strip is exercised on the surviving gremion-ui client instead.
    const planted = JSON.parse(JSON.stringify(base))
    const uiBase = (planted.clients as any[]).find((c) => c.clientId === 'gremion-ui')
    uiBase.redirectUris.push('https://stura.example.org/auth/callback/keycloak')
    uiBase.webOrigins.push('https://stura.example.org')
    const doc = buildTenantRealmDoc({
      base: planted,
      manifests: MODULE_MANIFESTS,
      config: cfgOff,
      slug: 't2',
      realmName: 'verein',
      tenantHost: 't2.council.example',
      apexDomain: 'council.example',
      clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, secretFor(c)])),
    })
    const ui = (doc.clients as any[]).find((c) => c.clientId === 'gremion-ui')
    expect(ui.redirectUris.some((u: string) => u.includes('stura.example.org'))).toBe(false)
    expect(ui.webOrigins.some((u: string) => u.includes('stura.example.org'))).toBe(false)
  })

  it('carries no ref-finanzen group / finance role (finance module carved out by construction)', () => {
    const doc = build(cfgOff)
    expect((doc.groups as any[]).map((g) => g.name)).not.toContain('ref-finanzen')
    expect((doc.roles as any).realm.map((r: any) => r.name)).not.toContain('finance')
  })

  it('keeps the §4 contract carried by the base (browser-stepup / acr.loa.map)', () => {
    const doc = build(cfgOff) as any
    expect(doc.browserFlow).toBe('browser-stepup')
    expect(doc.attributes['acr.loa.map']).toBe('{"loa1":1,"loa2":2}')
  })

  it('throws when the users array carries a non-service-account (#239)', () => {
    const planted = JSON.parse(JSON.stringify(base))
    planted.users.push({ username: 'dev.admin', enabled: true })
    expect(() =>
      buildTenantRealmDoc({
        base: planted,
        manifests: MODULE_MANIFESTS,
        config: cfgOff,
        slug: 't2',
        realmName: 'verein',
        tenantHost: 't2.council.example',
        apexDomain: 'council.example',
        clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, secretFor(c)])),
      }),
    ).toThrow(/dev\.admin/)
  })

  it('does not mutate the input base template', () => {
    const before = JSON.stringify(base)
    build(cfgOff)
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('(D) role-vocabulary guard (assertRoleVocabularyCarried)', () => {
  // Governance-only kernel: the realm carries the four governance roles
  // (guest/member/council-admin/it-admin). The carved-out finance role is gone,
  // so the guard fixtures use the kernel roles + a synthetic non-carried role to
  // exercise divergence.
  const carriedDoc = {
    realm: 'verein',
    roles: { realm: [{ name: 'guest' }, { name: 'member' }, { name: 'council-admin' }, { name: 'it-admin' }] },
  } as never

  it('passes when config.roles is ABSENT (default vocabulary, not checked)', () => {
    expect(() => assertRoleVocabularyCarried(undefined, carriedDoc)).not.toThrow()
  })

  it('passes when every override role is carried by the realm doc (subset)', () => {
    expect(() => assertRoleVocabularyCarried(['member', 'it-admin'], carriedDoc)).not.toThrow()
    expect(() => assertRoleVocabularyCarried(['guest', 'member', 'council-admin', 'it-admin'], carriedDoc)).not.toThrow()
  })

  it('REFUSES (loud, names the missing roles) when an override diverges from the carried realm roles', () => {
    expect(() => assertRoleVocabularyCarried(['member', 'gemeinderat', 'fraktion-chef'], carriedDoc)).toThrow(
      /gemeinderat.*fraktion-chef|fraktion-chef.*gemeinderat/,
    )
  })

  it('buildTenantRealmDoc refuses a divergent config.roles override end-to-end (no realm emitted)', () => {
    expect(() =>
      buildTenantRealmDoc({
        base,
        manifests: MODULE_MANIFESTS,
        // The realm carries only the governance roles; an override demanding a
        // role the realm does not carry (e.g. 'buergermeister') diverges.
        config: { modules: {}, roles: ['member', 'buergermeister'] } as never,
        slug: 't2',
        realmName: 'verein',
        tenantHost: 't2.council.example',
        apexDomain: 'council.example',
        clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, secretFor(c)])),
      }),
    ).toThrow(/config\.roles override.*buergermeister|missing.*buergermeister/)
  })

  it('buildTenantRealmDoc allows a subset override end-to-end (kernel roles carried)', () => {
    expect(() =>
      buildTenantRealmDoc({
        base,
        manifests: MODULE_MANIFESTS,
        config: { modules: {}, roles: ['member', 'it-admin'] } as never,
        slug: 't2',
        realmName: 'verein',
        tenantHost: 't2.council.example',
        apexDomain: 'council.example',
        clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, secretFor(c)])),
      }),
    ).not.toThrow()
  })
})
