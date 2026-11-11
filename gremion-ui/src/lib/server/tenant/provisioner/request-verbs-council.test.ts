// Karenz phase 1, Task 5, verb level (pattern of export-verbs.test.ts): what
// `request-verify` prints for a council row, that the panel and host verdicts
// are byte-identical to before, and the --actor-kind flag of the module verbs.
// The database and the JWKS fetch are faked; the verification code is real.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const held = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined, jwks: undefined as unknown, queries: 0 }))

vi.mock('postgres', () => ({
  default: () => {
    const sql = async () => {
      held.queries += 1
      return held.row ? [held.row] : []
    }
    sql.end = async () => {}
    return sql
  },
}))
vi.mock('jose', async (orig) => ({ ...(await orig<typeof import('jose')>()), createRemoteJWKSet: () => held.jwks }))
vi.mock('@gremion/tenant-store/lifecycle', async (orig) => ({ ...(await orig<typeof import('@gremion/tenant-store/lifecycle')>()), lookupModuleVersion: async () => ({ moduleVersionId: 'v1' }) }))
vi.mock('@gremion/provisioning', async (orig) => ({ ...(await orig<typeof import('@gremion/provisioning')>()), enableCustomerModule: vi.fn(), disableCustomerModule: vi.fn() }))

import { disableCustomerModule, enableCustomerModule } from '@gremion/provisioning'
import { runGateVerb, type GateVerbContext } from '../../../../../scripts/tenant-provision-gate'
import { requestVerb, type RequestVerbContext } from '../../../../../scripts/tenant-provision-requests'
import { encodeEvidence } from './request-verify'
import type { KcTransport } from './kc-admin-api'

const OPS_ISS = 'https://platform.example/auth/realms/platform'
const COUNCIL_ISS = 'https://rat.example/auth/realms/musterstadt'
const PERSON = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const CREATED = new Date('2026-10-05T12:00:00Z')
const T = Math.floor(CREATED.getTime() / 1000)

let priv: CryptoKey

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  priv = kp.privateKey
  held.jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' } as JWK] })
})

afterEach(() => {
  held.row = undefined
  held.queries = 0
  vi.restoreAllMocks()
  vi.mocked(enableCustomerModule).mockReset()
  vi.mocked(disableCustomerModule).mockReset()
})

const atHash = (t: string) => createHash('sha256').update(t, 'ascii').digest().subarray(0, 16).toString('base64url')

async function pair(iss: string, client: string, roles: string[]): Promise<string> {
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).sign(priv)
  const base = { iss, aud: client, azp: client, acr: 'loa2', sid: 's-1', iat: T - 600, exp: T - 300 }
  // gremion-ui (council): the real user id is the ACCESS token's sub, the ID token's sub is pairwise.
  // control-panel (ops realm): the ID token's sub is the operator, the access token has none.
  const council = client === 'gremion-ui'
  const access = await sign({ ...base, typ: 'Bearer', ...(council ? { sub: PERSON } : {}), realm_access: { roles } })
  const id = await sign({ ...base, typ: 'ID', sub: council ? 'pairwise-id-token-sub' : PERSON, at_hash: atHash(access) })
  return encodeEvidence({ id, access })
}

const kc: KcTransport = async (_m, path) => (path.endsWith('/composite') ? [{ name: 'operator' }, { name: 'council-admin' }] : { enabled: true })

function ctx(args: string[] = [REQUEST_ID], over: Partial<RequestVerbContext> = {}): RequestVerbContext {
  return {
    args,
    reqEnv: (n) => (n === 'PLATFORM_DOMAIN' ? 'platform.example' : 'x'),
    directPostgresUrl: (_n, v) => v,
    loadModules: () => ['calendar', 'elections', 'files', 'votes'].map((id) => ({ id, moduleJson: { runtime: { version: '1.0.0' } } })) as never,
    modulesDir: join(process.cwd(), '..', 'modules'),
    kcInternalBase: () => 'http://keycloak:8080',
    provisionerTransport: () => kc,
    customerRealmForSlug: async (s) => (s === 'musterstadt' ? { realm: 'musterstadt', host: 'rat.example' } : null),
    usage: (m) => new Error(`USAGE ${m}`),
    log: () => {},
    ...over,
  }
}

const baseRow = {
  kind: 'enable_module',
  customer_slug: 'musterstadt',
  args: { slug: 'musterstadt', module: 'votes' },
  operator_id: PERSON,
  evidence_acr: 'loa2',
  evidence_auth_time: new Date((T - 600) * 1000),
  evidence_verified_at: null,
  host_actor: null,
  reason: null,
  created_at: CREATED,
  state: 'running',
}

async function verdictOf(c: RequestVerbContext): Promise<Record<string, unknown>> {
  const out: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out.push(String(s))
    return true
  })
  await requestVerb('request-verify', c)
  expect(out).toHaveLength(1)
  expect(out[0]!.endsWith('\n')).toBe(true)
  return JSON.parse(out[0]!) as Record<string, unknown>
}

describe('request-verify: a council row', () => {
  const dpia = { requires_dpia: false, reason_codes: ['council_decision'], document_ref: 'TOM-Anhang 4.1' }

  it('delegates to verifyCouncilRequest and prints the council verdict with actorKind person', async () => {
    held.row = { ...baseRow, origin: 'council', actor_kind: 'person', args: { slug: 'musterstadt', module: 'votes', dpia }, evidence_token: await pair(COUNCIL_ISS, 'gremion-ui', ['council-admin']) }
    const v = await verdictOf(ctx())
    expect(v).toEqual({
      verdict: 'ok',
      kind: 'enable_module',
      slug: 'musterstadt',
      origin: 'council',
      operatorId: PERSON,
      evidence: `signed loa2 sign-in of ${PERSON} (iat 2026-10-05T11:50:00.000Z)`,
      args: { slug: 'musterstadt', module: 'votes', dpia: { requiresDpia: 'no', reasonCodes: ['council_decision'], documentRef: 'TOM-Anhang 4.1' }, actorKind: 'person' },
    })
  })

  it('a council pair signed for the OPS realm and the panel client does not verify a council row', async () => {
    held.row = { ...baseRow, origin: 'council', actor_kind: 'person', args: { slug: 'musterstadt', module: 'votes', dpia }, evidence_token: await pair(OPS_ISS, 'control-panel', ['operator']) }
    expect(await verdictOf(ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^evidence: /) })
  })

  it('a council disable_module verifies in the printed verdict (Karenz phase 2 lifted DISABLE_NOT_YET) with actorKind person', async () => {
    held.row = { ...baseRow, kind: 'disable_module', origin: 'council', actor_kind: 'person', evidence_token: await pair(COUNCIL_ISS, 'gremion-ui', ['council-admin']) }
    const v = await verdictOf(ctx())
    expect(v).toMatchObject({ verdict: 'ok', kind: 'disable_module', origin: 'council', args: { slug: 'musterstadt', module: 'votes', actorKind: 'person' } })
  })

  it('a request that is not running is refused for every origin', async () => {
    held.row = { ...baseRow, origin: 'council', actor_kind: 'person', state: 'queued', evidence_token: 'x' }
    expect(await verdictOf(ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/not running/) })
  })
})

describe('request-verify: panel and host rows are byte-identical to before (golden)', () => {
  it('a panel enable_module row', async () => {
    held.row = { ...baseRow, origin: 'panel', actor_kind: 'operator', evidence_token: await pair(OPS_ISS, 'control-panel', ['operator']) }
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      out.push(String(s))
      return true
    })
    await requestVerb('request-verify', ctx())
    expect(out.join('')).toBe(
      `{"verdict":"ok","kind":"enable_module","slug":"musterstadt","origin":"panel","operatorId":"${PERSON}","evidence":"signed loa2 sign-in of ${PERSON} (iat 2026-10-05T11:50:00.000Z)","args":{"slug":"musterstadt","module":"votes","dpia":null,"actorKind":"operator"}}\n`,
    )
  })

  it('a panel row with a COUNCIL token pair is still refused by the ops realm (the panel branch is not widened)', async () => {
    held.row = { ...baseRow, origin: 'panel', actor_kind: 'operator', evidence_token: await pair(COUNCIL_ISS, 'gremion-ui', ['council-admin']) }
    expect(await verdictOf(ctx())).toMatchObject({ verdict: 'refused', reason: expect.stringMatching(/^evidence: /) })
  })

  it('a host (break-glass) enable_module row', async () => {
    held.row = { ...baseRow, origin: 'host', actor_kind: 'operator', evidence_acr: null, evidence_auth_time: null, evidence_token: null, host_actor: 'ops', reason: 'recovery' }
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      out.push(String(s))
      return true
    })
    await requestVerb('request-verify', ctx())
    expect(out.join('')).toBe(
      `{"verdict":"ok","kind":"enable_module","slug":"musterstadt","origin":"host","operatorId":"${PERSON}","evidence":"break-glass by host user ops: recovery","args":{"slug":"musterstadt","module":"votes","dpia":null,"actorKind":"operator"}}\n`,
    )
  })
})

function gateCtx(positional: string[], flags: Record<string, string>, over: Partial<GateVerbContext> = {}): GateVerbContext {
  return {
    releaseTip: () => null,
    withLive: async (_o, fn) => fn({ marker: 'deps' } as never),
    openPlatform: () => {
      throw new Error('no database in this test')
    },
    customerIdForSlug: async () => null,
    flag: (n) => flags[n],
    reqFlag: (n) => {
      const v = flags[n]
      if (!v) throw new Error(`${n} is required`)
      return v
    },
    positional: (i = 0) => positional[i],
    usage: (m) => new Error(`USAGE ${m}`),
    log: () => {},
    exportDirMounted: () => true,
    ...over,
  }
}

describe('enable-module / disable-module --actor-kind', () => {
  const ENABLED = { moduleKey: 'votes', noop: false, database: 'db', enabled: true, reloaded: false }

  it('enable-module --actor-kind person calls enableCustomerModule with actorKind person and prints it', async () => {
    vi.mocked(enableCustomerModule).mockResolvedValue(ENABLED as never)
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(String(s)))
    await runGateVerb('enable-module', gateCtx(['musterstadt', 'votes'], { '--operator': PERSON, '--actor-kind': 'person' }))
    expect(enableCustomerModule).toHaveBeenCalledWith('musterstadt', 'votes', { operatorId: PERSON, actorKind: 'person' }, { marker: 'deps' })
    expect(JSON.parse(out[0]!)).toMatchObject({ verb: 'enable-module', actorKind: 'person', operatorId: PERSON })
  })

  it('enable-module defaults to operator when the flag is absent', async () => {
    vi.mocked(enableCustomerModule).mockResolvedValue(ENABLED as never)
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(String(s)))
    await runGateVerb('enable-module', gateCtx(['musterstadt', 'votes'], { '--operator': PERSON }))
    expect(enableCustomerModule).toHaveBeenCalledWith('musterstadt', 'votes', { operatorId: PERSON, actorKind: 'operator' }, { marker: 'deps' })
    expect(JSON.parse(out[0]!)).toMatchObject({ actorKind: 'operator' })
  })

  it('an unknown --actor-kind value is a usage error and nothing runs', async () => {
    for (const verb of ['enable-module', 'disable-module']) {
      await expect(runGateVerb(verb, gateCtx(['musterstadt', 'votes'], { '--operator': PERSON, '--actor-kind': 'admin' }))).rejects.toThrow(/USAGE --actor-kind must be operator or person/)
    }
    expect(enableCustomerModule).not.toHaveBeenCalled()
    expect(disableCustomerModule).not.toHaveBeenCalled()
  })

  it('disable-module --actor-kind person calls disableCustomerModule with actorKind person and prints it', async () => {
    vi.mocked(disableCustomerModule).mockResolvedValue({ moduleKey: 'votes', noop: false, dropped: true, database: 'db', export: null, enabled: false, reloaded: false } as never)
    vi.stubEnv('TENANT_EXPORT_DIR', '/exports')
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(String(s)))
    await runGateVerb('disable-module', gateCtx(['musterstadt', 'votes'], { '--operator': PERSON, '--actor-kind': 'person' }))
    expect(disableCustomerModule).toHaveBeenCalledWith('musterstadt', 'votes', { operatorId: PERSON, actorKind: 'person' }, { marker: 'deps' })
    expect(JSON.parse(out[0]!)).toMatchObject({ verb: 'disable-module', actorKind: 'person' })
    vi.unstubAllEnvs()
  })

  it('disable-module prints blocked and finalAt, and its log line says "blocked until <date>" (Karenz)', async () => {
    const finalAt = new Date('2026-12-01T10:00:00Z')
    vi.mocked(disableCustomerModule).mockResolvedValue({ moduleKey: 'votes', noop: false, dropped: false, blocked: true, finalAt, database: 'db', export: null, enabled: [], reloaded: false } as never)
    vi.stubEnv('TENANT_EXPORT_DIR', '/exports')
    const out: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(String(s)))
    const logs: string[] = []
    await runGateVerb('disable-module', { ...gateCtx(['musterstadt', 'votes'], { '--operator': PERSON }), log: (l) => void logs.push(l) })
    expect(JSON.parse(out[0]!)).toMatchObject({ verb: 'disable-module', dropped: false, blocked: true, finalAt: '2026-12-01T10:00:00.000Z' })
    expect(logs.join('\n')).toContain('blocked until 2026-12-01')
    vi.unstubAllEnvs()
  })
})

describe('the wiring at the requestVerb call site', () => {
  it('the context built in tenant-provision.ts carries customerRealmForSlug', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'tenant-provision.ts'), 'utf8')
    const call = src.split('\n').find((l) => l.includes('requestVerb(verb,'))
    expect(call, 'the requestVerb(verb, {...}) call line').toBeDefined()
    expect(call).toContain('customerRealmForSlug')
  })
})
