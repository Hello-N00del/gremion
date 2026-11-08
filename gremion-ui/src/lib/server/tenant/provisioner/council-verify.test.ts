// Karenz phase 1, Task 5: the executor-side verification of a COUNCIL request.
// The evidence is the admin's signed loa2 token pair from the COUNCIL's own
// realm (client gremion-ui), not the ops realm; the admin is re-read in that
// realm. Fake JWKS key pairs sign the tokens here, nothing is fetched. The
// branch is tested directly (verifyCouncilRequest), not through the verb.
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { councilAdminStanding, verifyCouncilRequest, type CouncilRequestRow, type CouncilVerifyContext, type CouncilVerifyDeps } from './council-verify'
import { encodeEvidence, verifyRequestEvidence } from './request-verify'
import type { KcTransport } from './kc-admin-api'

const HOST_A = 'rat-a.example'
const ISS_A = `https://${HOST_A}/auth/realms/realm-a`
const ISS_B = 'https://rat-b.example/auth/realms/realm-b'
const ISS_OPS = 'https://platform.example/auth/realms/platform'
const PERSON = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const PAIRWISE = 'pairwise-id-token-sub-not-the-user-id'
const CREATED = new Date('2026-10-05T12:00:00Z')
const T = Math.floor(CREATED.getTime() / 1000)
const CATALOGUE = ['board', 'calendar', 'elections', 'files', 'handover', 'messaging', 'publishing', 'vault', 'votes']

let priv: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  priv = kp.privateKey
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwks = createLocalJWKSet({ keys: [jwk] })
})

const atHash = (accessToken: string) => createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url')

interface Over {
  iss?: string
  client?: string
  roles?: string[]
  acr?: string
  iat?: number
  /** the ACCESS token's sub: the gremion-ui client's `sub` mapper puts the real user id there (default PERSON) */
  sub?: string
  /** the ID token's sub: the gremion-ui ID token carries a different (pairwise) value or none (default: pairwise); null = no sub */
  idSub?: string | null
}

async function pair(o: Over = {}): Promise<{ id: string; access: string }> {
  const client = o.client ?? 'gremion-ui'
  const iss = o.iss ?? ISS_A
  const iat = o.iat ?? T - 600
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).sign(priv)
  const access = await sign({
    iss, aud: client, azp: client, typ: 'Bearer', acr: o.acr ?? 'loa2', sid: 's-1', sub: o.sub ?? PERSON, iat, exp: iat + 300,
    realm_access: { roles: o.roles ?? ['council-admin', 'default-roles-realm-a'] },
  })
  const idSub = o.idSub === undefined ? PAIRWISE : o.idSub
  const id = await sign({ iss, aud: client, azp: client, typ: 'ID', acr: o.acr ?? 'loa2', sid: 's-1', ...(idSub === null ? {} : { sub: idSub }), iat, exp: iat + 300, at_hash: atHash(access) })
  return { id, access }
}

const ARGS = { slug: 'musterstadt', module: 'votes', dpia: { requires_dpia: false, reason_codes: ['council_decision'], document_ref: 'TOM-Anhang 4.1' } }

async function row(over: Partial<CouncilRequestRow> = {}, o: Over = {}): Promise<CouncilRequestRow> {
  const e = await pair(o)
  return {
    kind: 'enable_module',
    customer_slug: 'musterstadt',
    args: ARGS,
    operator_id: PERSON,
    evidence_auth_time: new Date((o.iat ?? T - 600) * 1000),
    evidence_token: encodeEvidence(e),
    evidence_verified_at: null,
    created_at: CREATED,
    ...over,
  }
}

interface KcWorld {
  enabled?: boolean
  roles?: string[]
  missing?: boolean
}

function kcFor(w: KcWorld = {}): { kc: KcTransport; calls: string[] } {
  const calls: string[] = []
  const kc: KcTransport = async (method, path) => {
    calls.push(`${method} ${path}`)
    if (w.missing) throw new Error(`keycloak ${method} ${path}: 404 Not Found`)
    if (path.endsWith('/role-mappings/realm/composite')) return (w.roles ?? ['council-admin', 'default-roles-realm-a']).map((name) => ({ name }))
    return { enabled: w.enabled ?? true }
  }
  return { kc, calls }
}

interface Setup {
  ctx: CouncilVerifyContext
  deps: CouncilVerifyDeps
  calls: string[]
  realmLookups: string[]
}

function setup(w: KcWorld = {}, over: { realm?: { realm: string; host: string } | null; deps?: Partial<CouncilVerifyDeps> } = {}): Setup {
  const { kc, calls } = kcFor(w)
  const realmLookups: string[] = []
  const realm = over.realm === undefined ? { realm: 'realm-a', host: HOST_A } : over.realm
  return {
    calls,
    realmLookups,
    ctx: {
      kcInternalBase: () => 'http://keycloak:8080',
      provisionerTransport: () => kc,
      customerRealmForSlug: async (s) => {
        realmLookups.push(s)
        return realm
      },
    },
    deps: { catalogueIds: CATALOGUE, disabledIds: [], jwksFor: () => jwks, ...over.deps },
  }
}

describe('verifyCouncilRequest: the evidence', () => {
  it("council evidence from the customer's realm with role council-admin verifies", async () => {
    const s = setup()
    const v = await verifyCouncilRequest(await row(), s.ctx, s.deps)
    expect(v).toMatchObject({
      verdict: 'ok',
      kind: 'enable_module',
      slug: 'musterstadt',
      origin: 'council',
      operatorId: PERSON,
      args: { slug: 'musterstadt', module: 'votes', actorKind: 'person', dpia: { requiresDpia: 'no', reasonCodes: ['council_decision'] } },
    })
    expect(v.verdict === 'ok' ? v.evidence : '').toMatch(/signed loa2 sign-in of 5b8e0a52/)
    expect(s.realmLookups).toEqual(['musterstadt'])
  })

  it('an it-admin (who includes council-admin by the page hierarchy) verifies too', async () => {
    const s = setup({ roles: ['it-admin'] })
    expect((await verifyCouncilRequest(await row({}, { roles: ['it-admin'] }), s.ctx, s.deps)).verdict).toBe('ok')
  })

  it('a token pair signed by realm A for slug B is refused (issuer) (Review Focus 1)', async () => {
    // the customer of the request lives in realm B; the pair is realm A's
    const s = setup({}, { realm: { realm: 'realm-b', host: 'rat-b.example' } })
    const v = await verifyCouncilRequest(await row({}, { iss: ISS_A }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^evidence: .*iss/) })
    expect(s.calls).toEqual([]) // the realm was never asked about the admin
    // and the reverse: realm B's pair does verify against realm B
    const ok = await verifyCouncilRequest(await row({}, { iss: ISS_B }), s.ctx, s.deps)
    expect(ok.verdict).toBe('ok')
  })

  it('an ops-realm operator token presented for a council request is refused', async () => {
    const s = setup()
    const v = await verifyCouncilRequest(await row({}, { iss: ISS_OPS, client: 'control-panel', roles: ['operator'] }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^evidence: /) })
  })

  it('a council token without the council-admin realm role is refused', async () => {
    const s = setup()
    const v = await verifyCouncilRequest(await row({}, { roles: ['member', 'default-roles-realm-a'] }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^evidence: .*council-admin/) })
  })

  it('a token with acr loa1 is refused; a sign-in older than 3600 s is refused', async () => {
    const s = setup()
    expect(await verifyCouncilRequest(await row({}, { acr: 'loa1' }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/acr loa1/) })
    expect(await verifyCouncilRequest(await row({}, { iat: T - 3601 }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/3601 s before the request/) })
  })

  it("the person is bound through the ACCESS token's sub: the gremion-ui ID token's sub is pairwise (or absent) and is not compared", async () => {
    const s = setup()
    // the realistic shape of a gremion-ui pair: access sub = the real user id, ID sub = a different pairwise value
    expect((await verifyCouncilRequest(await row({}, { idSub: PAIRWISE }), s.ctx, s.deps)).verdict).toBe('ok')
    // and an ID token with no sub at all (the client imports no `basic` scope)
    expect((await verifyCouncilRequest(await row({}, { idSub: null }), s.ctx, s.deps)).verdict).toBe('ok')
  })

  it("the access token's sub must be the request's person (an ID sub equal to the person does not rescue another access sub)", async () => {
    const s = setup()
    const other = '00000000-0000-4000-8000-000000000000'
    const v = await verifyCouncilRequest(await row({}, { sub: other, idSub: PERSON }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/access token's sub .* is not the request's operator/) })
    expect(s.calls).toEqual([])
  })

  it('an access token without sub is refused (nothing binds the person)', async () => {
    const s = setup()
    const v = await verifyCouncilRequest(await row({}, { sub: '' }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/access token's sub/) })
  })

  it('a council request without its signed evidence is refused', async () => {
    const s = setup()
    expect(await verifyCouncilRequest(await row({ evidence_token: null }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/without its signed evidence/) })
  })

  it('a re-claimed request (evidence verified on an earlier claim) skips the tokens but still re-reads the admin', async () => {
    const s = setup()
    const v = await verifyCouncilRequest(await row({ evidence_token: null, evidence_verified_at: new Date('2026-10-05T12:00:30Z') }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'ok', evidence: expect.stringMatching(/verified at .* on an earlier claim/) })
    expect(s.calls.length).toBe(2)
  })
})

describe('verifyCouncilRequest: the kind and the module come first', () => {
  it.each(['create', 'suspend', 'resume', 'reconcile', 'record_dpia', 'import_members', 'seed_vertical'])(
    'kind %s is refused "not allowed for a council request" before any token is read',
    async (kind) => {
      const evidence = vi.fn(verifyRequestEvidence)
      const s = setup({}, { deps: { verifyEvidence: evidence } })
      const v = await verifyCouncilRequest(await row({ kind, args: { slug: 'musterstadt' } }), s.ctx, s.deps)
      expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not allowed for a council request/) })
      expect(evidence).not.toHaveBeenCalled()
      expect(s.realmLookups).toEqual([])
      expect(s.calls).toEqual([])
    },
  )

  it('with the switch off (injected false) a council disable_module row is refused DISABLE_NOT_YET before any token is read (Review Focus 8)', async () => {
    const evidence = vi.fn(verifyRequestEvidence)
    const s = setup({}, { deps: { verifyEvidence: evidence, councilDisableAllowed: false } })
    const v = await verifyCouncilRequest(await row({ kind: 'disable_module', args: { slug: 'musterstadt', module: 'votes' } }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^DISABLE_NOT_YET/) })
    expect(evidence).not.toHaveBeenCalled()
    expect(s.calls).toEqual([])
  })

  it('with the phase 2 switch on (injected), a council disable_module verifies with actorKind person', async () => {
    const s = setup({}, { deps: { councilDisableAllowed: true } })
    const v = await verifyCouncilRequest(await row({ kind: 'disable_module', args: { slug: 'musterstadt', module: 'votes' } }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'ok', kind: 'disable_module', args: { module: 'votes', actorKind: 'person' } })
  })

  it.each(['files', 'messaging', 'publishing', 'handover'])('a council enable of %s is refused MODULE_NOT_SWITCHABLE before any token is read (Review Focus 7)', async (module) => {
    const evidence = vi.fn(verifyRequestEvidence)
    const s = setup({}, { deps: { verifyEvidence: evidence } })
    const v = await verifyCouncilRequest(await row({ args: { ...ARGS, module } }), s.ctx, s.deps)
    expect(v).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^MODULE_NOT_SWITCHABLE/) })
    expect(evidence).not.toHaveBeenCalled()
  })

  it.each(['votes', 'elections', 'calendar'])('a council enable of %s passes the switchable check', async (module) => {
    const s = setup()
    expect((await verifyCouncilRequest(await row({ args: { ...ARGS, module } }), s.ctx, s.deps)).verdict).toBe('ok')
  })

  it('board and vault stay refused by name, a module disabled in this build stays refused', async () => {
    const s = setup({}, { deps: { disabledIds: ['calendar'] } })
    expect(await verifyCouncilRequest(await row({ args: { ...ARGS, module: 'board' } }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/MODULE_DENIED|cannot be enabled/) })
    expect(await verifyCouncilRequest(await row({ args: { ...ARGS, module: 'vault' } }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused' })
    expect(await verifyCouncilRequest(await row({ args: { ...ARGS, module: 'calendar' } }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/disabled in this build/) })
  })

  it('a dpia whose reason codes are not exactly [council_decision] is refused', async () => {
    const s = setup()
    const dpia = { ...ARGS.dpia, reason_codes: ['operator_decision'] }
    expect(await verifyCouncilRequest(await row({ args: { ...ARGS, dpia } }), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/council_decision/) })
  })

  it('a context whose customerRealmForSlug returns null fails closed with "no such customer"', async () => {
    const evidence = vi.fn(verifyRequestEvidence)
    const s = setup({}, { realm: null, deps: { verifyEvidence: evidence } })
    expect(await verifyCouncilRequest(await row(), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/no such customer/) })
    expect(evidence).not.toHaveBeenCalled()
  })
})

describe('councilAdminStanding: the admin is re-read in the customer realm', () => {
  it('an enabled user holding council-admin stands', async () => {
    const { kc, calls } = kcFor()
    expect(await councilAdminStanding(kc, 'realm-a', PERSON)).toEqual({ ok: true })
    expect(calls).toEqual([`GET /admin/realms/realm-a/users/${PERSON}`, `GET /admin/realms/realm-a/users/${PERSON}/role-mappings/realm/composite`])
  })

  it('a disabled user is refused', async () => {
    const r = await councilAdminStanding(kcFor({ enabled: false }).kc, 'realm-a', PERSON)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/disabled in realm realm-a/) })
  })

  it('a user without council-admin is refused', async () => {
    const r = await councilAdminStanding(kcFor({ roles: ['member'] }).kc, 'realm-a', PERSON)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/no longer holds council-admin/) })
  })

  it('a user missing from the realm is refused (404), any other failure propagates', async () => {
    const r = await councilAdminStanding(kcFor({ missing: true }).kc, 'realm-a', PERSON)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/does not exist in realm realm-a/) })
    const boom: KcTransport = async () => {
      throw new Error('keycloak GET: 503 Service Unavailable')
    }
    await expect(councilAdminStanding(boom, 'realm-a', PERSON)).rejects.toThrow(/503/)
  })

  it('a verified request whose admin lost the role since is refused by the verdict', async () => {
    const s = setup({ roles: ['member'] })
    expect(await verifyCouncilRequest(await row(), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/no longer holds/) })
  })

  it('a disabled admin is refused by the verdict', async () => {
    const s = setup({ enabled: false })
    expect(await verifyCouncilRequest(await row(), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/disabled in realm/) })
  })

  it('a missing admin is refused by the verdict', async () => {
    const s = setup({ missing: true })
    expect(await verifyCouncilRequest(await row(), s.ctx, s.deps)).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/does not exist in realm/) })
  })
})
