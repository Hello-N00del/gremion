// @vitest-environment node
//
// Module Karenz (phase 2, Task 11): GET /api/settings/modules/retained?id=<retained id>. The sealed copy
// is served as an NDJSON attachment to the roles that may read retained records, redacted against the
// erasure reports, and every read is audited before a byte leaves (accountable access).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import { sealLines } from '$lib/server/module-karenz/retained/crypto'
import { fakeTenantDb } from '$lib/server/module-karenz/retained/fake-db.test-util'
import type { RetainedLine } from '$lib/server/module-karenz/retained/extractors'

const SECRET = 'unit-test-secret-one'
const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const USER = '0192f0c4-0000-7000-8000-000000000001'

const h = vi.hoisted(() => ({
  audit: [] as { userId: string; field: string; oldValue: string | null; newValue: string }[],
  auditFails: false,
  auditError: null as Error | null,
  erased: [] as { tenant_id: string; subject_ref: string }[],
}))

vi.mock('$lib/server/audit-db', () => ({
  writeAuditEntry: async (e: { userId: string; field: string; oldValue: string | null; newValue: string }) => {
    if (h.auditFails) throw h.auditError ?? new Error('audit_log unavailable')
    h.audit.push(e)
  },
}))

const LINES: RetainedLine[] = [
  { id: 'p1', data: { title: 'Haushalt', createdBy: 'Erika Beispiel' }, persons: [{ id: 'user-a', field: 'createdBy' }] },
  { id: 'p2', data: { title: 'zwei' }, persons: [] },
]

/** A tenant database: the Task 10 stand-in, plus the erasure_report lookup of the redaction. */
function tenantWorld(tenantId: string) {
  const t = fakeTenantDb()
  const base = t.db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>
  const db = Object.assign(
    async (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join('?')
      if (/FROM erasure_report/.test(text)) return h.erased.filter((r) => r.tenant_id === v[0]).map((r) => ({ subject_ref: r.subject_ref }))
      // the list of Task 19 (serve.ts listRetained): every copy of the tenant, newest first, without ciphertext
      if (/FROM retained_record/.test(text) && /ORDER BY/.test(text) && !/WHERE/.test(text)) {
        return t.records().map((r, i) => ({ id: r.id, catalogue_id: r.catalogue_id, retention_class: r.retention_class, line_count: r.line_count, created_at: new Date(Date.UTC(2026, 9, 1 + i, 10)) }))
      }
      return base(s, ...v)
    },
    { unsafe: (t.db as unknown as { unsafe: unknown }).unsafe, begin: (t.db as unknown as { begin: unknown }).begin },
  )
  return { t, tenant: { id: tenantId, slug: tenantId === TENANT_A ? 'rat-a' : 'rat-b', db } }
}

function event(roles: string[] | null, tenant: unknown, query: string) {
  return {
    locals: { auth: async () => (roles ? { user: { id: USER, roles } } : null), tenant },
    url: new URL(`http://localhost/api/settings/modules/retained${query}`),
  } as never
}

let a: ReturnType<typeof tenantWorld>
let b: ReturnType<typeof tenantWorld>
let recordId: string

beforeEach(async () => {
  vi.stubEnv('AUTH_SECRET', SECRET)
  h.audit.length = 0
  h.auditFails = false
  h.auditError = null
  h.erased.length = 0
  a = tenantWorld(TENANT_A)
  b = tenantWorld(TENANT_B)
  const sealed = await sealLines(a.tenant.db as never, TENANT_A, KARENZ, 'votes.polls', LINES, { catalogueId: 'votes', retentionClass: 'RC-TEST' }, { secret: SECRET, guard: async () => {} })
  recordId = sealed.id
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/settings/modules/retained', () => {
  it('answers 401 without a session and 403 for Member and Guest, before the database is asked', async () => {
    const { GET } = await import('./+server')
    expect((await GET(event(null, a.tenant, `?id=${recordId}`))).status).toBe(401)
    for (const role of ['member', 'guest']) {
      const res = await GET(event([role], a.tenant, `?id=${recordId}`))
      expect(res.status).toBe(403)
    }
    expect(h.audit).toHaveLength(0)
    expect(a.t.statements.filter((s) => /FROM retained_record/.test(s))).toHaveLength(0)
  })

  it.each(['vorstand', 'council-admin', 'finance', 'auditor', 'it-admin'])('%s gets 200', async (role) => {
    const { GET } = await import('./+server')
    const res = await GET(event([role], a.tenant, `?id=${recordId}`))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
    expect(text).toContain('Haushalt')
  })

  it('the response is an NDJSON attachment with no-store', async () => {
    const { GET } = await import('./+server')
    const res = await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9._-]+\.ndjson"$/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('writes an audit entry per download, naming the reader and the record, never the content', async () => {
    const { GET } = await import('./+server')
    await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))
    await GET(event(['finance'], a.tenant, `?id=${recordId}`))
    expect(h.audit).toHaveLength(2)
    expect(h.audit[0]).toMatchObject({ userId: USER, field: 'module.retained.read', oldValue: null, newValue: recordId })
    expect(JSON.stringify(h.audit)).not.toContain('Haushalt')
  })

  it('if the audit write fails the response is 503 and carries no body', async () => {
    h.auditFails = true
    const { GET } = await import('./+server')
    const res = await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain('Haushalt')
    expect(text).not.toContain('Erika')
    expect(res.headers.get('content-type') ?? '').not.toMatch(/ndjson/)
  })

  it('the failure log names the tenant, the record and the failure class with its SQLSTATE, and never a message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.auditFails = true
      h.auditError = Object.assign(new Error('connection to db.internal.example refused for Erika Beispiel'), { code: '57P01' })
      const { GET } = await import('./+server')
      await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))
      const logged = log.mock.calls.flat().join(' ')
      expect(logged).toContain('rat-a')
      expect(logged).toContain(recordId)
      expect(logged).toContain('57P01')
      expect(logged).not.toContain('Erika')
      expect(logged).not.toContain('db.internal')
    } finally {
      log.mockRestore()
    }
  })

  it('serves a person erased after sealing redacted', async () => {
    h.erased.push({ tenant_id: TENANT_A, subject_ref: subjectRef(TENANT_A, 'user-a', SECRET) })
    const { GET } = await import('./+server')
    const text = await (await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))).text()
    expect(text).not.toContain('Erika Beispiel')
    expect(text).toContain('"createdBy":"erased"')
  })

  it("an id of another tenant answers 404 (the query is scoped to the request tenant's database)", async () => {
    const { GET } = await import('./+server')
    const res = await GET(event(['vorstand'], b.tenant, `?id=${recordId}`))
    expect(res.status).toBe(404)
    expect(h.audit).toHaveLength(0)
  })

  it('an unknown or malformed id answers 404, a missing id 400', async () => {
    const { GET } = await import('./+server')
    expect((await GET(event(['vorstand'], a.tenant, '?id=55555555-5555-4555-8555-555555555555'))).status).toBe(404)
    expect((await GET(event(['vorstand'], a.tenant, '?id=not-a-uuid'))).status).toBe(404)
    expect((await GET(event(['vorstand'], a.tenant, ''))).status).toBe(400)
  })

  it('a copy that does not verify answers 500 without content and writes no audit entry', async () => {
    a.t.records()[0]!.ciphertext[0] ^= 0xff
    const { GET } = await import('./+server')
    const res = await GET(event(['vorstand'], a.tenant, `?id=${recordId}`))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('Haushalt')
    expect(h.audit).toHaveLength(0)
  })
})

// Module Karenz (phase 2, Task 19): the list mode. A module that is switched on afresh after day 30
// shows the sealed copies of the previous period, read-only.
describe('GET /api/settings/modules/retained?module=<catalogueId> (the list)', () => {
  const KARENZ_OLD = '44444444-4444-4444-8444-444444444440'
  let electionsId: string

  beforeEach(async () => {
    const sealed = await sealLines(a.tenant.db as never, TENANT_A, KARENZ_OLD, 'elections.election-results', [{ id: 'e1', data: { name: 'Vorstandswahl', result: { yes: 3 } }, persons: [] }], { catalogueId: 'elections', retentionClass: 'RC-ELE' }, { secret: SECRET, guard: async () => {} })
    electionsId = sealed.id
    await sealLines(b.tenant.db as never, TENANT_B, KARENZ_OLD, 'votes.poll-results', [{ id: 'x1', data: { title: 'fremd' }, persons: [] }], { catalogueId: 'votes', retentionClass: 'RC-GOV-RES' }, { secret: SECRET, guard: async () => {} })
  })

  it('answers 401 without a session and 403 for Member and Guest, before the database is asked', async () => {
    const { GET } = await import('./+server')
    expect((await GET(event(null, a.tenant, '?module=elections'))).status).toBe(401)
    for (const role of ['member', 'guest']) expect((await GET(event([role], a.tenant, '?module=elections'))).status).toBe(403)
    expect(a.t.statements.filter((s) => /FROM retained_record/.test(s))).toHaveLength(0)
  })

  it.each(['vorstand', 'council-admin', 'finance', 'auditor', 'it-admin'])('%s gets the list of that module only', async (role) => {
    const { GET } = await import('./+server')
    const res = await GET(event([role], a.tenant, '?module=elections'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: unknown[] }
    expect(body.success).toBe(true)
    expect(body.data).toEqual([{ id: electionsId, label: 'Wahlergebnisse', createdAt: expect.stringMatching(/^2026-10-\d\dT10:00:00\.000Z$/), lineCount: 1, href: `/api/settings/modules/retained?id=${electionsId}` }])
  })

  it("lists only the request tenant's own copies", async () => {
    const { GET } = await import('./+server')
    const body = (await (await GET(event(['vorstand'], a.tenant, '?module=votes'))).json()) as { data: { id: string }[] }
    expect(body.data.map((r) => r.id)).toEqual([recordId])
    const other = (await (await GET(event(['vorstand'], b.tenant, '?module=votes'))).json()) as { data: { id: string }[] }
    expect(other.data).toHaveLength(1)
    expect(other.data[0]!.id).not.toBe(recordId)
  })

  it('a module without copies answers an empty list', async () => {
    const { GET } = await import('./+server')
    const body = await (await GET(event(['vorstand'], a.tenant, '?module=finance'))).json()
    expect(body).toEqual({ success: true, data: [] })
  })

  it('a malformed module answers 400 and asks nothing', async () => {
    const { GET } = await import('./+server')
    for (const bad of ['?module=', '?module=Elections', '?module=a%20b', '?module=..%2Fx', `?module=${'a'.repeat(80)}`]) {
      expect((await GET(event(['vorstand'], a.tenant, bad))).status, bad).toBe(400)
    }
    expect(a.t.statements.filter((s) => /FROM retained_record/.test(s))).toHaveLength(0)
  })

  it('the list carries no record content, no ciphertext and no person', async () => {
    const { GET } = await import('./+server')
    const text = await (await GET(event(['vorstand'], a.tenant, '?module=votes'))).text()
    for (const forbidden of ['Haushalt', 'Erika', 'ciphertext', 'nonce', 'plaintext', 'subject']) expect(text).not.toContain(forbidden)
  })

  it('a read failure answers 500 with a short error and no detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const broken = { ...a.tenant, db: Object.assign(async () => { throw new Error('connection to db.internal.example refused') }, {}) }
      const { GET } = await import('./+server')
      const res = await GET(event(['vorstand'], broken, '?module=votes'))
      expect(res.status).toBe(500)
      expect(await res.text()).not.toContain('db.internal')
      expect(log.mock.calls.flat().join(' ')).not.toContain('db.internal')
    } finally {
      log.mockRestore()
    }
  })

  it('a person erased after sealing is redacted in the download behind the list link', async () => {
    h.erased.push({ tenant_id: TENANT_A, subject_ref: subjectRef(TENANT_A, 'user-a', SECRET) })
    const { GET } = await import('./+server')
    const listed = (await (await GET(event(['vorstand'], a.tenant, '?module=votes'))).json()) as { data: { href: string }[] }
    const href = new URL(listed.data[0]!.href, 'http://localhost')
    const res = await GET(event(['vorstand'], a.tenant, href.search))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('Erika Beispiel')
    expect(text).toContain('"createdBy":"erased"')
  })
})

describe('retained records have no mutating route', () => {
  const ROUTES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..') // src/routes

  /** Every +server.ts under src/routes whose path mentions retained records. */
  function retainedRouteFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) retainedRouteFiles(full, out)
      else if (name === '+server.ts' && /retained/i.test(relative(ROUTES, full))) out.push(full)
    }
    return out
  }

  it('the route table has exactly one retained route and it exports GET only', async () => {
    const files = retainedRouteFiles(ROUTES)
    expect(files.map((f) => relative(ROUTES, f).replaceAll('\\', '/'))).toEqual(['api/settings/modules/retained/+server.ts'])
    const mod = (await import('./+server')) as Record<string, unknown>
    const verbs = Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|fallback)$/.test(k))
    expect(verbs).toEqual(['GET'])
  })

  it('no page or layout loader in the route table writes, edits or deletes a retained copy', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/^\+(page|layout)\.server\.ts$/.test(name) && /(DELETE FROM|UPDATE|INSERT INTO)\s+retained_record|insertRetainedRecord|rewrapDataKey/.test(readFileSync(full, 'utf8'))) offenders.push(relative(ROUTES, full))
      }
    }
    walk(ROUTES)
    expect(offenders).toEqual([])
  })
})
