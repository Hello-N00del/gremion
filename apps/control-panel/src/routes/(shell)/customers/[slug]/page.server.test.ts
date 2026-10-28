// /customers/<slug> for a customer that does not exist yet (H5) and the retry
// action (H6, panel half). The platform database is a fake tagged-template
// function that answers by the SQL text; nothing here opens a connection.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const OLD_KEY = '0192f0c4-0000-7000-8000-00000000000a'
const FIX = join(dirname(fileURLToPath(import.meta.url)), '../../../../lib/server/__fixtures__')
const ENV: Record<string, string> = {
  ORIGIN: 'http://127.0.0.1:3043',
  PANEL_OIDC_ISSUER: 'https://platform.example/auth/realms/platform',
  PANEL_OIDC_INTERNAL_BASE: 'https://keycloak:8443/auth',
  PANEL_OIDC_CLIENT_ID: 'control-panel',
  PANEL_OIDC_CLIENT_SECRET_FILE: join(FIX, 'client_secret'),
  AUTH_SECRET_FILE: join(FIX, 'auth_secret'),
  PANEL_REQUIRED_ACR: 'loa2',
  CONTROL_DATABASE_URL: 'postgres://control:unit@127.0.0.1:1/control',
  PLATFORM_DATABASE_URL: 'postgres://panel:unit@127.0.0.1:1/gremion_platform',
}
vi.mock('$env/dynamic/private', () => ({ env: ENV }))

interface Row {
  request_id: string
  kind: string
  state: string
  origin: 'panel' | 'host'
  reason: string | null
  host_actor: string | null
  outcome: string | null
  created_at: Date
  evidence_verified_at: Date | null
  last_step: string | null
  args: Record<string, unknown>
  idempotency_key: string
}
const row = (over: Partial<Row>): Row => ({
  request_id: '0192f0c4-0000-7000-8000-0000000000aa',
  kind: 'create',
  state: 'queued',
  origin: 'panel',
  reason: null,
  host_actor: null,
  outcome: null,
  created_at: new Date('2026-10-27T10:00:00Z'),
  evidence_verified_at: null,
  last_step: null,
  args: { slug: 'proof-z', host: 'rat.proof.example' },
  idempotency_key: OLD_KEY,
  ...over,
})

let rows: Row[] = []
let submits: unknown[][] = []
const fakeSql = Object.assign(
  async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('submit_provisioning_request')) {
      submits.push(vals)
      return [{ id: '0192f0c4-0000-7000-8000-0000000000bb' }]
    }
    if (text.includes("IN ('queued'")) return rows.filter((r) => r.state === 'queued' || r.state === 'running')
    if (text.includes('provisioning_request_status')) return rows
    return []
  },
  { json: (v: unknown) => v },
)
vi.mock('$lib/server/customers', async (orig) => {
  const real = await orig<typeof import('$lib/server/customers')>()
  return {
    ...real,
    platformDb: () => fakeSql,
    customerStatus: async () => null,
    customerRequests: async () =>
      rows.map((r) => ({
        id: r.request_id,
        kind: r.kind,
        state: r.state,
        origin: r.origin,
        reason: r.reason,
        hostActor: r.host_actor,
        outcome: r.outcome,
        createdAt: r.created_at.toISOString(),
        evidenceVerifiedAt: r.evidence_verified_at?.toISOString() ?? null,
        lastStep: r.last_step,
      })),
  }
})
vi.mock('$lib/server/auth', () => ({
  evidenceFromRequest: async () => ({ token: 'x'.repeat(120), acr: 'loa2', authTime: new Date(), sessionAt: new Date() }),
}))

const { load, actions } = await import('./+page.server')
const { EXECUTOR_STEP_LABEL } = await import('$lib/request-state')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadFor = (slug = 'proof-z') => (load as unknown as (e: unknown) => Promise<any>)({ params: { slug } })
const retry = (slug = 'proof-z', operator: unknown = { id: OPERATOR }) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (actions.retry as unknown as (e: unknown) => Promise<any>)({ params: { slug }, request: new Request('http://127.0.0.1:3043/x', { method: 'POST' }), locals: { operator } })

beforeEach(() => {
  rows = []
  submits = []
})

describe('H5: a customer that does not exist yet shows the request state', () => {
  it('queued', async () => {
    rows = [row({ state: 'queued' })]
    const d = await loadFor()
    expect(d.status).toBeNull()
    expect(d.latest).toMatchObject({ phase: 'queued', active: true, retryable: false })
  })
  it('verifying (running, evidence not yet verified)', async () => {
    rows = [row({ state: 'running' })]
    expect((await loadFor()).latest).toMatchObject({ phase: 'verifying', active: true })
  })
  it('running with the current step', async () => {
    rows = [row({ state: 'running', evidence_verified_at: new Date(), last_step: 'phase-a' })]
    const d = (await loadFor()).latest
    expect(d).toMatchObject({ phase: 'running', step: 'phase-a' })
    expect(d.text).toContain(EXECUTOR_STEP_LABEL['phase-a'])
  })
  it('failed with reason code and German text', async () => {
    rows = [row({ state: 'failed', outcome: 'create proof-z: failed in phase-a (exit 3); a new request resumes from the ledger' })]
    const d = (await loadFor()).latest
    expect(d).toMatchObject({ phase: 'failed', code: 'step_failed:phase-a', retryable: true })
    expect(d.text).toContain(EXECUTOR_STEP_LABEL['phase-a'])
  })
  it('refused with the verify reason', async () => {
    rows = [row({ state: 'refused', outcome: 'refused: module vault is disabled in this build (modules/disabled.json)' })]
    const d = (await loadFor()).latest
    expect(d).toMatchObject({ phase: 'refused', retryable: false })
    expect(d.detail).toContain('module vault is disabled')
  })
  it('no request and no customer: latest is null (the page says "Noch nicht registriert")', async () => {
    expect((await loadFor()).latest).toBeNull()
  })
  it('only the NEWEST request decides (rows arrive newest first)', async () => {
    rows = [row({ state: 'queued', request_id: 'b' }), row({ state: 'failed', request_id: 'a' })]
    expect((await loadFor()).latest).toMatchObject({ phase: 'queued' })
  })
})

describe('LOW-9a: the page stops refreshing when the newest request is terminal', () => {
  it('refresh is on for an active request and off for a terminal one', async () => {
    rows = [row({ state: 'running', evidence_verified_at: new Date() })]
    expect((await loadFor()).refresh).toBe(true)
    for (const state of ['failed', 'refused', 'dead', 'expired', 'succeeded']) {
      rows = [row({ state })]
      expect((await loadFor()).refresh).toBe(false)
    }
  })
})

describe('H6 panel: retry is a NEW request with a NEW idempotency key', () => {
  it.each([
    ['failed', null],
    ['refused', 'refused: evidence: the ID token has acr loa1, loa2 is required'],
    ['expired', null],
    ['dead', null],
  ])('after %s it submits the same kind/args with a fresh key', async (state, outcome) => {
    rows = [row({ state, outcome })]
    await expect(retry()).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
    const [kind, slug, args, key, operator] = submits[0]!
    expect([kind, slug, args, operator]).toEqual(['create', 'proof-z', rows[0]!.args, OPERATOR])
    expect(String(key)).toMatch(UUID)
    expect(key).not.toBe(OLD_KEY)
  })
  it('two retries use two different keys', async () => {
    rows = [row({ state: 'failed' })]
    await retry().catch(() => {})
    await retry().catch(() => {})
    expect(submits[0]![3]).not.toBe(submits[1]![3])
  })
  it.each(['queued', 'running', 'succeeded'])('is refused (no request row) when the last request is %s', async (state) => {
    rows = [row({ state })]
    const res = await retry()
    expect(res.status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('is refused for a refused request whose refusal is not about the sign-in (args/modules/operator)', async () => {
    rows = [row({ state: 'refused', outcome: 'refused: module vault is disabled in this build (modules/disabled.json)' })]
    expect((await retry()).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it.each(['suspend', 'resume', 'reconcile'])('is refused for a failed %s request (only create is replayed)', async (kind) => {
    rows = [row({ state: 'failed', kind })]
    expect((await retry()).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('is refused when another request of the customer is queued or running (double submit)', async () => {
    rows = [row({ state: 'queued', request_id: 'b' }), row({ state: 'failed', request_id: 'a' })]
    expect((await retry()).status).toBe(409)
    rows = [row({ state: 'failed', request_id: 'b' }), row({ state: 'running', request_id: 'a' })]
    expect((await retry()).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('is refused when there is no request at all', async () => {
    expect((await retry()).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('needs a signed-in operator', async () => {
    rows = [row({ state: 'failed' })]
    await expect(retry('proof-z', null)).rejects.toMatchObject({ status: 403 })
    expect(submits).toHaveLength(0)
  })
})
