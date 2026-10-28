// TRD-044 remainder: the "Module" section of /customers/<slug> and its four
// actions (enable_module, disable_module, record_dpia, reconcile) as REQUESTS.
// Same fake platform database as page.server.test.ts: a tagged-template
// function that answers by the SQL text; nothing here opens a connection.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
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
  outcome: string | null
  evidence_verified_at: Date | null
}
const row = (over: Partial<Row> = {}): Row => ({
  request_id: '0192f0c4-0000-7000-8000-0000000000aa',
  kind: 'create',
  state: 'succeeded',
  outcome: null,
  evidence_verified_at: new Date('2026-10-27T10:00:30Z'),
  ...over,
})

let rows: Row[] = []
let customer: { id: string; slug: string; status: string; host: string | null } | null = null
let modules: { enabled: { id: string; name: string }[]; available: { id: string; name: string; denied: string | null }[] } = { enabled: [], available: [] }
let events: { level: string; step: string; message: string }[] = []
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
    customerStatus: async () => customer,
    customerRequests: async () =>
      rows.map((r) => ({
        id: r.request_id,
        kind: r.kind,
        state: r.state,
        origin: 'panel' as const,
        reason: null,
        hostActor: null,
        outcome: r.outcome,
        createdAt: '2026-10-27T10:00:00.000Z',
        evidenceVerifiedAt: r.evidence_verified_at?.toISOString() ?? null,
        lastStep: null,
      })),
  }
})
vi.mock('$lib/server/modules', async (orig) => {
  const real = await orig<typeof import('$lib/server/modules')>()
  return { ...real, loadCustomerModules: async () => modules, requestEvents: async () => events }
})
vi.mock('$lib/server/auth', () => ({
  evidenceFromRequest: async () => ({ token: 'x'.repeat(120), acr: 'loa2', authTime: new Date(), sessionAt: new Date() }),
}))

const { load, actions } = await import('./+page.server')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadFor = () => (load as unknown as (e: unknown) => Promise<any>)({ params: { slug: 'proof-z' } })
type Name = 'enable_module' | 'disable_module' | 'record_dpia' | 'reconcile'
const act = (name: Name, fields: Record<string, string> = {}, operator: unknown = { id: OPERATOR }) => {
  const body = new URLSearchParams(fields)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (actions[name] as unknown as (e: unknown) => Promise<any>)({
    params: { slug: 'proof-z' },
    request: new Request('http://127.0.0.1:3043/x', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    locals: { operator },
  })
}
const cust = (status: string) => ({ id: 'c1', slug: 'proof-z', status, host: 'rat.proof.example' })

beforeEach(() => {
  rows = [row()]
  customer = cust('active')
  modules = {
    enabled: [{ id: 'calendar', name: 'Kalender' }],
    available: [
      { id: 'votes', name: 'Abstimmungen', denied: null },
      { id: 'board', name: 'Board', denied: 'board ist noch nicht mandantengetrennt und kann nicht aktiviert werden (R29-I1).' },
    ],
  }
  events = []
  submits = []
})

const ENABLE = { module: 'votes', dpia: 'no', dpiaRef: 'TOM-3' }

describe('the Module section is shown only when an action can be queued', () => {
  it('an active customer with no open request: the enabled and the available modules, actions on', async () => {
    const d = await loadFor()
    expect(d.moduleSection).toMatchObject({ canAct: true, enabled: [{ id: 'calendar' }], available: [{ id: 'votes' }, { id: 'board', denied: expect.stringMatching(/mandantengetrennt/) }] })
  })
  it.each(['queued', 'running'])('a %s request switches every action off', async (state) => {
    rows = [row({ state, kind: 'enable_module' })]
    expect((await loadFor()).moduleSection.canAct).toBe(false)
  })
  it.each(['suspended', 'provisioning'])('a %s customer gets no actions', async (status) => {
    customer = cust(status)
    expect((await loadFor()).moduleSection.canAct).toBe(false)
  })
  it('no customer: no section', async () => {
    customer = null
    expect((await loadFor()).moduleSection).toBeNull()
  })
  it('the events of the newest reconcile request are surfaced (the dry-run report)', async () => {
    rows = [row({ kind: 'reconcile', state: 'failed', outcome: 'reconcile proof-z: failed in reconcile (exit 1); a new request resumes from the ledger' })]
    events = [{ level: 'error', step: 'reconcile', message: 'FAIL smtp-server: repair: host' }]
    const d = await loadFor()
    expect(d.reconcileEvents).toEqual([{ level: 'error', step: 'reconcile', message: 'FAIL smtp-server: repair: host' }])
  })
  it('no events are read for another kind of request', async () => {
    events = [{ level: 'info', step: 'x', message: 'y' }]
    expect((await loadFor()).reconcileEvents).toEqual([])
  })
})

describe('enable_module', () => {
  it('submits the module with the explicit DPIA decision and the document reference, operator and signed evidence, fresh key', async () => {
    await expect(act('enable_module', ENABLE)).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
    const [kind, slug, args, key, operator, acr] = submits[0]!
    expect([kind, slug, operator, acr]).toEqual(['enable_module', 'proof-z', OPERATOR, 'loa2'])
    expect(args).toEqual({ slug: 'proof-z', module: 'votes', dpia: { requires_dpia: false, reason_codes: ['operator_decision'], document_ref: 'TOM-3' } })
    expect(String(key)).toMatch(UUID)
  })
  it('"erforderlich" is requires_dpia true', async () => {
    await expect(act('enable_module', { ...ENABLE, dpia: 'yes' })).rejects.toMatchObject({ status: 303 })
    expect((submits[0]![2] as { dpia: { requires_dpia: boolean } }).dpia.requires_dpia).toBe(true)
  })
  it.each([
    ['no answer', { ...ENABLE, dpia: '' }, /DPIA-Entscheidung/],
    ['an unknown answer', { ...ENABLE, dpia: 'maybe' }, /DPIA-Entscheidung/],
    ['no document reference', { ...ENABLE, dpiaRef: '  ' }, /Dokumentverweis/],
    ['an over-long reference', { ...ENABLE, dpiaRef: 'x'.repeat(501) }, /höchstens 500/],
    ['a control character in the reference', { ...ENABLE, dpiaRef: 'a\u0007b' }, /Steuerzeichen/],
  ])('%s is refused with 400 and writes no row', async (_n, fields, msg) => {
    const res = await act('enable_module', fields)
    expect(res.status).toBe(400)
    expect(res.data.moduleError).toMatch(msg)
    expect(submits).toHaveLength(0)
  })
  it.each([
    ['an already enabled module', 'calendar'],
    ['a denied module', 'board'],
    ['an unknown module', 'nosuch'],
    ['no module', ''],
  ])('%s is refused with 409', async (_n, module) => {
    expect((await act('enable_module', { ...ENABLE, module })).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
})

describe('disable_module', () => {
  it('submits the module only', async () => {
    await expect(act('disable_module', { module: 'calendar' })).rejects.toMatchObject({ status: 303 })
    expect(submits[0]!.slice(0, 3)).toEqual(['disable_module', 'proof-z', { slug: 'proof-z', module: 'calendar' }])
  })
  it('a module that is not enabled is refused with 409', async () => {
    expect((await act('disable_module', { module: 'votes' })).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
})

describe('record_dpia', () => {
  it('submits the decision for an enabled module', async () => {
    await expect(act('record_dpia', { module: 'calendar', dpia: 'yes', dpiaRef: 'DSFA-7' })).rejects.toMatchObject({ status: 303 })
    expect(submits[0]!.slice(0, 3)).toEqual(['record_dpia', 'proof-z', { slug: 'proof-z', module: 'calendar', requiresDpia: true, documentRef: 'DSFA-7' }])
  })
  it('needs an explicit answer and a reference (400), and an enabled module (409)', async () => {
    expect((await act('record_dpia', { module: 'calendar', dpia: '', dpiaRef: 'DSFA-7' })).status).toBe(400)
    expect((await act('record_dpia', { module: 'calendar', dpia: 'no', dpiaRef: '' })).status).toBe(400)
    expect((await act('record_dpia', { module: 'votes', dpia: 'no', dpiaRef: 'DSFA-7' })).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
})

describe('reconcile', () => {
  it('"Prüfen" is a dry run, "Abgleich anwenden" an apply', async () => {
    await expect(act('reconcile', { apply: 'false' })).rejects.toMatchObject({ status: 303 })
    await expect(act('reconcile', { apply: 'true' })).rejects.toMatchObject({ status: 303 })
    expect(submits.map((s) => s.slice(0, 3))).toEqual([
      ['reconcile', 'proof-z', { slug: 'proof-z', apply: false }],
      ['reconcile', 'proof-z', { slug: 'proof-z', apply: true }],
    ])
  })
  it('anything but true is a dry run (never an apply by accident)', async () => {
    await expect(act('reconcile', {})).rejects.toMatchObject({ status: 303 })
    expect((submits[0]![2] as { apply: boolean }).apply).toBe(false)
  })
})

describe.each([
  ['enable_module', ENABLE],
  ['disable_module', { module: 'calendar' }],
  ['record_dpia', { module: 'calendar', dpia: 'no', dpiaRef: 'X-1' }],
  ['reconcile', { apply: 'false' }],
] as const)('%s: states, 409 and 403', (name, fields) => {
  it.each(['queued', 'running'])('is refused with 409 while another request is %s (double submit)', async (state) => {
    rows = [row({ state })]
    expect((await act(name, fields)).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it.each(['suspended', 'provisioning'])('is refused with 409 for a %s customer', async (status) => {
    customer = cust(status)
    expect((await act(name, fields)).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('is refused with 409 for a customer that does not exist', async () => {
    customer = null
    expect((await act(name, fields)).status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it('needs a signed-in operator (403)', async () => {
    await expect(act(name, fields, null)).rejects.toMatchObject({ status: 403 })
    expect(submits).toHaveLength(0)
  })
})
