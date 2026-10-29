// P2.1c (T11) — realm-reconcile (the R5 drift guard) unit tests. Mocked
// transport, no network, no DB. A green realm passes every named check; each
// single planted drift fails EXACTLY that named check; apply issues exactly the
// repairing calls (§4-2 idempotent sequence) and nothing else.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KcTransport } from './kc-admin-api'
import {
  reconcileRealm,
  reconcileFleet,
  withKernelAuditCheck,
  KERNEL_DB_CHECK_NAMES,
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
// buildTenantRealmDoc at tenant-create time, and by loadBaseRealmDoc() in
// scripts/tenant-provision.ts). Resolve it to this suite's example apex so the
// fixtures exercise the same shape a real deployment gets.
const TEST_APEX = 'council.example'
const base = JSON.parse(
  readFileSync(join(KC, 'realm-export.base.json'), 'utf-8').split('__APEX_DOMAIN__').join(TEST_APEX),
)

const REALM = 'verein'
const APEX = 'council.example'
const HOST = 't2.council.example' // tenant subdomain host (D-ISSUER-HOST)
/** TASK-043: the realm's own sender, kc-<token>@<platform domain>. */
const SENDER = { platformDomain: 'platform.example', token: 'verein' }
/** TASK-043 Q10: a seed-subject id and the template fixture usernames. */
const SEED_SUBJECT = '00000000-0000-4000-8000-00000000d005'
const FIXTURES = { ids: new Set([SEED_SUBJECT]), usernames: new Set(['dev.admin', 'anna.berger']) }

/** The exact per-tenant gremion-ui URI set (apex host swapped for the tenant host,
 *  shapes preserved — never a wildcard), with localhost/foreign-host entries
 *  DROPPED (#240 B/C — a provisioned realm carries ONLY tenant-host URIs).
 *  Mirrors §4-4 + the hardened expectedUiUris. */
const EXPECTED_REDIRECT = [`https://${HOST}/auth/callback/keycloak`]
const EXPECTED_WEB_ORIGINS = [`https://${HOST}`]

/** The Keycloak Admin API's flattened execution list for stepup-2fa in its
 *  hardened shape (security sweep 2, finding 3): the LoA-2 condition, then ONE
 *  REQUIRED subflow whose children are OTP (ALTERNATIVE) then deny (ALTERNATIVE).
 *  There is no REQUIRED OTP form: it would enroll an attacker's authenticator
 *  inside the step-up and still grant loa2. */
const GREEN_2FA_EXECS = () => [
  { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0, authenticationConfig: 'cfg-2' },
  { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'REQUIRED', level: 0, index: 1 },
  { id: 'o2', providerId: 'auth-otp-form', requirement: 'ALTERNATIVE', level: 1, index: 0 },
  { id: 'd2', providerId: 'deny-access-authenticator', requirement: 'ALTERNATIVE', level: 1, index: 1 },
]
/** Security sweep 2 (finding 6): the realm-level hardening a green realm carries. */
const GREEN_HARDENING = {
  passwordPolicy: 'length(12) and notUsername and notEmail and passwordHistory(3)',
}

/** The access-token sub mapper (the shape the base template's gremion-ui client carries). */
const SUB_MAPPER = { name: 'sub', protocolMapper: 'oidc-usermodel-property-mapper', config: { 'claim.name': 'sub', 'access.token.claim': 'true' } }

/** The auth_time mapper exactly as the shipped base template's gremion-ui client carries it (TASK-081 step-up: no auth_time claim, no fresh step-up). */
const AUTH_TIME_MAPPER = {
  id: 'pm-auth-time',
  ...(base.clients.find((c: { clientId: string }) => c.clientId === 'gremion-ui').protocolMappers.find((m: { name: string }) => m.name === 'auth_time') as { protocolMapper: string; config: Record<string, string> }),
}
const UI_MAPPERS = 'GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models'

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
      ...GREEN_HARDENING,
      // TASK-043 r4: the customer's own host (realm-doc.ts (2d))
      attributes: { 'acr.loa.map': '{"loa1":1,"loa2":2}', frontendUrl: `https://${HOST}/auth` },
      // TASK-043 R-E5b: stamped by the host with the realm's OWN principal
      // (Keycloak answers the set password as its mask).
      smtpServer: {
        host: `mail.${SENDER.platformDomain}`,
        port: '587',
        from: `kc-${SENDER.token}@${SENDER.platformDomain}`,
        user: `kc-${SENDER.token}@${SENDER.platformDomain}`,
        auth: 'true',
        starttls: 'true',
        ssl: 'false',
        password: '**********',
      },
    },
    // flows + subflows
    [`GET /admin/realms/${REALM}/authentication/flows`]: [{ alias: 'browser-stepup' }, { alias: 'browser' }],
    [`GET /admin/realms/${REALM}/authentication/flows/stepup-1fa/executions`]: [
      { id: 'c1', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-1' },
      { id: 'p1', providerId: 'auth-username-password-form' },
    ],
    [`GET /admin/realms/${REALM}/authentication/flows/stepup-2fa/executions`]: GREEN_2FA_EXECS(),
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
        attributes: { 'pkce.code.challenge.method': 'S256' },
        redirectUris: [...EXPECTED_REDIRECT],
        webOrigins: [...EXPECTED_WEB_ORIGINS],
      },
    ],
    'GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models': [
      { name: 'acr', protocolMapper: 'oidc-acr-mapper' },
      SUB_MAPPER,
      AUTH_TIME_MAPPER,
    ],
    // TASK-033-a: gremion-mobile is the other Bearer client; its access token must carry sub too
    [`GET /admin/realms/${REALM}/clients?clientId=gremion-mobile`]: [{ id: 'uuid-mobile', clientId: 'gremion-mobile' }],
    'GET /admin/realms/verein/clients/uuid-mobile/protocol-mappers/models': [SUB_MAPPER],
    'GET /admin/realms/verein/clients/uuid-mobile/default-client-scopes': [],
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

const opts = { realm: REALM, tenantHost: HOST, apexDomain: APEX, base, sender: SENDER, fixtures: FIXTURES }

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
      ;(r[`GET /admin/realms/${REALM}`] as any).attributes = { frontendUrl: `https://${HOST}/auth` }
    })
    expect(failed).toEqual(['acr-loa-map'])
  })

  // TASK-043 r4: with no frontendUrl, Keycloak (no --hostname) builds every
  // mailed link from the ADMIN call's address (measured: the internal one).
  it.each([
    ['absent', undefined],
    ['the internal address', 'https://keycloak:8443/auth'],
    ['the apex', `https://${APEX}/auth`],
  ])('a frontendUrl that is %s -> only frontend-url fails', async (_w, value) => {
    const failed = await failedNames((r) => {
      const a = (r[`GET /admin/realms/${REALM}`] as any).attributes
      if (value === undefined) delete a.frontendUrl
      else a.frontendUrl = value
    })
    expect(failed).toEqual(['frontend-url'])
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
    expect(failed).toEqual(['stepup-flow', 'stepup-loa-config', 'stepup-2fa-otp-gate'])
  })

  // Security sweep 2, finding 3: a REQUIRED OTP form in stepup-2fa enrolls an
  // attacker authenticator for a user with no OTP and still grants loa2.
  it.each([
    [
      'the legacy REQUIRED OTP form straight in stepup-2fa',
      () => [
        { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0, authenticationConfig: 'cfg-2' },
        { id: 'o2', providerId: 'auth-otp-form', requirement: 'REQUIRED', level: 0, index: 1 },
      ],
    ],
    [
      'an OTP alternative with no deny-access sibling',
      () => GREEN_2FA_EXECS().filter((e) => e.providerId !== 'deny-access-authenticator'),
    ],
    [
      'the OTP form REQUIRED inside the subflow',
      () => GREEN_2FA_EXECS().map((e) => (e.providerId === 'auth-otp-form' ? { ...e, requirement: 'REQUIRED' } : e)),
    ],
    [
      'deny-access DISABLED',
      () => GREEN_2FA_EXECS().map((e) => (e.providerId === 'deny-access-authenticator' ? { ...e, requirement: 'DISABLED' } : e)),
    ],
    [
      'deny-access ordered before the OTP form',
      () =>
        GREEN_2FA_EXECS().map((e) =>
          e.providerId === 'deny-access-authenticator' ? { ...e, index: 0 } : e.providerId === 'auth-otp-form' ? { ...e, index: 1 } : e,
        ),
    ],
    [
      'the subflow itself not REQUIRED',
      () => GREEN_2FA_EXECS().map((e) => (e.id === 's2' ? { ...e, requirement: 'ALTERNATIVE' } : e)),
    ],
    // Review finding (MEDIUM): the subflow must hold EXACTLY [OTP, deny-access].
    // An allow-access (or any authenticator that needs no user) ALTERNATIVE
    // between them lets a user without OTP through at loa2.
    [
      'an extra allow-access ALTERNATIVE between the OTP form and deny-access',
      () => [
        ...GREEN_2FA_EXECS().slice(0, 3),
        { id: 'a2', providerId: 'allow-access-authenticator', requirement: 'ALTERNATIVE', level: 1, index: 1 },
        { ...GREEN_2FA_EXECS()[3]!, index: 2 },
      ],
    ],
    [
      'an extra allow-access ALTERNATIVE after deny-access',
      () => [...GREEN_2FA_EXECS(), { id: 'a2', providerId: 'allow-access-authenticator', requirement: 'ALTERNATIVE', level: 1, index: 2 }],
    ],
    [
      'a nested flow inside the second-factor subflow',
      () => [...GREEN_2FA_EXECS(), { id: 'n2', displayName: 'sneaky', authenticationFlow: true, requirement: 'ALTERNATIVE', level: 1, index: 2 }],
    ],
    [
      'the OTP form and deny-access under a DIFFERENT subflow than the second-factor one',
      () => [
        GREEN_2FA_EXECS()[0]!,
        GREEN_2FA_EXECS()[1]!,
        { id: 'x2', displayName: 'decoy', authenticationFlow: true, requirement: 'REQUIRED', level: 0, index: 2 },
        GREEN_2FA_EXECS()[2]!,
        GREEN_2FA_EXECS()[3]!,
      ],
    ],
  ])('%s -> only stepup-2fa-otp-gate fails', async (_why, execs) => {
    const failed = await failedNames((r) => {
      r[`GET /admin/realms/${REALM}/authentication/flows/stepup-2fa/executions`] = execs()
    })
    expect(failed).toEqual(['stepup-2fa-otp-gate'])
  })

  it('a DISABLED extra execution in the second-factor subflow is inert and does not fail the gate', async () => {
    const failed = await failedNames((r) => {
      r[`GET /admin/realms/${REALM}/authentication/flows/stepup-2fa/executions`] = [
        ...GREEN_2FA_EXECS(),
        { id: 'a2', providerId: 'allow-access-authenticator', requirement: 'DISABLED', level: 1, index: 2 },
      ]
    })
    expect(failed).toEqual([])
  })

  it.each([
    ['absent', undefined],
    ['too short', 'length(8)'],
    ['without history', 'length(12) and notUsername and notEmail'],
  ])('a password policy that is %s -> only password-policy fails', async (_w, value) => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}`] as any).passwordPolicy = value
    })
    expect(failed).toEqual(['password-policy'])
  })

  it.each([
    ['revokeRefreshToken on', { revokeRefreshToken: true, refreshTokenMaxReuse: 0 }],
    ['revokeRefreshToken off', { revokeRefreshToken: false }],
    ['revokeRefreshToken absent', { revokeRefreshToken: undefined }],
    ['refreshTokenMaxReuse 2', { refreshTokenMaxReuse: 2 }],
  ])('%s -> no check fails: refresh-token rotation is deliberately NOT reconciled (docs/auth.md residual)', async (_w, patch) => {
    const failed = await failedNames((r) => {
      Object.assign(r[`GET /admin/realms/${REALM}`] as object, patch)
    })
    expect(failed).toEqual([])
  })

  it.each([
    ['absent', undefined],
    ['plain', 'plain'],
    ['empty', ''],
  ])('gremion-ui PKCE method %s -> only gremion-ui-pkce fails', async (_w, value) => {
    const failed = await failedNames((r) => {
      ;(r[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].attributes = value === undefined ? {} : { 'pkce.code.challenge.method': value }
    })
    expect(failed).toEqual(['gremion-ui-pkce'])
  })

  it('wrong LoA maxAge on loa2 -> only stepup-loa-config fails', async () => {
    const failed = await failedNames((r) => {
      ;(r['GET /admin/realms/verein/authentication/config/cfg-2'] as any).config['loa-max-age'] = '99999'
    })
    expect(failed).toEqual(['stepup-loa-config'])
  })

  it('missing acr mapper -> only gremion-ui-acr-mapper fails', async () => {
    const failed = await failedNames((r) => {
      r['GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models'] = [SUB_MAPPER, AUTH_TIME_MAPPER]
    })
    expect(failed).toEqual(['gremion-ui-acr-mapper'])
  })

  it('the shipped base template carries the auth_time mapper the check looks for (the fixture is not invented)', () => {
    expect(AUTH_TIME_MAPPER.protocolMapper).toBe('oidc-usersessionmodel-note-mapper')
    expect((AUTH_TIME_MAPPER as any).config).toMatchObject({ 'user.session.note': 'AUTH_TIME', 'claim.name': 'auth_time', 'access.token.claim': 'true' })
  })

  it('missing auth_time mapper (a realm created before it) -> only gremion-ui-auth-time-mapper fails', async () => {
    const failed = await failedNames((r) => {
      r[UI_MAPPERS] = [{ name: 'acr', protocolMapper: 'oidc-acr-mapper' }, SUB_MAPPER]
    })
    expect(failed).toEqual(['gremion-ui-auth-time-mapper'])
  })

  it.each([
    ['the claim missing from the access token', { 'access.token.claim': 'false' }],
    ['another session note', { 'user.session.note': 'SOMETHING_ELSE' }],
    ['another claim name', { 'claim.name': 'authtime' }],
  ])('an auth_time mapper with %s -> only gremion-ui-auth-time-mapper fails', async (_w, patch) => {
    const failed = await failedNames((r) => {
      r[UI_MAPPERS] = [{ name: 'acr', protocolMapper: 'oidc-acr-mapper' }, SUB_MAPPER, { ...AUTH_TIME_MAPPER, config: { ...(AUTH_TIME_MAPPER as any).config, ...patch } }]
    })
    expect(failed).toEqual(['gremion-ui-auth-time-mapper'])
  })

  it('missing uid sub-mapper -> gremion-ui-sub-mapper fails, and so does the Bearer-clients check (the same drift, seen per client)', async () => {
    const failed = await failedNames((r) => {
      r['GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models'] = [
        { name: 'acr', protocolMapper: 'oidc-acr-mapper' },
        AUTH_TIME_MAPPER,
      ]
    })
    expect(failed).toEqual(['gremion-ui-sub-mapper', 'bearer-clients-sub'])
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

// TASK-043 TDD 11 / 12: the realm's own sender, and the narrowed fixture check.
describe('(TASK-043) smtp-server and the narrowed no-fixture-users', () => {
  const smtpOf = (routes: Record<string, unknown>) => (routes[`GET /admin/realms/${REALM}`] as any).smtpServer as Record<string, string>

  it.each([
    ['an unresolved sentinel', (s: Record<string, string>) => (s.user = '__SMTP_USER__'), /sentinel/],
    ['the retired platform@ sender', (s: Record<string, string>) => ((s.user = 'platform@platform.example'), (s.from = 'platform@platform.example')), /retired shared sender/],
    ['another customer\'s kc-* principal', (s: Record<string, string>) => (s.user = 'kc-other@platform.example'), /ANOTHER customer/],
    ['a plaintext port', (s: Record<string, string>) => (s.port = '25'), /port/],
    ['no STARTTLS', (s: Record<string, string>) => (s.starttls = 'false'), /starttls/],
    ['no password', (s: Record<string, string>) => delete (s as any).password, /no password/],
  ])('fails smtp-server ONLY on %s, marked repair: host', async (_what, mutate, re) => {
    const routes = greenRoutes()
    mutate(smtpOf(routes))
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['smtp-server'])
    expect(failed[0]!.detail).toMatch(re)
    expect(failed[0]!.detail).toMatch(/repair: host/)
    expect(report.repairHost).toEqual(['smtp-server'])
    // in-process apply never touches the sender: no mutating call at all
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('a realm with no smtpServer at all fails smtp-server', async () => {
    const routes = greenRoutes()
    delete (routes[`GET /admin/realms/${REALM}`] as any).smtpServer
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.checks.find((c) => c.name === 'smtp-server')?.ok).toBe(false)
  })

  it('the first administrators (real users) pass no-fixture-users', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/users?max=2000`] as any).push(
      { id: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33', username: 'it@verein.example' },
      { id: '6c9f1b63-3a0a-4c57-8f4b-1c6d8a2b3e44', username: 'rat@verein.example' },
    )
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.ok).toBe(true)
  })

  it('a user whose id is a seed subject fails no-fixture-users, whatever its username', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/users?max=2000`] as any).push({ id: SEED_SUBJECT, username: 'harmless' })
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed.map((c) => c.name)).toEqual(['no-fixture-users'])
    expect(failed[0]!.detail).toMatch(/harmless/)
  })

  it('a template fixture username fails no-fixture-users', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/users?max=2000`] as any).push({ id: '7da02c74-4b1b-4d68-9a5c-2d7e9b3c4f55', username: 'anna.berger' })
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['no-fixture-users'])
  })
})

// TASK-042 Q8 (RFC 9700 §2.1, exact redirect-URI matching): there is no
// default-realm exception any more. Every realm, whatever its tenant's slug, is
// held to the exact per-tenant URI set, so a localhost dev URI FAILS reconcile.
// TASK-033-a / TRD-147: a session without `sub` is refused (hooks.server.ts sessionUserFromPayload),
// so EVERY client whose tokens reach the Bearer branch must issue `sub`: gremion-ui and gremion-mobile
// (the default JWT audiences). Keycloak 25+ issues it through the built-in `basic` client scope; a realm
// imported from our template carries no `basic` scope, so the client needs a sub mapper of its own.
describe('reconcileRealm — every Bearer client issues sub (TASK-033-a)', () => {
  const MOBILE = `GET /admin/realms/${REALM}/clients?clientId=gremion-mobile`
  const MOBILE_MAPPERS = 'GET /admin/realms/verein/clients/uuid-mobile/protocol-mappers/models'
  const MOBILE_SCOPES = 'GET /admin/realms/verein/clients/uuid-mobile/default-client-scopes'
  const verify = async (mutate: (r: Record<string, unknown>) => void) => {
    const routes = greenRoutes()
    mutate(routes)
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    return { report, calls, failed: report.checks.filter((c) => !c.ok) }
  }

  it('is part of the realm contract (the named, ordered check list)', () => {
    expect(RECONCILE_CHECK_NAMES).toContain('bearer-clients-sub')
  })

  it('a mobile client with no sub mapper and no default scope that issues it -> only bearer-clients-sub fails, naming the client', async () => {
    const { failed } = await verify((r) => {
      r[MOBILE_MAPPERS] = []
    })
    expect(failed.map((c) => c.name)).toEqual(['bearer-clients-sub'])
    expect(failed[0]!.detail).toContain('gremion-mobile')
    expect(failed[0]!.detail).not.toContain('gremion-ui')
  })

  it('the built-in basic scope on the client satisfies it (Keycloak 25+ issues sub there)', async () => {
    const { failed } = await verify((r) => {
      r[MOBILE_MAPPERS] = []
      r[MOBILE_SCOPES] = [{ id: 'scope-basic', name: 'basic' }]
      r['GET /admin/realms/verein/client-scopes/scope-basic/protocol-mappers/models'] = [
        { name: 'sub', protocolMapper: 'oidc-sub-mapper', config: { 'access.token.claim': 'true' } },
      ]
    })
    expect(failed).toEqual([])
  })

  it('a default scope that carries no sub mapper does not count', async () => {
    const { failed } = await verify((r) => {
      r[MOBILE_MAPPERS] = []
      r[MOBILE_SCOPES] = [{ id: 'scope-profile', name: 'profile' }]
      r['GET /admin/realms/verein/client-scopes/scope-profile/protocol-mappers/models'] = [
        { name: 'username', protocolMapper: 'oidc-usermodel-property-mapper', config: { 'claim.name': 'preferred_username', 'access.token.claim': 'true' } },
      ]
    })
    expect(failed.map((c) => c.name)).toEqual(['bearer-clients-sub'])
  })

  it('a sub mapper that stays out of the ACCESS token does not count (Bearer tokens are access tokens)', async () => {
    const { failed } = await verify((r) => {
      r[MOBILE_MAPPERS] = [{ name: 'sub', protocolMapper: 'oidc-sub-mapper', config: { 'access.token.claim': 'false', 'id.token.claim': 'true' } }]
    })
    expect(failed.map((c) => c.name)).toEqual(['bearer-clients-sub'])
  })

  it('a client absent from the realm issues no tokens: nothing to check (gremion-ui absence has its own checks)', async () => {
    const { failed } = await verify((r) => {
      r[MOBILE] = []
    })
    expect(failed).toEqual([])
  })

  it('verify-only reports the drift and issues NO mutating call', async () => {
    const { calls, report } = await verify((r) => {
      r[MOBILE_MAPPERS] = []
    })
    expect(report.ok).toBe(false)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('apply, realm WITHOUT a basic scope (our imported template): POSTs the sub mapper to the client and records it applied', async () => {
    const routes = greenRoutes()
    routes[MOBILE_MAPPERS] = []
    routes[`GET /admin/realms/${REALM}/client-scopes`] = [{ id: 'scope-email', name: 'email' }]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'POST', path: `/admin/realms/${REALM}/clients/uuid-mobile/protocol-mappers/models` })
    expect(writes[0]!.body).toMatchObject({
      protocol: 'openid-connect',
      protocolMapper: 'oidc-usermodel-property-mapper',
      config: { 'claim.name': 'sub', 'user.attribute': 'id', 'access.token.claim': 'true' },
    })
    expect(report.applied).toContain('bearer-clients-sub')
  })

  it('apply, realm WITH a basic scope: attaches it as a default scope of the client instead of a private mapper', async () => {
    const routes = greenRoutes()
    routes[MOBILE_MAPPERS] = []
    routes[`GET /admin/realms/${REALM}/client-scopes`] = [{ id: 'scope-basic', name: 'basic' }]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toEqual([{ method: 'PUT', path: `/admin/realms/${REALM}/clients/uuid-mobile/default-client-scopes/scope-basic`, body: undefined }])
    expect(report.applied).toContain('bearer-clients-sub')
  })

  it('apply on a green realm issues no write for it', async () => {
    const { transport, calls } = scriptedTransport(greenRoutes())
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(report.applied).not.toContain('bearer-clients-sub')
  })
})

describe('(Q8) reconcileRealm — every realm is held to the exact per-tenant URI set', () => {
  const baseUi = (base.clients as any[]).find((c: any) => c.clientId === 'gremion-ui')
  const BASE_REDIRECT = [...baseUi.redirectUris]

  it('the base template carries a localhost URI (the fixture is non-vacuous)', () => {
    expect(BASE_REDIRECT.some((u: string) => /localhost/.test(u))).toBe(true)
  })

  it('a realm carrying the base localhost+apex URIs FAILS the redirect-URI check (no default exception)', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].redirectUris = [...BASE_REDIRECT]
    const { transport } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    const redir = report.checks.find((c) => c.name === 'gremion-ui-redirect-uris')!
    expect(redir.ok).toBe(false)
    expect(report.ok).toBe(false)
  })

  it('the options carry no default flag: a slug spelled default gets the same checks as alpha', async () => {
    async function reportFor(slug: string) {
      const host = `${slug}.${APEX}`
      const routes = greenRoutes()
      const ui = (routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0]
      ui.redirectUris = ui.redirectUris.map((u: string) => u.split(HOST).join(host))
      ui.webOrigins = ui.webOrigins.map((u: string) => u.split(HOST).join(host))
      ;(routes[`GET /admin/realms/${REALM}`] as any).attributes.frontendUrl = `https://${host}/auth`
      const { transport } = scriptedTransport(routes)
      const r = await reconcileRealm(transport, { ...opts, tenantHost: host, verifyOnly: true })
      return JSON.parse(JSON.stringify(r).split(host).join('<host>'))
    }
    const d = await reportFor('default')
    expect(d.ok).toBe(true)
    expect(d).toEqual(await reportFor('alpha'))
  })
})

describe('(FIX3-B) reconcileRealm — realm segment is encodeURIComponent-encoded in every realm-scoped path', () => {
  // Defence-in-depth: the CLI already validateSlug's the realm, but reconcile's
  // own get()/PUT helpers must encode the realm as a single path segment so a
  // future caller forgetting the guard cannot break out of the segment (no `../`,
  // no query injection, no spaces) — matching KcProvisionApi.realmGet/realmReq.
  const EVIL_REALM = '../master?evil=1'
  const ENCODED = encodeURIComponent(EVIL_REALM) // '..%2Fmaster%3Fevil%3D1'
  const evilOpts = { realm: EVIL_REALM, tenantHost: HOST, apexDomain: APEX, base, sender: SENDER, fixtures: FIXTURES }

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
        ...GREEN_HARDENING,
        attributes: { 'acr.loa.map': '{"loa1":1,"loa2":2}' },
      },
      [`GET ${R}/authentication/flows`]: [{ alias: 'browser-stepup' }],
      [`GET ${R}/authentication/flows/stepup-1fa/executions`]: [
        { id: 'c1', providerId: 'conditional-level-of-authentication', authenticationConfig: 'cfg-1' },
        { id: 'p1', providerId: 'auth-username-password-form' },
      ],
      [`GET ${R}/authentication/flows/stepup-2fa/executions`]: GREEN_2FA_EXECS(),
      [`GET ${R}/authentication/config/cfg-1`]: { config: { 'loa-condition-level': '1', 'loa-max-age': '36000' } },
      [`GET ${R}/authentication/config/cfg-2`]: { config: { 'loa-condition-level': '2', 'loa-max-age': '300' } },
      [`GET ${R}/clients?clientId=gremion-ui`]: [
        {
          id: 'uuid-ui',
          clientId: 'gremion-ui',
          fullScopeAllowed: false,
          attributes: { 'pkce.code.challenge.method': 'S256' },
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

  it('a missing auth_time mapper -> apply POSTs exactly the template mapper to gremion-ui, and nothing else', async () => {
    const routes = greenRoutes()
    routes[UI_MAPPERS] = [{ name: 'acr', protocolMapper: 'oidc-acr-mapper' }, SUB_MAPPER]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'POST', path: '/admin/realms/verein/clients/uuid-ui/protocol-mappers/models' })
    expect(writes[0]!.body).toMatchObject({ name: 'auth_time', protocol: 'openid-connect', protocolMapper: 'oidc-usersessionmodel-note-mapper' })
    expect((writes[0]!.body as any).config).toEqual((AUTH_TIME_MAPPER as any).config)
    expect(report.applied).toEqual(['gremion-ui-auth-time-mapper'])
  })

  it('an auth_time mapper that exists but drifted -> apply PUTs it by id (a POST would 409), once', async () => {
    const routes = greenRoutes()
    routes[UI_MAPPERS] = [SUB_MAPPER, { name: 'acr', protocolMapper: 'oidc-acr-mapper' }, { ...AUTH_TIME_MAPPER, config: { ...(AUTH_TIME_MAPPER as any).config, 'access.token.claim': 'false' } }]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/admin/realms/verein/clients/uuid-ui/protocol-mappers/models/pm-auth-time' })
    expect((writes[0]!.body as any).config['access.token.claim']).toBe('true')
    expect((writes[0]!.body as any).id).toBe('pm-auth-time')
    expect(report.applied).toEqual(['gremion-ui-auth-time-mapper'])
  })

  it('verify-only reports the missing auth_time mapper and writes nothing', async () => {
    const routes = greenRoutes()
    routes[UI_MAPPERS] = [{ name: 'acr', protocolMapper: 'oidc-acr-mapper' }, SUB_MAPPER]
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: true })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'gremion-ui-auth-time-mapper')?.detail).toMatch(/auth_time/)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('a frontendUrl on the internal address -> apply issues ONE partial realm PUT that sets the customer host and keeps acr.loa.map', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}`] as any).attributes.frontendUrl = 'https://keycloak:8443/auth'
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === `/admin/realms/${REALM}`)
    expect(puts).toHaveLength(1)
    expect((puts[0]!.body as any).attributes.frontendUrl).toBe(`https://${HOST}/auth`)
    expect((puts[0]!.body as any).attributes['acr.loa.map']).toBe('{"loa1":1,"loa2":2}')
    expect(report.applied).toContain('frontend-url')
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

  it('security sweep 2 (finding 3): a legacy REQUIRED OTP form -> apply rebuilds stepup-2fa as OTP-or-deny and records it applied', async () => {
    const routes = greenRoutes()
    const F = `/admin/realms/${REALM}/authentication`
    routes[`GET ${F}/flows/stepup-2fa/executions`] = [
      { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0, authenticationConfig: 'cfg-2' },
      { id: 'o2', providerId: 'auth-otp-form', requirement: 'REQUIRED', level: 0, index: 1 },
    ]
    // a stateful Keycloak: the subflow appears once created, its children once added
    let created = false
    let childAdds = 0
    const { transport: inner, calls } = scriptedTransport(routes)
    const transport: KcTransport = async (method, path, body) => {
      const r = await inner(method, path, body)
      if (method === 'POST' && path === `${F}/flows/stepup-2fa/executions/flow`) created = true
      if (method === 'POST' && path === `${F}/flows/stepup-2fa%20second%20factor/executions/execution`) childAdds++
      if (method === 'GET' && path === `${F}/flows/stepup-2fa/executions` && created) {
        return [
          { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0, authenticationConfig: 'cfg-2' },
          { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'DISABLED', level: 0, index: 1 },
          { id: 'o2', providerId: 'auth-otp-form', requirement: 'REQUIRED', level: 0, index: 2 },
        ]
      }
      if (method === 'GET' && path === `${F}/flows/stepup-2fa%20second%20factor/executions`) {
        return [
          ...(childAdds >= 1 ? [{ id: 'n-otp', providerId: 'auth-otp-form', requirement: 'DISABLED', level: 0, index: 0 }] : []),
          ...(childAdds >= 2 ? [{ id: 'n-deny', providerId: 'deny-access-authenticator', requirement: 'DISABLED', level: 0, index: 1 }] : []),
        ]
      }
      return r
    }
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    // the REQUIRED OTP execution is removed from stepup-2fa…
    expect(calls).toContainEqual({ method: 'DELETE', path: `/admin/realms/${REALM}/authentication/executions/o2`, body: undefined })
    // …a REQUIRED subflow is added, holding OTP then deny-access, both ALTERNATIVE
    expect(calls.find((c) => c.method === 'POST' && c.path === `${F}/flows/stepup-2fa/executions/flow`)!.body).toEqual({
      alias: 'stepup-2fa second factor',
      type: 'basic-flow',
    })
    const adds = calls.filter((c) => c.method === 'POST' && c.path === `${F}/flows/stepup-2fa%20second%20factor/executions/execution`)
    expect(adds.map((c) => (c.body as any).provider)).toEqual(['auth-otp-form', 'deny-access-authenticator'])
    const reqs = calls
      .filter((c) => c.method === 'PUT' && c.path === `${F}/flows/browser-stepup/executions`)
      .map((c) => c.body)
    expect(reqs).toEqual([
      { id: 's2', requirement: 'REQUIRED' },
      { id: 'n-otp', requirement: 'ALTERNATIVE' },
      { id: 'n-deny', requirement: 'ALTERNATIVE' },
    ])
    expect(report.applied).toContain('stepup-2fa-otp-gate')
  })

  it('a missing password policy -> apply issues ONE partial realm PUT with exactly that field (no step-up replay, no refresh-token fields)', async () => {
    const routes = greenRoutes()
    Object.assign(routes[`GET /admin/realms/${REALM}`] as object, {
      passwordPolicy: undefined,
      revokeRefreshToken: false,
      refreshTokenMaxReuse: 3,
    })
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toEqual([
      {
        method: 'PUT',
        path: `/admin/realms/${REALM}`,
        body: {
          realm: REALM,
          passwordPolicy: 'length(12) and notUsername and notEmail and passwordHistory(3)',
        },
      },
    ])
    expect(report.applied).toEqual(['password-policy'])
  })

  it('a gremion-ui without PKCE -> apply PUTs only the attribute (merged) to the client and records it applied', async () => {
    const routes = greenRoutes()
    ;(routes[`GET /admin/realms/${REALM}/clients?clientId=gremion-ui`] as any)[0].attributes = { 'post.logout.redirect.uris': 'x' }
    const { transport, calls } = scriptedTransport(routes)
    const report = await reconcileRealm(transport, { ...opts, verifyOnly: false })
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toEqual([
      {
        method: 'PUT',
        path: `/admin/realms/${REALM}/clients/uuid-ui`,
        body: { id: 'uuid-ui', clientId: 'gremion-ui', attributes: { 'post.logout.redirect.uris': 'x', 'pkce.code.challenge.method': 'S256' } },
      },
    ])
    expect(report.applied).toContain('gremion-ui-pkce')
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
  const okReport = (realm: string): ReconcileReport => ({ realm, ok: true, checks: [], applied: [], repairHost: [] })
  const failReport = (realm: string): ReconcileReport => ({
    realm,
    ok: false,
    checks: [{ name: 'ssl-required', ok: false, detail: 'drifted' }],
    applied: [],
    repairHost: [],
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

// TASK-033-a: the kernel audit_log is a governance record, append-only for the app (RC-GOV-CHAIN).
// The privilege lives in the customer's kernel database, not in the realm, so the verb adds ONE
// DB-level check to the realm report through an injected port: verify reads it, apply re-asserts it.
describe('withKernelAuditCheck: the audit-append-only check', () => {
  const green: ReconcileReport = { realm: REALM, ok: true, checks: [{ name: 'ssl-required', ok: true, detail: '' }], applied: [], repairHost: [] }
  const fakePort = (states: string[][]) => {
    const seq = [...states]
    const repair = vi.fn(async () => {})
    return { problems: vi.fn(async () => (seq.length > 1 ? seq.shift()! : seq[0]!)), repair }
  }

  it('is a named check of its own, outside the realm contract list', () => {
    expect([...KERNEL_DB_CHECK_NAMES]).toEqual(['audit-append-only'])
    expect((RECONCILE_CHECK_NAMES as readonly string[]).includes('audit-append-only')).toBe(false)
  })

  it('a clean kernel database adds a passing check and keeps the report green', async () => {
    const port = fakePort([[]])
    const r = await withKernelAuditCheck(green, port, true)
    expect(r.ok).toBe(true)
    expect(r.checks.at(-1)).toEqual({ name: 'audit-append-only', ok: true, detail: '' })
    expect(port.repair).not.toHaveBeenCalled()
  })

  it('verify-only reports the privilege still held and does NOT repair', async () => {
    const port = fakePort([['audit_log: k_x_app still holds DELETE (the kernel audit record is append-only)']])
    const r = await withKernelAuditCheck(green, port, true)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'audit-append-only', ok: false })
    expect(r.checks.at(-1)!.detail).toContain('still holds DELETE')
    expect(port.repair).not.toHaveBeenCalled()
    expect(r.applied).toEqual([])
  })

  it('apply repairs it once, re-reads, and the report turns green with the repair listed', async () => {
    const port = fakePort([['audit_log: k_x_app still holds DELETE'], []])
    const r = await withKernelAuditCheck(green, port, false)
    expect(port.repair).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
    expect(r.applied).toContain('audit-append-only')
    expect(r.checks.at(-1)).toMatchObject({ name: 'audit-append-only', ok: true })
  })

  it('apply that leaves the privilege in place stays RED (the post-condition is read, not assumed)', async () => {
    const port = fakePort([['audit_log: k_x_app still holds DELETE']])
    const r = await withKernelAuditCheck(green, port, false)
    expect(port.repair).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'audit-append-only', ok: false })
  })

  it('a port that throws fails the check with the reason; it never crashes the report', async () => {
    const port = { problems: vi.fn(async () => { throw new Error('connection refused') }), repair: vi.fn(async () => {}) }
    const r = await withKernelAuditCheck(green, port, true)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)!.detail).toContain('connection refused')
  })

  it('a realm report that already failed stays failed (the check never flips ok to true)', async () => {
    const red: ReconcileReport = { ...green, ok: false, checks: [{ name: 'ssl-required', ok: false, detail: 'x' }] }
    const r = await withKernelAuditCheck(red, fakePort([[]]), true)
    expect(r.ok).toBe(false)
  })
})
