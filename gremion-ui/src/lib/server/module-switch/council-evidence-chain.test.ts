// Karenz phase 1, branch fix: the two halves of a council request's evidence, tested TOGETHER.
//   submit side   auth.ts jwtCallback + sessionCallback -> submitModuleSwitch (what it records and sends)
//   executor side verifyCouncilRequest (what it checks against the signed tokens)
// service.test.ts pins what the service records and council-verify.test.ts pins what the executor accepts,
// each from its own fixture; neither would notice a pair of values that does not fit. Here a REAL-SHAPED
// login (an access token carrying the `sub` mapper's real user id, an ID token with a pairwise sub and a
// sign-in a few seconds before the server stamped it) goes through the real callbacks and the real service,
// and the row the platform would store goes to the real executor-side verification.
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import type { TenantContext } from '$lib/server/tenant/context'

const h = vi.hoisted(() => ({
  getCouncilDb: vi.fn(),
  insertSwitch: vi.fn(),
  readConfig: vi.fn(),
  writeAuditEntry: vi.fn(),
  envMock: { AUTH_SECRET: 'test-secret' } as Record<string, string>,
}))

vi.mock('$env/dynamic/private', () => ({ env: h.envMock }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: (ref: string) => `secret-for-${ref}` }))
vi.mock('./council-db', async (orig) => ({ ...(await orig<typeof import('./council-db')>()), getCouncilDb: h.getCouncilDb }))
vi.mock('./store', () => ({ insertSwitch: h.insertSwitch, listSwitches: vi.fn().mockResolvedValue([]) }))
vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))

import { __jwtCallbackForTests, __sessionCallbackForTests } from '../../../auth'
import { verifyCouncilRequest, type CouncilRequestRow } from '../tenant/provisioner/council-verify'
import { issuerForTenant } from '../tenant/provisioner/realm-doc'
import { submitModuleSwitch } from './service'

const CUSTOMER = '11111111-1111-4111-8111-111111111111'
const PERSON = '22222222-2222-4222-8222-222222222222'
const PAIRWISE = 'pairwise-id-token-sub-not-the-user-id'
const REQUEST = '33333333-3333-4333-8333-333333333333'
const HOST = 'rat-a.example'
const REALM = 'realm-a'
const ISS = issuerForTenant(HOST, REALM)
const tenant = { id: CUSTOMER, slug: 'rat-a', db: {} } as unknown as TenantContext

let priv: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  priv = kp.privateKey
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' } as JWK] })
})

const atHash = (accessToken: string) => createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url')
const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).sign(priv)

/** The tokens of one gremion-ui code exchange: `sub` only in the access token as the real id, the ID token pairwise. */
async function exchange(nowSec: number, idTimes: { auth_time?: number; iat: number }) {
  const common = { iss: ISS, aud: 'gremion-ui', azp: 'gremion-ui', acr: 'loa2', sid: 'sess-1' }
  const access = await sign({
    ...common, typ: 'Bearer', sub: PERSON, iat: nowSec - 1, exp: nowSec + 299,
    realm_access: { roles: ['council-admin', 'default-roles-realm-a'] }, groups: [], preferred_username: 'ada',
  })
  const id = await sign({ ...common, typ: 'ID', sub: PAIRWISE, exp: nowSec + 299, at_hash: atHash(access), ...idTimes })
  return { access, id }
}

describe('a council module switch: the submit side and the executor side agree on one session', () => {
  let submitted: unknown[]

  beforeEach(() => {
    submitted = []
    h.insertSwitch.mockReset().mockResolvedValue(undefined)
    h.writeAuditEntry.mockReset().mockResolvedValue(undefined)
    h.readConfig.mockReset().mockReturnValue({ modules: { votes: false } })
    const state = ['board', 'calendar', 'elections', 'files', 'handover', 'messaging', 'publishing', 'votes', 'vault'].map((k) => ({
      module_key: k, name: k, state: 'disabled', has_row: false, dpia_recorded: false,
    }))
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      if (text.includes('council_module_state')) return Promise.resolve(state)
      // Karenz phase 2: the service reads the module's live Karenz rows before it queues a switch (none here)
      if (text.includes('council_karenz_list')) return Promise.resolve([])
      if (text.includes('submit_council_module_request')) {
        submitted = values
        return Promise.resolve([{ request_id: REQUEST }])
      }
      throw new Error(`unexpected platform query: ${text}`)
    }
    // postgres.js: jsonb values go through sql.json, as in the real pool
    ;(sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({ __pgJson: v })
    h.getCouncilDb.mockReturnValue(sql)
  })

  // The login is a few seconds old when the jwt callback stamps the server-side step-up time, so the
  // ID token's own sign-in time is NOT the value the callback produced. Both token shapes are exercised.
  it.each([
    ['auth_time (a step-up with max_age)', (n: number) => ({ auth_time: n - 5, iat: n - 3 })],
    ['iat only (the realm emits no auth_time)', (n: number) => ({ iat: n - 4 })],
  ])('a fresh loa2 login with %s is verified by the executor', async (_name, idTimes) => {
    const nowSec = Math.floor(Date.now() / 1000)
    const { access, id } = await exchange(nowSec, idTimes(nowSec))

    // the real callbacks, as Auth.js runs them after the code exchange
    const jwt = (await __jwtCallbackForTests({
      token: { sub: PAIRWISE },
      account: { access_token: access, id_token: id, expires_at: nowSec + 299 },
      profile: {},
    } as never)) as Record<string, unknown>
    const session = (await __sessionCallbackForTests({ session: { user: {}, expires: '2099-01-01T00:00:00.000Z' }, token: jwt } as never)) as unknown as {
      user: SessionUser
      idToken?: string
      accessToken?: string
    }
    expect(session.user.id).toBe(PERSON)
    expect(session.user.loa).toBeGreaterThanOrEqual(2)
    expect(session.user.roles).toContain(Role.CouncilAdmin)

    // the service, as the route calls it
    const result = await submitModuleSwitch(
      { tenant, user: session.user, idToken: session.idToken!, accessToken: session.accessToken! },
      { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } },
      { newKey: () => '44444444-4444-4444-8444-444444444444' },
    )
    expect(result).toEqual({ ok: true, requestId: REQUEST })

    // the row the platform stores from that submit: kind, slug, args, key, person, acr, auth time, evidence
    const [kind, slug, args, , person, , authTime, evidence] = submitted as [string, string, string, string, string, string, string, string]
    const row: CouncilRequestRow = {
      kind,
      customer_slug: slug,
      args: (args as unknown as { __pgJson: unknown }).__pgJson,
      operator_id: person,
      evidence_auth_time: new Date(authTime),
      evidence_token: evidence,
      evidence_verified_at: null,
      created_at: new Date(),
    }

    // the executor side: the same tokens, the realm's own keys
    const verdict = await verifyCouncilRequest(
      row,
      {
        kcInternalBase: () => 'http://keycloak:8080',
        provisionerTransport: () => async (_m, path) => (path.endsWith('/composite') ? [{ name: 'council-admin' }] : { enabled: true }),
        customerRealmForSlug: async () => ({ realm: REALM, host: HOST }),
      },
      { catalogueIds: ['calendar', 'elections', 'votes'], disabledIds: [], jwksFor: () => jwks },
    )
    expect(verdict).toMatchObject({ verdict: 'ok', kind: 'enable_module', slug: 'rat-a', origin: 'council', operatorId: PERSON })
  })
})
