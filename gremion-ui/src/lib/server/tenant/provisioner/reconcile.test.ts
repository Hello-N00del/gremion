// P2.1c (T11) — realm-reconcile (the R5 drift guard) unit tests. Mocked
// transport, no network, no DB. A green realm passes every named check; each
// single planted drift fails EXACTLY that named check; apply issues exactly the
// repairing calls (§4-2 idempotent sequence) and nothing else.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KcTransport } from './kc-admin-api'
import {
  reconcileRealm,
  reconcileFleet,
  isRealmBearing,
  REALM_BEARING_STATUSES,
  RECONCILE_CHECK_NAMES,
  type ReconcileReport,
  type FleetTenant,
} from './reconcile'
import type { TenantStatus } from '../registry'

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

const REALM = 'verein'
const APEX = 'council.example'
const HOST = 't2.council.example' // tenant subdomain host (D-ISSUER-HOST)

/** The exact per-tenant gremion-ui URI set (apex host swapped for the tenant host,
 *  shapes preserved — never a wildcard), with localhost/foreign-host entries
 *  DROPPED (#240 B/C — a provisioned realm carries ONLY tenant-host URIs).
 *  Mirrors §4-4 + the hardened expectedUiUris. */
const EXPECTED_REDIRECT = [`https://${HOST}/auth/callback/keycloak`]
const EXPECTED_WEB_ORIGINS = [`https://${HOST}`]

/** A GREEN live realm: every §4 contract element present + correct. Built as a
 *  route map keyed by `${method} ${path}` for a scriptable transport. */
function greenRoutes(): Record<string, unknown> {
  return {
    // top-level realm rep
    [`GET /admin/realms/${REALM}`]: {
      realm: REALM,
      sslRequired: 'all',
      browserFlow: 'browser-stepup',
      otpPolicyType: 'totp',
      otpPolicyAlgorithm: 'HmacSHA1',
      otpPolicyDigits: 6,
      otpPolicyPeriod: 30,
      attributes: { 'acr.loa.map': '{"loa1":1,"loa2":2}' },
    },
    // flows + subflows
    [`GET /admin/realms/${REALM}/authentication/flows`]: [{ alias: 'browser-stepup' }, { alias: 'browser' }],
    [`GET /admin/realms/${REALM}/authentication/flows/stepup-1fa/executions`]: [
      { id: 'c1', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-1' },
      { id: 'p1', providerId: 'auth-username-password-form' },
    ],
    [`GET /admin/realms/${REALM}/authentication/flows/stepup-2fa/executions`]: [
      { id: 'c2', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-2' },
      { id: 'o2', providerId: 'auth-otp-form' },
    ],
    'GET /admin/realms/verein/authentication/config/cfg-1': {
      alias: 'stepup-loa1',
      config: { 'loa-condition-level': '1', 'loa-max-age': '36000' },
    },
    'GET /admin/realms/verein/authentication/config/cfg-2': {
      alias: 'stepup-loa2',
      config: { 'loa-condition-level': '2', 'loa-max-age': '300' },
    },
    // gremion-ui client + its mappers
    [`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`]: [
      {
        id: 'uuid-ui',
        clientId: 'gremion-ui',
        fullScopeAllowed: false,
        redirectUris: [...EXPECTED_REDIRECT],
        webOrigins: [...EXPECTED_WEB_ORIGINS],
      },
    ],
    'GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models': [
      { name: 'acr', protocolMapper: 'oidc-acr-mapper' },
      { name: 'sub', protocolMapper: 'oidc-usermodel-property-mapper', config: { 'claim.name': 'sub' } },
    ],
    // (D) #254: the gremion-ui realm-role scope-mappings (fullScopeAllowed:false needs
    // these or realm_access.roles silently empties). The base floor set.
    'GET /admin/realms/verein/clients/uuid-ui/scope-mappings/realm': [
      { name: 'guest' },
      { name: 'member' },
      { name: 'council-admin' },
      { name: 'it-admin' },
    ],
    // realm users — service accounts only (#239)
    [`GET /admin/realms/${REALM}/users?max=2000`]: [
      { username: 'service-account-gremion-admin', serviceAccountClientId: 'gremion-admin' },
    ],
    // (A) the gremion-admin SA's realm-management role mapping (the §4 contract: the
    // SA holds realm-admin or every Admin REST op 403s). The reader walks
    // gremion-admin client UUID -> SA-user -> realm-management UUID -> mapped roles.
    [`GET /admin/realms/${REALM}/clients?clientId=gremion-admin`]: [{ id: 'uuid-admin' }],
    'GET /admin/realms/verein/clients/uuid-admin/service-account-user': { id: 'sa-user-1' },
    [`GET /admin/realms/${REALM}/clients?clientId=realm-management`]: [{ id: 'uuid-rm' }],
    'GET /admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm': [{ name: 'realm-admin' }],
  }
}

function scriptedTransport(routes: Record<string, unknown>): {
  transport: KcTransport
  calls: Array<{ method: string; path: string; body?: unknown }>
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const transport: KcTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    const key = `${method} ${path}`
    if (key in routes) return routes[key]
    return undefined
  }
  return { transport, calls }
}

const opts = { realm: REALM, tenantHost: HOST, apexDomain: APEX, base }

describe('reconcileRealm — verify-only on a GREEN realm', () => {
  it('passes every named §4 contract check', async () => {
    const { transport } = scriptedTransport(greenRoutes())
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.ok).toBe(true)
    // machine-readable: one entry per documented check name, all ok
    const names = report.checks.map((c) => c.name).sort()
    expect(names).toEqual([...RECONCILE_CHECK_NAMES].sort())
    for (const c of report.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
  })

  it('verify-only issues NO mutating calls (read-only)', async () => {
    const { transport, calls } = scriptedTransport(greenRoutes())
    await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
})

describe('reconcileRealm — each single drift fails EXACTLY that named check', () => {
  async function failedNames(mutate: (r: Record<string, unknown>) => void): Promise<string[]> {
    const routes = greenRoutes()
    mutate(routes)
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    return report.checks.filter((c) => !c.ok).map((c) => c.name)
  }

  it('flipped sslRequired -> only ssl-required fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}`] as any).sslRequired = 'external'
    })
    expect(failed).toEqual(['ssl-required'])
  })

  it('wrong browserFlow -> only browser-flow fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}`] as any).browserFlow = 'browser'
    })
    expect(failed).toEqual(['browser-flow'])
  })

  it('missing acr.loa.map -> only acr-loa-map fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}`] as any).attributes = {}
    })
    expect(failed).toEqual(['acr-loa-map'])
  })

  it('wrong otpPolicy digits -> only otp-policy fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}`] as any).otpPolicyDigits = 8
    })
    expect(failed).toEqual(['otp-policy'])
  })

  it('missing browser-stepup flow -> stepup-flow + its dependent LoA-config fail (the §4-2 sequence repairs both together)', async () => {
    const failed = await failedNames((r) => {
      r[`GET /admin/realms/${REALM}/authentication/flows`] = [{ alias: 'browser' }]
    })
    // A missing flow is a COMPOUND drift: the LoA configs live inside the flow,
    // so they cannot be verified when the flow is gone. Both are repaired by the
    // single §4-2 step-up rebuild — no OTHER (client/user/realm-attr) check fails.
    expect(failed).toEqual(['stepup-flow', 'stepup-loa-config'])
  })

  it('wrong LoA maxAge on loa2 -> only stepup-loa-config fails', async () => {
    const failed = await failedNames((r) => {
      ;(r['GET /admin/realms/verein/authentication/config/cfg-2'] as any).config['loa-max-age'] = '99999'
    })
    expect(failed).toEqual(['stepup-loa-config'])
  })

  it('missing acr mapper -> only gremion-ui-acr-mapper fails', async () => {
    const failed = await failedNames((r) => {
      r['GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models'] = [
        { name: 'sub', protocolMapper: 'oidc-usermodel-property-mapper', config: { 'claim.name': 'sub' } },
      ]
    })
    expect(failed).toEqual(['gremion-ui-acr-mapper'])
  })

  it('missing uid sub-mapper -> only gremion-ui-sub-mapper fails', async () => {
    const failed = await failedNames((r) => {
      r['GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models'] = [
        { name: 'acr', protocolMapper: 'oidc-acr-mapper' },
      ]
    })
    expect(failed).toEqual(['gremion-ui-sub-mapper'])
  })

  it('wildcard redirect URI -> only gremion-ui-redirect-uris fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [`https://${HOST}/*`]
    })
    expect(failed).toEqual(['gremion-ui-redirect-uris'])
  })

  it('extra web-origin -> only gremion-ui-web-origins fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].webOrigins = [
        ...EXPECTED_WEB_ORIGINS,
        'https://evil.example.com',
      ]
    })
    expect(failed).toEqual(['gremion-ui-web-origins'])
  })

  it('localhost redirect URI lingering on a tenant realm -> only gremion-ui-redirect-uris fails (#240 C: no localhost on provisioned realms)', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [
        ...EXPECTED_REDIRECT,
        'http://localhost:3000/auth/callback/keycloak',
      ]
    })
    expect(failed).toEqual(['gremion-ui-redirect-uris'])
  })

  it('foreign-host (stura.example.org) web-origin lingering on a tenant realm -> only gremion-ui-web-origins fails (#240 B)', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].webOrigins = [
        ...EXPECTED_WEB_ORIGINS,
        'https://stura.example.org',
      ]
    })
    expect(failed).toEqual(['gremion-ui-web-origins'])
  })

  it('fullScopeAllowed flipped true -> only full-scope-allowed fails', async () => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].fullScopeAllowed = true
    })
    expect(failed).toEqual(['full-scope-allowed'])
  })

  it('(D) #254: fullScopeAllowed:false but MISSING scope-mappings -> full-scope-allowed fails (the exact #254 silent break)', async () => {
    const failed = await failedNames((r) => {
      // fullScopeAllowed stays false (the prior #254 guard passes) but the realm-role
      // scope-mappings are gone -> realm_access.roles silently empties. The extended
      // check must catch this.
      r['GET /admin/realms/verein/clients/uuid-ui/scope-mappings/realm'] = []
    })
    expect(failed).toEqual(['full-scope-allowed'])
  })

  it('(D) #254: a partial scope-mapping (missing one base role) -> full-scope-allowed fails naming it', async () => {
    const routes = greenRoutes()
    routes['GET /admin/realms/verein/clients/uuid-ui/scope-mappings/realm'] = [
      { name: 'guest' },
      { name: 'member' },
      { name: 'council-admin' },
      // it-admin dropped
    ]
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const fsa = report.checks.find((c) => c.name === 'full-scope-allowed')!
    expect(fsa.ok).toBe(false)
    expect(fsa.detail).toMatch(/it-admin/)
  })

  it('planted dev.admin user -> only no-fixture-users fails (names the user)', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/users?max=2000`] as any).push({ username: 'dev.admin', enabled: true })
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['no-fixture-users'])
    expect(failed[0].detail).toMatch(/dev\.admin/)
  })

  it('(A) gremion-admin SA missing the realm-management role -> only gremion-admin-sa-roles fails (names realm-admin)', async () => {
    const routes = greenRoutes()
    // The SA exists but carries NO realm-management roles (the exact KC-26
    // import-drops-SA-mappings drift): every Admin REST op would 403.
    routes['GET /admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm'] = []
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['gremion-admin-sa-roles'])
    expect(failed[0].detail).toMatch(/realm-admin/)
  })

  it('missing gremion-ui client -> client check fails (named)', async () => {
    const routes = greenRoutes()
    routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] = []
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.name)
    expect(failed).toContain('gremion-ui-client')
  })
})

describe('(B) reconcileRealm — the DEFAULT realm legitimately keeps localhost dev URIs', () => {
  const DEFAULT_REALM = 'sturaos'
  const DEFAULT_HOST = APEX // the default tenant host IS the apex (D-ISSUER-HOST)
  // The base gremion-ui URIs verbatim (localhost dev URIs + apex) — what the default
  // realm legitimately carries (realm-export.json) and reconcile must NOT reject.
  const baseUi = (base.clients as any[]).find((c: any) => c.clientId === 'gremion-ui')
  const BASE_REDIRECT = [...baseUi.redirectUris]
  const BASE_WEB_ORIGINS = [...baseUi.webOrigins]

  function defaultGreenRoutes(): Record<string, unknown> {
    const r = greenRoutes()
    // rekey the realm-scoped routes to the default realm name
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      out[k.split(`/admin/realms/${REALM}`).join(`/admin/realms/${DEFAULT_REALM}`)] = v
    }
    // the gremion-ui client on the DEFAULT realm carries the base localhost+apex URIs
    ;(out[`GET /admin/realms/${DEFAULT_REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [...BASE_REDIRECT]
    ;(out[`GET /admin/realms/${DEFAULT_REALM}/clients?clientId=gremion-ui`] as any)[0].webOrigins = [...BASE_WEB_ORIGINS]
    return out
  }

  const defaultOpts = { realm: DEFAULT_REALM, tenantHost: DEFAULT_HOST, apexDomain: APEX, base, isDefault: true }

  it('PASSES the URI checks when the default realm carries the base localhost+apex URIs', async () => {
    const { transport } = scriptedTransport(defaultGreenRoutes())
    const report = await reconcileRealm(transport, { ...defaultOpts, verifyOnly: true })
    const uriChecks = report.checks.filter(
      (c) => c.name === 'gremion-ui-redirect-uris' || c.name === 'gremion-ui-web-origins',
    )
    for (const c of uriChecks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('a PROVISIONED tenant carrying localhost is STILL rejected (drop applies only to provisioned realms)', async () => {
    // Same localhost-bearing client, but reconciled as a provisioned tenant
    // (isDefault omitted/false, tenant host) -> the localhost entries are illegal.
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [...BASE_REDIRECT]
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const redir = report.checks.find((c) => c.name === 'gremion-ui-redirect-uris')!
    expect(redir.ok).toBe(false)
  })
})

describe('(FIX3-B) reconcileRealm — realm segment is encodeURIComponent-encoded in every realm-scoped path', () => {
  // Defence-in-depth: the CLI already validateSlug's the realm, but reconcile's
  // own get()/PUT helpers must encode the realm as a single path segment so a
  // future caller forgetting the guard cannot break out of the segment (no `../`,
  // no query injection, no spaces) — matching KcProvisionApi.realmGet/realmReq.
  const EVIL_REALM = '../master?evil=1'
  const ENCODED = encodeURIComponent(EVIL_REALM) // '..%2Fmaster%3Fevil%3D1'
  const evilOpts = { realm: EVIL_REALM, tenantHost: HOST, apexDomain: APEX, base }

  it('every GET path encodes the realm segment (no raw `../`/`?`/space leaks through)', async () => {
    // Serve the realm rep + flows under the ENCODED key so verify doesn't NPE on a
    // missing realm rep; the rest of the contract checks fail (irrelevant here —
    // we only assert the PATHS are encoded).
    const routes: Record<string, unknown> = {
      [`GET /admin/realms/${ENCODED}`]: { sslRequired: 'all', attributes: {} },
      [`GET /admin/realms/${ENCODED}/authentication/flows`]: [],
      // the SA-roles reader (getServiceAccountRealmRoleNames) walks clients?clientId=…;
      // serve [] so it short-circuits instead of NPE-ing on an undefined route result.
      [`GET /admin/realms/${ENCODED}/clients?clientId=gremion-admin`]: [],
    }
    const { transport, calls } = scriptedTransport(routes)
    await reconcileRealm(transport, { ...evilOpts, verifyOnly: true })
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      // the encoded realm segment appears…
      expect(c.path.startsWith(`/admin/realms/${ENCODED}`)).toBe(true)
      // …and the raw, unencoded realm name never does.
      expect(c.path.includes(EVIL_REALM)).toBe(false)
    }
  })

  it('the sslRequired apply PUT targets the ENCODED realm path', async () => {
    // ONLY sslRequired is drifted; every OTHER contract element is served green
    // under the ENCODED key so apply replays exactly the ssl partial PUT (and the
    // SA-roles walk succeeds rather than throwing mid-apply). All paths use the
    // encoded realm segment — mirrors the live transport.
    const R = `/admin/realms/${ENCODED}`
    const routes: Record<string, unknown> = {
      [`GET ${R}`]: {
        realm: EVIL_REALM,
        sslRequired: 'external', // the single drift
        browserFlow: 'browser-stepup',
        otpPolicyType: 'totp',
        otpPolicyAlgorithm: 'HmacSHA1',
        otpPolicyDigits: 6,
        otpPolicyPeriod: 30,
        attributes: { 'acr.loa.map': '{"loa1":1,"loa2":2}' },
      },
      [`GET ${R}/authentication/flows`]: [{ alias: 'browser-stepup' }],
      [`GET ${R}/authentication/flows/stepup-1fa/executions`]: [
        { id: 'c1', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-1' },
        { id: 'p1', providerId: 'auth-username-password-form' },
      ],
      [`GET ${R}/authentication/flows/stepup-2fa/executions`]: [
        { id: 'c2', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-2' },
        { id: 'o2', providerId: 'auth-otp-form' },
      ],
      [`GET ${R}/authentication/config/cfg-1`]: { config: { 'loa-condition-level': '1', 'loa-max-age': '36000' } },
      [`GET ${R}/authentication/config/cfg-2`]: { config: { 'loa-condition-level': '2', 'loa-max-age': '300' } },
      [`GET ${R}/clients?clientId=gremion-ui`]: [
        {
          id: 'uuid-ui',
          clientId: 'gremion-ui',
          fullScopeAllowed: false,
          redirectUris: [`https://${HOST}/auth/callback/keycloak`],
          webOrigins: [`https://${HOST}`],
        },
      ],
      [`GET ${R}/clients/uuid-ui/protocol-mappers/models`]: [
        { name: 'acr', protocolMapper: 'oidc-acr-mapper' },
        { name: 'sub', protocolMapper: 'oidc-usermodel-property-mapper', config: { 'claim.name': 'sub' } },
      ],
      [`GET ${R}/clients/uuid-ui/scope-mappings/realm`]: [
        { name: 'guest' },
        { name: 'member' },
        { name: 'council-admin' },
        { name: 'it-admin' },
      ],
      [`GET ${R}/users?max=2000`]: [
        { username: 'service-account-gremion-admin', serviceAccountClientId: 'gremion-admin' },
      ],
      [`GET ${R}/clients?clientId=gremion-admin`]: [{ id: 'uuid-admin' }],
      [`GET ${R}/clients/uuid-admin/service-account-user`]: { id: 'sa-user-1' },
      [`GET ${R}/clients?clientId=realm-management`]: [{ id: 'uuid-rm' }],
      [`GET ${R}/users/sa-user-1/role-mappings/clients/uuid-rm`]: [{ name: 'realm-admin' }],
    }
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...evilOpts, verifyOnly: false })
    const sslPut = calls.find((c) => c.method === 'PUT' && c.path === `${R}`)
    expect(sslPut).toBeDefined()
    expect((sslPut!.body as any).sslRequired).toBe('all')
    expect(report.applied).toContain('ssl-required')
    // no PUT ever carries the raw unencoded realm in its path
    expect(calls.some((c) => c.method === 'PUT' && c.path.includes(EVIL_REALM))).toBe(false)
  })
})

describe('reconcileRealm — --verify-only exits 1 contract (ok=false on any drift)', () => {
  it('ok=false when any single check fails', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}`] as any).sslRequired = 'external'
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.ok).toBe(false)
  })
})

describe('reconcileRealm — apply replays ONLY the failed checks (§4-2), nothing else', () => {
  it('green realm in apply mode issues NO mutating calls', async () => {
    const { transport, calls } = scriptedTransport(greenRoutes())
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    expect(report.ok).toBe(true)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('drifted sslRequired only -> apply issues exactly the sslRequired partial PUT (merging attributes), NOT the step-up sequence', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}`] as any).sslRequired = 'external'
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    // The ssl partial PUT to the realm root, merging existing attributes.
    const sslPut = calls.find((c) => c.method === 'PUT' && c.path === `/admin/realms/${REALM}`)
    expect(sslPut).toBeDefined()
    expect((sslPut!.body as any).sslRequired).toBe('all')
    expect((sslPut!.body as any).attributes['acr.loa.map']).toBe('{"loa1":1,"loa2":2}')
    // The step-up flow build is NOT replayed (no flow copy, no acr-mapper POST).
    expect(calls.some((c) => c.path.includes('/flows/browser/copy'))).toBe(false)
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/protocol-mappers/models'))).toBe(false)
    // after apply the report records the repair attempt for ssl-required
    expect(report.applied).toContain('ssl-required')
  })

  it('drifted browserFlow only -> apply replays the §4-2 step-up sequence (flow-exists guard; PUT after flow exists)', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}`] as any).browserFlow = 'browser'
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    // browser-stepup already exists -> the build is skipped (flow-exists guard)…
    expect(calls.some((c) => c.path.includes('/flows/browser/copy'))).toBe(false)
    // …but the realm PUT setting browserFlow=browser-stepup runs.
    const realmPut = calls.find((c) => c.method === 'PUT' && c.path === `/admin/realms/${REALM}`)
    expect(realmPut).toBeDefined()
    expect((realmPut!.body as any).browserFlow).toBe('browser-stepup')
    expect(report.applied).toContain('browser-flow')
  })

  it('(C) drifted Condition-LoA maxAge on an EXISTING flow -> apply ACTUALLY repairs the config (PUT) and records it applied', async () => {
    const routes = greenRoutes()
    // loa2 maxAge drifted; the browser-stepup flow itself is intact (exists).
    ;(routes['GET /admin/realms/verein/authentication/config/cfg-2'] as any).config['loa-max-age'] = '99999'
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    // The flow exists -> the (non-idempotent) build is SKIPPED…
    expect(calls.some((c) => c.path.includes('/flows/browser/copy'))).toBe(false)
    // …but the LoA config IS repaired in place: a PUT to the existing config id,
    // writing the contract level/maxAge (loa2 -> 300). This is the (C) fix — before
    // it, configureStepupFlow wrote the LoA config only on a fresh-flow create, so a
    // drifted maxAge was reported 'applied' but never actually fixed.
    const cfgPut = calls.find(
      (c) => c.method === 'PUT' && c.path === '/admin/realms/verein/authentication/config/cfg-2',
    )
    expect(cfgPut).toBeDefined()
    expect((cfgPut!.body as any).config['loa-condition-level']).toBe('2')
    expect((cfgPut!.body as any).config['loa-max-age']).toBe('300')
    expect(report.applied).toContain('stepup-loa-config')
  })

  it('(A) drifted gremion-admin SA role mapping -> apply re-runs the idempotent grant (POST role-mappings) and records it applied', async () => {
    const routes = greenRoutes()
    // The SA carries no realm-management roles -> gremion-admin-sa-roles fails. Apply
    // must re-run the idempotent grant: resolve the realm-admin role rep and POST it
    // to the SA user's realm-management role-mappings.
    routes['GET /admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm'] = []
    routes['GET /admin/realms/verein/clients/uuid-rm/roles/realm-admin'] = { id: 'role-1', name: 'realm-admin' }
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const grantPost = calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm',
    )
    expect(grantPost).toBeDefined()
    expect(grantPost!.body).toEqual([{ id: 'role-1', name: 'realm-admin' }])
    expect(report.applied).toContain('gremion-admin-sa-roles')
  })

  it('a non-mechanically-repairable drift (wildcard URI) is reported but NOT auto-repaired', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [`https://${HOST}/*`]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    expect(report.ok).toBe(false)
    // no realm/flow/client mutation issued for a URI drift
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(report.applied).not.toContain('gremion-ui-redirect-uris')
  })
})

// ── (C) reconcile --all fleet driver ────────────────────────────────────────
describe('(C) isRealmBearing / REALM_BEARING_STATUSES', () => {
  it('only active + suspended carry a reconcilable realm; the tombstone/in-flight states do not', () => {
    expect([...REALM_BEARING_STATUSES].sort()).toEqual(['active', 'suspended'])
    expect(isRealmBearing('active')).toBe(true)
    expect(isRealmBearing('suspended')).toBe(true)
    // deleted/deleting have no realm (dropped); provisioning has no realm YET.
    expect(isRealmBearing('deleted')).toBe(false)
    expect(isRealmBearing('deleting')).toBe(false)
    expect(isRealmBearing('provisioning')).toBe(false)
  })
})

describe('(C) reconcileFleet — --all skips non-realm-bearing tenants and never aborts on one row', () => {
  const okReport = (realm: string): ReconcileReport => ({ realm, ok: true, checks: [], applied: [] })
  const failReport = (realm: string): ReconcileReport => ({
    realm,
    ok: false,
    checks: [{ name: 'ssl-required', ok: false, detail: 'drifted' }],
    applied: [],
  })
  const t = (slug: string, status: TenantStatus): FleetTenant => ({ slug, status, realmName: slug })

  it('drives runOne over a fleet containing one DELETED row -> the live (active) tenants ARE reconciled, the tombstone is skipped', async () => {
    // The exact regression: before the fix, --all called reconcileOne on the first
    // tenant in list order; a leading `deleted` tombstone made the first
    // get<RealmRep>('') 404 and aborted the WHOLE pass, so the live tenants behind
    // it were never reconciled. The fleet driver must skip the tombstone and STILL
    // reconcile every realm-bearing tenant.
    const fleet = [t('gone', 'deleted'), t('verein', 'active'), t('rat', 'suspended')]
    const reconciled: string[] = []
    const report = await reconcileFleet(fleet, async (tenant) => {
      reconciled.push(tenant.slug)
      return okReport(tenant.realmName)
    })
    // runOne ran for the two live tenants, NOT the tombstone.
    expect(reconciled).toEqual(['verein', 'rat'])
    // the tombstone is recorded as a deliberate skip (never a failure).
    const gone = report.rows.find((r) => r.slug === 'gone')!
    expect(gone.outcome).toBe('skipped')
    expect(gone.skippedStatus).toBe('deleted')
    // the live tenants are reconciled rows.
    expect(report.rows.filter((r) => r.outcome === 'reconciled').map((r) => r.slug)).toEqual(['verein', 'rat'])
    // a fleet whose only non-green row is a skip stays clean -> exit 0.
    expect(report.anyFailed).toBe(false)
  })

  it('skips provisioning + deleting in-flight states too (no realm yet / being dropped)', async () => {
    const fleet = [t('half', 'provisioning'), t('verein', 'active'), t('dying', 'deleting')]
    const reconciled: string[] = []
    const report = await reconcileFleet(fleet, async (tenant) => {
      reconciled.push(tenant.slug)
      return okReport(tenant.realmName)
    })
    expect(reconciled).toEqual(['verein'])
    expect(report.rows.filter((r) => r.outcome === 'skipped').map((r) => r.slug).sort()).toEqual(['dying', 'half'])
    expect(report.anyFailed).toBe(false)
  })

  it('a FAILED check on one tenant sets anyFailed (exit 1) but does NOT stop the rest of the fleet', async () => {
    const fleet = [t('verein', 'active'), t('rat', 'active')]
    const reconciled: string[] = []
    const report = await reconcileFleet(fleet, async (tenant) => {
      reconciled.push(tenant.slug)
      return tenant.slug === 'verein' ? failReport(tenant.realmName) : okReport(tenant.realmName)
    })
    // both ran (a failed check on the first does not abort the loop)…
    expect(reconciled).toEqual(['verein', 'rat'])
    // …and the genuine failure still trips the exit-1 flag.
    expect(report.anyFailed).toBe(true)
  })

  it('a THROWN reconcile (Admin-API error) on one tenant is recorded as an error row, the fleet continues, anyFailed is set', async () => {
    const fleet = [t('verein', 'active'), t('rat', 'active')]
    const reconciled: string[] = []
    const report = await reconcileFleet(fleet, async (tenant) => {
      reconciled.push(tenant.slug)
      if (tenant.slug === 'verein') throw new Error('Keycloak Admin API error: 503')
      return okReport(tenant.realmName)
    })
    // the throw on verein did NOT stop rat from being reconciled.
    expect(reconciled).toEqual(['verein', 'rat'])
    const errRow = report.rows.find((r) => r.slug === 'verein')!
    expect(errRow.outcome).toBe('error')
    expect(errRow.error).toMatch(/503/)
    expect(report.rows.find((r) => r.slug === 'rat')!.outcome).toBe('reconciled')
    expect(report.anyFailed).toBe(true)
  })

  it('an all-green realm-bearing fleet reconciles every tenant and stays clean', async () => {
    const fleet = [t('verein', 'active'), t('rat', 'suspended')]
    const report = await reconcileFleet(fleet, async (tenant) => okReport(tenant.realmName))
    expect(report.rows.every((r) => r.outcome === 'reconciled')).toBe(true)
    expect(report.anyFailed).toBe(false)
  })
})
