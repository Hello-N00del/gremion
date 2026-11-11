// The "Vertikale und Mitglieder" section of /customers/<slug> and its three
// actions (seedVertical, importValidate, importApply) as REQUESTS. Same fake
// platform database as module-actions.test.ts: a tagged-template function that
// answers by the SQL text; nothing here opens a connection. The args every
// action submits are run through the host's own verifier (@gremion/provisioning
// verifyRequestArgs), so a field the executor would refuse fails here first.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const SHA = 'ab'.repeat(32)
const MARKER = 'GEHEIME-ZEILE-ZUM-NACHWEIS'
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
interface ImportRow {
  id: string
  state: string
  phase: string
  vertical: string
}
const IMPORT_ID = '0192f0c4-0000-7000-8000-0000000000cc'
const importRow = (over: Partial<ImportRow> = {}): ImportRow => ({ id: IMPORT_ID, state: 'succeeded', phase: 'validate', vertical: 'stura', ...over })
const SUMMARY = (sha = SHA, status = 'validated', rejected = 0) => ({
  level: 'info',
  step: 'validate',
  // what the validate verb can emit: it writes nothing, so every count but `rejected` is 0 (apply.ts validationResult)
  message: `import validate: status=${status} sha256=${sha} created=0 linked_existing=0 unchanged=0 rejected=${rejected} accounts_created=0 invites_sent=0`,
})

let rows: Row[] = []
let customer: { id: string; slug: string; status: string; host: string | null } | null = null
let newestImport: ImportRow | null = null
let eventsById: Record<string, { level: string; step: string; message: string }[]> = {}
let submits: unknown[][] = []
/** When set, the platform database read of the import state throws it. */
let importReadError: unknown = null
/** When set, the registry read of the customer throws it. */
let statusError: unknown = null
/** When set, the write of the request (submit_provisioning_request) throws it. */
let submitError: unknown = null
/** When set, the panel has no platform database configured. */
let noPlatformDb = false
const fakeSql = Object.assign(
  async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join('?')
    if (importReadError && text.includes("kind = 'import_members'")) throw importReadError
    if (text.includes('submit_provisioning_request')) {
      if (submitError) throw submitError
      submits.push(vals)
      return [{ id: '0192f0c4-0000-7000-8000-0000000000bb' }]
    }
    if (text.includes("IN ('queued'")) return rows.filter((r) => r.state === 'queued' || r.state === 'running')
    if (text.includes("kind = 'import_members'")) return newestImport ? [newestImport] : []
    if (text.includes('provisioning_request_status')) return rows
    return []
  },
  { json: (v: unknown) => v },
)
vi.mock('$lib/server/customers', async (orig) => {
  const real = await orig<typeof import('$lib/server/customers')>()
  return {
    ...real,
    platformDb: () => (noPlatformDb ? null : fakeSql),
    customerStatus: async () => {
      if (statusError) throw statusError
      return customer
    },
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
  return { ...real, loadCustomerModules: async () => ({ enabled: [], available: [] }), requestEvents: async (_sql: unknown, id: string) => eventsById[id] ?? [] }
})
vi.mock('$lib/server/auth', () => ({
  evidenceFromRequest: async () => ({ token: 'x'.repeat(120), acr: 'loa2', authTime: new Date(), sessionAt: new Date() }),
}))
/** What the registry says about the wiring of the customer: wired, not wired, or null when it cannot be read (wiring.test.ts covers the read). */
let wired: boolean | null = true
vi.mock('./wiring', async (orig) => {
  const real = await orig<typeof import('./wiring')>()
  return { ...real, servicesWired: async () => wired }
})

const { load, actions } = await import('./+page.server')
// The host's own verifier, loaded at run time from the package source: the panel image has no such
// dependency and its type check must not follow the package's .ts import specifiers.
const PKG_REQUESTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../packages/provisioning/src/requests.ts')
const { verifyRequestArgs } = (await import(/* @vite-ignore */ PKG_REQUESTS)) as {
  verifyRequestArgs: (e: { kind: string; customerSlug: string; args: unknown; operatorId: string }, ctx: { catalogueIds: string[]; disabledIds: string[] }) => { verdict: string; reason?: string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadFor = () => (load as unknown as (e: unknown) => Promise<any>)({ params: { slug: 'proof-z' } })
type Name = 'seedVertical' | 'importValidate' | 'importApply'
const csvFile = (text: string | Uint8Array) => new File([text as BlobPart], 'liste.csv', { type: 'text/csv' })
const act = (name: Name, fields: Record<string, string | File> = {}, operator: unknown = { id: OPERATOR }) => {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (actions[name] as unknown as (e: unknown) => Promise<any>)({
    params: { slug: 'proof-z' },
    request: new Request('http://127.0.0.1:3043/x', { method: 'POST', body }),
    locals: { operator },
  })
}
const cust = (status: string) => ({ id: 'c1', slug: 'proof-z', status, host: 'rat.proof.example' })
const CSV = `Name;E-Mail\n${MARKER};a@example.org\n`
const verdict = (kind: string, args: unknown) => verifyRequestArgs({ kind, customerSlug: 'proof-z', args, operatorId: OPERATOR }, { catalogueIds: [], disabledIds: [] })

beforeEach(() => {
  rows = [row()]
  customer = cust('active')
  newestImport = null
  eventsById = {}
  submits = []
  importReadError = null
  statusError = null
  submitError = null
  noPlatformDb = false
  wired = true
})

describe('the member section is shown only when an action can be queued', () => {
  it('an active customer with no open request: the verticals, actions on, nothing validated yet', async () => {
    const d = await loadFor()
    expect(d.memberSection).toMatchObject({ canAct: true, verticals: [{ id: 'stura' }], validated: null, importEvents: [] })
  })
  it.each(['queued', 'running'])('a %s request switches every action off', async (state) => {
    rows = [row({ state, kind: 'seed_vertical' })]
    expect((await loadFor()).memberSection.canAct).toBe(false)
  })
  it.each(['suspended', 'provisioning'])('a %s customer gets no actions', async (status) => {
    customer = cust(status)
    expect((await loadFor()).memberSection.canAct).toBe(false)
  })
  it('no customer: no section', async () => {
    customer = null
    expect((await loadFor()).memberSection).toBeNull()
  })
})

describe('the validated list: the sha256 comes from the validate request events', () => {
  it('a succeeded validate as the newest import request is offered for apply, with its vertical and sha256 and NO counts (the validate verb writes nothing, so its counts are always zero and would only mislead)', async () => {
    newestImport = importRow()
    eventsById[IMPORT_ID] = [{ level: 'info', step: 'claim', message: 'claimed' }, SUMMARY()]
    const d = await loadFor()
    expect(d.memberSection.validated).toEqual({ requestId: IMPORT_ID, vertical: 'stura', sha256: SHA })
  })
  it('the page asks the operator to confirm nothing it does not show: no counts, no "the numbers above", no hidden vertical field', () => {
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '+page.svelte'), 'utf8')
    expect(page).not.toMatch(/\.counts\./)
    expect(page).not.toContain('Zahlen oben')
    expect(page).not.toMatch(/name="vertical"\s+value=/)
  })
  it.each([
    ['a validate that failed', importRow({ state: 'failed' })],
    ['an apply (the list was already applied)', importRow({ phase: 'apply' })],
    ['a validate still running', importRow({ state: 'running' })],
  ])('%s offers no apply', async (_n, r) => {
    newestImport = r
    eventsById[IMPORT_ID] = [SUMMARY()]
    expect((await loadFor()).memberSection.validated).toBeNull()
  })
  it('a validate whose summary reports rejected rows offers no apply, and its events are shown', async () => {
    newestImport = importRow()
    eventsById[IMPORT_ID] = [SUMMARY(SHA, 'rejected', 2), { level: 'error', step: 'validate', message: '  row 4: duplicate_email' }]
    const d = await loadFor()
    expect(d.memberSection.validated).toBeNull()
    expect(d.memberSection.importEvents.map((e: { message: string }) => e.message)).toContain('  row 4: duplicate_email')
  })
  it('the events of an ended import request pass the address net before they are drawn', async () => {
    newestImport = importRow({ state: 'failed' })
    eventsById[IMPORT_ID] = [{ level: 'error', step: 'apply', message: 'error: lookup of x@example.org failed' }]
    const d = await loadFor()
    expect(JSON.stringify(d.memberSection.importEvents)).not.toContain('x@example.org')
    expect(JSON.stringify(d.memberSection.importEvents)).toContain('[address]')
  })
  it('a request that is still active has no events drawn (the page reloads until it ends)', async () => {
    newestImport = importRow({ state: 'running' })
    eventsById[IMPORT_ID] = [SUMMARY()]
    expect((await loadFor()).memberSection.importEvents).toEqual([])
  })
})

describe('seedVertical', () => {
  it('submits the vertical with operator and signed evidence, a fresh key, args the host verifier accepts', async () => {
    await expect(act('seedVertical', { vertical: 'stura' })).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
    const [kind, slug, args, key, operator, acr] = submits[0]!
    expect([kind, slug, operator, acr]).toEqual(['seed_vertical', 'proof-z', OPERATOR, 'loa2'])
    expect(args).toEqual({ slug: 'proof-z', vertical: 'stura' })
    expect(String(key)).toMatch(UUID)
    expect(verdict('seed_vertical', args)).toMatchObject({ verdict: 'ok' })
  })
  it.each([['no vertical', ''], ['an unknown vertical', 'nosuch'], ['an injected value', 'stura --apply'], ['a different case', 'Stura']])('%s is refused with 400 and writes no row', async (_n, vertical) => {
    const res = await act('seedVertical', { vertical })
    expect(res.status).toBe(400)
    expect(res.data.memberError).toMatch(/Vertikale/)
    expect(submits).toHaveLength(0)
  })
})

// The creation order is create, wire (gremion-services wire on the host), seed. Seeding a customer whose services are
// not wired yet leaves every unit's chat room failed until the wire retries it, so the panel says so; it does not
// forbid it (the wire repairs it afterwards), and the normal order is untouched.
describe('seedVertical for a customer whose services are not wired yet', () => {
  it('the section carries the warning, naming the order, while the actions stay on', async () => {
    wired = false
    const d = await loadFor()
    expect(d.memberSection.canAct).toBe(true)
    expect(d.memberSection.wiringWarning).toMatch(/anlegen.*verbinden.*einspielen/s)
  })
  it.each([['wired', true], ['unknown (the registry cannot be read: nothing is claimed)', null]] as const)('a customer that is %s gets no warning in the section', async (_n, state) => {
    wired = state
    expect((await loadFor()).memberSection.wiringWarning).toBeNull()
  })
  it('the seed action warns AND queues the request: the order is named, the vertical is still seeded', async () => {
    wired = false
    const res = await act('seedVertical', { vertical: 'stura' })
    expect(res.memberWarning).toMatch(/anlegen.*verbinden.*einspielen/s)
    expect(res.memberWarning).toContain('wire')
    expect(submits).toHaveLength(1)
    const [kind, slug, args] = submits[0]!
    expect([kind, slug]).toEqual(['seed_vertical', 'proof-z'])
    expect(verdict('seed_vertical', args)).toMatchObject({ verdict: 'ok' })
  })
  it('the normal order is unaffected: a wired customer is seeded with the redirect and no warning', async () => {
    wired = true
    await expect(act('seedVertical', { vertical: 'stura' })).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
  })
  it('an unreadable registry does not stop the seed or warn: it redirects as before', async () => {
    wired = null
    await expect(act('seedVertical', { vertical: 'stura' })).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
  })
  it('a refused request (a request is already open, 409) shows the refusal, not the warning, and writes nothing', async () => {
    wired = false
    rows = [row({ state: 'running', kind: 'reconcile' })]
    const res = await act('seedVertical', { vertical: 'stura' })
    expect(res.status).toBe(409)
    expect(res.data.memberWarning).toBeUndefined()
    expect(submits).toHaveLength(0)
  })
  it('the import actions are not seed actions: no warning, the redirect as before', async () => {
    wired = false
    await expect(act('importValidate', { vertical: 'stura', list: csvFile(CSV) })).rejects.toMatchObject({ status: 303 })
  })
})

describe('importValidate', () => {
  it('submits phase validate with the list as text, args the host verifier accepts', async () => {
    await expect(act('importValidate', { vertical: 'stura', list: csvFile(CSV) })).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
    const [kind, slug, args, key, operator] = submits[0]!
    expect([kind, slug, operator]).toEqual(['import_members', 'proof-z', OPERATOR])
    expect(args).toEqual({ slug: 'proof-z', phase: 'validate', vertical: 'stura', csv: CSV })
    expect(String(key)).toMatch(UUID)
    expect(verdict('import_members', args)).toMatchObject({ verdict: 'ok' })
  })
  it('a list of exactly the cap is queued', async () => {
    const csv = 'a'.repeat(1_048_576)
    await expect(act('importValidate', { vertical: 'stura', list: csvFile(csv) })).rejects.toMatchObject({ status: 303 })
    expect(verdict('import_members', submits[0]![2])).toMatchObject({ verdict: 'ok' })
  })
  it('a list one byte over the cap is refused with 413 BEFORE a row is written, naming the limit', async () => {
    const res = await act('importValidate', { vertical: 'stura', list: csvFile('a'.repeat(1_048_577)) })
    expect(res.status).toBe(413)
    expect(res.data.memberError).toMatch(/1 MiB/)
    expect(submits).toHaveLength(0)
  })
  it('a list whose JSON form would pass the payload cap is refused (every quote doubles)', async () => {
    const res = await act('importValidate', { vertical: 'stura', list: csvFile('"'.repeat(1_048_576)) })
    expect(res.status).toBe(413)
    expect(submits).toHaveLength(0)
  })
  it.each([
    ['no file at all', {}],
    ['a text field instead of a file', { list: 'a;b' }],
    ['an empty file', { list: csvFile('') }],
    ['a blank file', { list: csvFile(' \n\n ') }],
  ])('%s is refused with 400 and writes no row', async (_n, extra) => {
    const res = await act('importValidate', { vertical: 'stura', ...extra })
    expect(res.status).toBe(400)
    expect(res.data.memberError).toMatch(/CSV/)
    expect(submits).toHaveLength(0)
  })
  it('a file that is not UTF-8 text or carries a NUL is refused with 400, and the error shows none of its content', async () => {
    for (const bytes of [new Uint8Array([0xff, 0xfe, 0x41, 0x00]), new TextEncoder().encode(`${MARKER}\u0000x`)]) {
      const res = await act('importValidate', { vertical: 'stura', list: csvFile(bytes) })
      expect(res.status).toBe(400)
      expect(JSON.stringify(res)).not.toContain(MARKER)
    }
    expect(submits).toHaveLength(0)
  })
  it('a non-UTF-8 file is refused with the way to export it as UTF-8 (Excel: CSV UTF-8)', async () => {
    const res = await act('importValidate', { vertical: 'stura', list: csvFile(new Uint8Array([0xe4, 0xf6, 0xfc, 0x3b])) })
    expect(res.status).toBe(400)
    expect(res.data.memberError).toMatch(/kein UTF-8-Text/)
    expect(res.data.memberError).toMatch(/CSV UTF-8/)
    expect(submits).toHaveLength(0)
  })
  it('a semicolon list from German Excel is queued, not refused here (the parser reads it on the host)', async () => {
    await expect(act('importValidate', { vertical: 'stura', list: csvFile('﻿name;email;body;role\r\nAnna;a@x.example;Rat;member\r\n') })).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
  })
  it('an unknown vertical is refused with 400', async () => {
    expect((await act('importValidate', { vertical: 'nosuch', list: csvFile(CSV) })).status).toBe(400)
    expect(submits).toHaveLength(0)
  })
})

describe('importApply', () => {
  beforeEach(() => {
    newestImport = importRow()
    eventsById[IMPORT_ID] = [SUMMARY()]
  })
  const FORM = () => ({ vertical: 'stura', sha256: SHA, confirm: 'yes', list: csvFile(CSV) })
  it('queues phase apply with the sha256 the validate reported (read from the events, not from the form), args the host verifier accepts', async () => {
    await expect(act('importApply', FORM())).rejects.toMatchObject({ status: 303 })
    expect(submits).toHaveLength(1)
    const [kind, slug, args] = submits[0]!
    expect([kind, slug]).toEqual(['import_members', 'proof-z'])
    expect(args).toEqual({ slug: 'proof-z', phase: 'apply', vertical: 'stura', csv: CSV, expectSha256: SHA })
    expect(verdict('import_members', args)).toMatchObject({ verdict: 'ok' })
  })
  it('uses the vertical of the validate, whatever the form says', async () => {
    await expect(act('importApply', { ...FORM(), vertical: 'nosuch' })).rejects.toMatchObject({ status: 303 })
    expect((submits[0]![2] as { vertical: string }).vertical).toBe('stura')
  })
  it.each([
    ['no validate request at all', () => (newestImport = null)],
    ['a failed validate', () => (newestImport = importRow({ state: 'failed' }))],
    ['a validate that was already followed by an apply', () => (newestImport = importRow({ phase: 'apply' }))],
    ['a validate whose list did not validate', () => (eventsById[IMPORT_ID] = [SUMMARY(SHA, 'rejected', 3)])],
    ['a validate with no summary line', () => (eventsById[IMPORT_ID] = [])],
  ])('is refused with 409 and writes no row: %s', async (_n, setup) => {
    setup()
    const res = await act('importApply', FORM())
    expect(res.status).toBe(409)
    expect(res.data.memberError).toMatch(/Prüfung/)
    expect(submits).toHaveLength(0)
  })
  it('is refused with 409 when the sha256 the page showed is not the validated one any more (a newer validate)', async () => {
    const res = await act('importApply', { ...FORM(), sha256: 'cd'.repeat(32) })
    expect(res.status).toBe(409)
    expect(submits).toHaveLength(0)
  })
  it.each([['no confirmation', {}], ['a confirmation that is not "yes"', { confirm: 'on' }]])('%s is refused with 400', async (_n, over) => {
    const f: Record<string, string | File> = { ...FORM() }
    delete f.confirm
    const res = await act('importApply', { ...f, ...over })
    expect(res.status).toBe(400)
    expect(res.data.memberError).toMatch(/bestätig/)
    expect(submits).toHaveLength(0)
  })
  it('needs the list again (the host purged it): no file is 400, an oversize file 413', async () => {
    const f: Record<string, string | File> = { ...FORM() }
    delete f.list
    expect((await act('importApply', f)).status).toBe(400)
    expect((await act('importApply', { ...FORM(), list: csvFile('a'.repeat(1_048_577)) })).status).toBe(413)
    expect(submits).toHaveLength(0)
  })
})

describe.each([
  ['seedVertical', { vertical: 'stura' }],
  ['importValidate', { vertical: 'stura', list: csvFile(CSV) }],
  ['importApply', { vertical: 'stura', sha256: SHA, confirm: 'yes', list: csvFile(CSV) }],
] as const)('%s: states, 409 and 403', (name, fields) => {
  beforeEach(() => {
    newestImport = importRow()
    eventsById[IMPORT_ID] = [SUMMARY()]
  })
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

describe('a read that fails is said to fail (and logged), never turned into a false "none" answer', () => {
  const sqlFailure = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  const logged = (spy: ReturnType<typeof quiet>) => spy.mock.calls.map((c) => String(c[0])).join('\n')
  it('the page load: an unreadable import state switches the actions off and says so; the section does not look as if no validate ever ran', async () => {
    const spy = quiet()
    importReadError = sqlFailure()
    const d = await loadFor()
    expect(d.memberSection).toMatchObject({ canAct: false, unreadable: true, validated: null })
    expect(logged(spy)).toContain('ECONNREFUSED')
    spy.mockRestore()
  })
  it('the page load: no platform database is its own state (noPlatformDb), not "inactive or busy"', async () => {
    noPlatformDb = true
    const d = await loadFor()
    expect(d.memberSection).toMatchObject({ canAct: false, unreadable: false, noPlatformDb: true })
  })
  it('the page load: a readable state is not marked unreadable', async () => {
    expect((await loadFor()).memberSection.unreadable).toBe(false)
  })
  it('importApply: an unreadable import state is a 503 "nicht lesbar", not "validate first"; nothing is queued, the cause is logged', async () => {
    newestImport = importRow()
    eventsById[IMPORT_ID] = [SUMMARY()]
    const spy = quiet()
    importReadError = sqlFailure()
    const res = await act('importApply', { vertical: 'stura', sha256: SHA, confirm: 'yes', list: csvFile(CSV) })
    expect(res.status).toBe(503)
    expect(res.data.memberError).toMatch(/nicht lesbar/)
    expect(res.data.memberError).not.toMatch(/zuerst prüfen/)
    expect(submits).toHaveLength(0)
    expect(logged(spy)).toContain('ECONNREFUSED')
    expect(logged(spy)).not.toContain(MARKER)
    spy.mockRestore()
  })
  it.each([
    ['seedVertical', { vertical: 'stura' }],
    ['importValidate', { vertical: 'stura', list: csvFile(CSV) }],
    ['importApply', { vertical: 'stura', sha256: SHA, confirm: 'yes', list: csvFile(CSV) }],
  ] as const)('%s: an unreadable customer registry is a 503 "nicht lesbar", not "there is no such customer"', async (name, fields) => {
    const spy = quiet()
    statusError = sqlFailure()
    const res = await act(name, fields)
    expect(res.status).toBe(503)
    expect(res.data.memberError).toMatch(/nicht lesbar/)
    expect(res.data.memberError).not.toMatch(/keinen Mandanten/)
    expect(submits).toHaveLength(0)
    expect(logged(spy)).toContain('ECONNREFUSED')
    spy.mockRestore()
  })
  it.each([
    ['seedVertical', { vertical: 'stura' }],
    ['importValidate', { vertical: 'stura', list: csvFile(CSV) }],
  ] as const)('%s: a request that cannot be written is a 503 that points to the panel log, and the log has the cause (name and SQLSTATE only, never the message or the list)', async (name, fields) => {
    const spy = quiet()
    submitError = Object.assign(new Error(`value too long: ${MARKER}`), { code: '53100', name: 'PostgresError' })
    const res = await act(name, fields)
    expect(res.status).toBe(503)
    expect(res.data.memberError).toMatch(/Panel-Log/)
    expect(submits).toHaveLength(0)
    expect(logged(spy)).toContain('53100')
    expect(logged(spy)).toContain('PostgresError')
    expect(logged(spy)).not.toContain(MARKER)
    spy.mockRestore()
  })
  it('a refusal the operator can act on (the key was used, 409) is not logged as a failure', async () => {
    const spy = quiet()
    submitError = Object.assign(new Error('duplicate key'), { code: '23505' })
    const res = await act('seedVertical', { vertical: 'stura' })
    expect(res.status).toBe(409)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  const rawAct = (name: Name, formData: () => Promise<FormData>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (actions[name] as unknown as (e: unknown) => Promise<any>)({ params: { slug: 'proof-z' }, request: { formData }, locals: { operator: { id: OPERATOR } } })
  it.each(['seedVertical', 'importValidate', 'importApply'] as const)('%s: a body over the server limit (413 while reading the form) gets the size refusal, not "reload the page"', async (name) => {
    const res = await rawAct(name, async () => {
      throw Object.assign(new Error('Content-length exceeds limit'), { status: 413 })
    })
    expect(res.status).toBe(413)
    expect(res.data.memberError).toMatch(/1 MiB/)
    expect(submits).toHaveLength(0)
  })
  it('any other failure to read the form is a 400 "reload", logged without its message', async () => {
    const spy = quiet()
    const res = await rawAct('importValidate', async () => {
      throw new TypeError(`could not parse ${MARKER}`)
    })
    expect(res.status).toBe(400)
    expect(res.data.memberError).toMatch(/neu laden/)
    expect(spy).toHaveBeenCalled()
    expect(logged(spy)).not.toContain(MARKER)
    spy.mockRestore()
  })
})