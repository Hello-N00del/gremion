// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the admin-only erasure API. Starting an erasure and
// reading its per-module report are IT-admin only (the same gate as
// settings/reset, the comparable destructive action: role check plus a
// server-side confirmation phrase) plus a fresh LoA 2 step-up on POST (MED-4).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  hasRole: vi.fn(),
  startErasure: vi.fn(),
  readErasureReport: vi.fn(),
  readErasureReports: vi.fn(),
  writeAuditEntry: vi.fn(),
}))

vi.mock('$lib/auth', () => ({ hasRole: h.hasRole, Role: { ITAdmin: 'it-admin' } }))
vi.mock('$lib/server/erasure/service', () => ({
  startErasure: h.startErasure,
  readErasureReport: h.readErasureReport,
  readErasureReports: h.readErasureReports,
}))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))

const RID = '0190a000-0000-7000-8000-00000000000a'
const REPORT = {
  id: RID,
  tenantId: 't-a',
  subjectRef: 'a'.repeat(64),
  requestedBy: 'admin-1',
  status: 'incomplete',
  startedAt: new Date('2026-10-27T10:00:00Z'),
  finishedAt: new Date('2026-10-27T10:00:01Z'),
  modules: [
    { moduleId: 'kernel', status: 'erased', counts: { role_assignments: 1 }, reason: null },
    { moduleId: 'calendar', status: 'skipped', counts: {}, reason: 'no database connection' },
  ],
}

const nowSec = () => Math.floor(Date.now() / 1000)

function locals(roles: string[] | null = ['it-admin'], assurance = { loa: 2, authTime: nowSec() }) {
  return { auth: async () => (roles ? { user: { id: 'admin-1', roles, ...assurance } } : null) }
}

async function post(body: unknown, l = locals()) {
  const { POST } = await import('./+server')
  const request = new Request('http://localhost/api/settings/erasure', { method: 'POST', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return POST({ request, locals: l })
}

async function list(query = '', l = locals()) {
  const { GET } = await import('./+server')
  // @ts-expect-error partial event
  return GET({ url: new URL(`http://localhost/api/settings/erasure${query}`), locals: l })
}

async function one(id: string, l = locals()) {
  const { GET } = await import('./[id]/+server')
  // @ts-expect-error partial event
  return GET({ params: { id }, locals: l })
}

beforeEach(() => {
  h.hasRole.mockReset().mockReturnValue(true)
  h.startErasure.mockReset().mockResolvedValue(REPORT)
  h.readErasureReport.mockReset().mockResolvedValue(REPORT)
  h.readErasureReports.mockReset().mockResolvedValue([REPORT])
  h.writeAuditEntry.mockReset().mockResolvedValue(undefined)
})

describe('admin-only: non-admin gets 403 and nothing runs', () => {
  it('POST', async () => {
    h.hasRole.mockReturnValue(false)
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' }, locals(['member']))
    expect(res.status).toBe(403)
    expect(h.startErasure).not.toHaveBeenCalled()
  })
  it('POST without a session', async () => {
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' }, locals(null))
    expect(res.status).toBe(403)
    expect(h.startErasure).not.toHaveBeenCalled()
  })
  it('GET list', async () => {
    h.hasRole.mockReturnValue(false)
    expect((await list('', locals(['member']))).status).toBe(403)
    expect(h.readErasureReports).not.toHaveBeenCalled()
  })
  it('GET one', async () => {
    h.hasRole.mockReturnValue(false)
    expect((await one(RID, locals(['member']))).status).toBe(403)
    expect(h.readErasureReport).not.toHaveBeenCalled()
  })
})

describe('MED-4: POST requires a FRESH LoA 2 step-up (like the vault reveal)', () => {
  it('401 STEP_UP_REQUIRED for a password-only (LoA 1) admin session; nothing runs', async () => {
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' }, locals(['it-admin'], { loa: 1, authTime: nowSec() }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('401 for a stale LoA 2 (older than the freshness window)', async () => {
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' }, locals(['it-admin'], { loa: 2, authTime: nowSec() - 3600 }))
    expect(res.status).toBe(401)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('a non-admin still gets 403 before the step-up check', async () => {
    h.hasRole.mockReturnValue(false)
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' }, locals(['member'], { loa: 1, authTime: 0 }))
    expect(res.status).toBe(403)
  })

  it('reading reports needs no step-up', async () => {
    expect((await list('', locals(['it-admin'], { loa: 1, authTime: 0 }))).status).toBe(200)
  })
})

describe('POST /api/settings/erasure', () => {
  it('422 without the server-side confirmation phrase', async () => {
    const res = await post({ subjectId: 'u1', confirm: 'nein' })
    expect(res.status).toBe(422)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('422 without a subject id', async () => {
    const res = await post({ subjectId: '  ', confirm: 'LÖSCHEN' })
    expect(res.status).toBe(422)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('runs the erasure as the requesting admin and returns the per-module report with its honest status', async () => {
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' })
    expect(res.status).toBe(200)
    expect(h.startErasure).toHaveBeenCalledWith({ subjectId: 'u1', requestedBy: 'admin-1' })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('incomplete')
    expect(body.data.modules.find((m: { moduleId: string }) => m.moduleId === 'calendar')).toMatchObject({
      status: 'skipped',
      reason: 'no database connection',
    })
  })

  it('writes an audit entry that carries the pseudonymous subject ref, never the subject id', async () => {
    await post({ subjectId: 'u1-secret', confirm: 'LÖSCHEN' })
    expect(h.writeAuditEntry).toHaveBeenCalledOnce()
    const entry = h.writeAuditEntry.mock.calls[0][0]
    expect(entry.field).toBe('erasure.run')
    expect(entry.newValue).toContain(REPORT.subjectRef)
    expect(JSON.stringify(entry)).not.toContain('u1-secret')
  })

  it('an audit-write failure does not hide the report', async () => {
    h.writeAuditEntry.mockRejectedValue(new Error('audit down'))
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' })
    expect(res.status).toBe(200)
  })

  it('500 with a generic message when the run itself throws', async () => {
    h.startErasure.mockRejectedValue(new Error('boom'))
    const res = await post({ subjectId: 'u1', confirm: 'LÖSCHEN' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})

describe('reading reports (tenant-scoped by the service)', () => {
  it('GET list returns the reports; ?subjectId narrows by the subject', async () => {
    const res = await list('?subjectId=u1')
    expect(res.status).toBe(200)
    expect(h.readErasureReports).toHaveBeenCalledWith({ subjectId: 'u1' })
    expect((await res.json()).data).toHaveLength(1)
  })

  it('GET one returns the report', async () => {
    const res = await one(RID)
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe(RID)
  })

  it('GET one is 404 when the report is not in this tenant (service returns null)', async () => {
    h.readErasureReport.mockResolvedValue(null)
    expect((await one('0190a000-0000-7000-8000-00000000000b')).status).toBe(404)
  })

  it('GET one is 404 for a malformed id without touching the service', async () => {
    const res = await one("x'; drop table")
    expect(res.status).toBe(404)
    expect(h.readErasureReport).not.toHaveBeenCalled()
  })
})
