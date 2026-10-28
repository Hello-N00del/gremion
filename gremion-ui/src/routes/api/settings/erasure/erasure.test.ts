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

const SUBJ = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7caa'
const SUBJ_SECRET = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
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

import { ErasureSubjectUnknownError } from '$lib/server/erasure/subject'

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

async function search(body: unknown, l = locals()) {
  const { POST } = await import('./search/+server')
  const request = new Request('http://localhost/api/settings/erasure/search', { method: 'POST', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return POST({ request, locals: l })
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
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' }, locals(['member']))
    expect(res.status).toBe(403)
    expect(h.startErasure).not.toHaveBeenCalled()
  })
  it('POST without a session', async () => {
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' }, locals(null))
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
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' }, locals(['it-admin'], { loa: 1, authTime: nowSec() }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'STEP_UP_REQUIRED', requiredLoa: 2 })
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('401 for a stale LoA 2 (older than the freshness window)', async () => {
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' }, locals(['it-admin'], { loa: 2, authTime: nowSec() - 3600 }))
    expect(res.status).toBe(401)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('a non-admin still gets 403 before the step-up check', async () => {
    h.hasRole.mockReturnValue(false)
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' }, locals(['member'], { loa: 1, authTime: 0 }))
    expect(res.status).toBe(403)
  })

  it('reading reports needs no step-up', async () => {
    expect((await list('', locals(['it-admin'], { loa: 1, authTime: 0 }))).status).toBe(200)
  })
})

describe('POST /api/settings/erasure', () => {
  it('422 without the server-side confirmation phrase', async () => {
    const res = await post({ subjectId: SUBJ, confirm: 'nein' })
    expect(res.status).toBe(422)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('422 without a subject id', async () => {
    const res = await post({ subjectId: '  ', confirm: 'LÖSCHEN' })
    expect(res.status).toBe(422)
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('422 for an id that is not a Keycloak user id (UUID); nothing runs', async () => {
    for (const bad of ['u1', '../../etc', 'a'.repeat(300), `${SUBJ}/..`, '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7caa%2F']) {
      expect((await post({ subjectId: bad, confirm: 'LÖSCHEN' })).status).toBe(422)
    }
    expect(h.startErasure).not.toHaveBeenCalled()
  })

  it('404 with a generic message for an id the tenant does not know (R33f HIGH); no audit entry', async () => {
    h.startErasure.mockRejectedValue(new ErasureSubjectUnknownError())
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' })
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).not.toContain(SUBJ)
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('runs the erasure as the requesting admin and returns the per-module report with its honest status', async () => {
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' })
    expect(res.status).toBe(200)
    expect(h.startErasure).toHaveBeenCalledWith({ subjectId: SUBJ, requestedBy: 'admin-1' })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('incomplete')
    expect(body.data.modules.find((m: { moduleId: string }) => m.moduleId === 'calendar')).toMatchObject({
      status: 'skipped',
      reason: 'no database connection',
    })
  })

  it('writes an audit entry that carries the pseudonymous subject ref, never the subject id', async () => {
    await post({ subjectId: SUBJ_SECRET, confirm: 'LÖSCHEN' })
    expect(h.writeAuditEntry).toHaveBeenCalledOnce()
    const entry = h.writeAuditEntry.mock.calls[0][0]
    expect(entry.field).toBe('erasure.run')
    expect(entry.newValue).toContain(REPORT.subjectRef)
    expect(JSON.stringify(entry)).not.toContain(SUBJ_SECRET)
  })

  it('an audit-write failure does not hide the report', async () => {
    h.writeAuditEntry.mockRejectedValue(new Error('audit down'))
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' })
    expect(res.status).toBe(200)
  })

  it('500 with a generic message when the run itself throws', async () => {
    h.startErasure.mockRejectedValue(new Error('boom'))
    const res = await post({ subjectId: SUBJ, confirm: 'LÖSCHEN' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('boom')
  })
})

describe('reading reports (tenant-scoped by the service)', () => {
  it('GET list returns the reports', async () => {
    const res = await list()
    expect(res.status).toBe(200)
    expect(h.readErasureReports).toHaveBeenCalledWith({})
    expect((await res.json()).data).toHaveLength(1)
  })

  it('R33f LOW: the subject id never travels in the URL: GET ?subjectId= is refused, nothing is read', async () => {
    const res = await list(`?subjectId=${SUBJ}`)
    expect(res.status).toBe(400)
    expect(h.readErasureReports).not.toHaveBeenCalled()
    expect(JSON.stringify(await res.json())).not.toContain(SUBJ)
  })

  it('the lookup by subject is a POST body search', async () => {
    const res = await search({ subjectId: SUBJ })
    expect(res.status).toBe(200)
    expect(h.readErasureReports).toHaveBeenCalledWith({ subjectId: SUBJ })
    expect((await res.json()).data).toHaveLength(1)
  })

  it('the search is admin-only and rejects a malformed id', async () => {
    h.hasRole.mockReturnValue(false)
    expect((await search({ subjectId: SUBJ }, locals(['member']))).status).toBe(403)
    h.hasRole.mockReturnValue(true)
    expect((await search({ subjectId: 'u1' })).status).toBe(422)
    expect(h.readErasureReports).not.toHaveBeenCalled()
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
