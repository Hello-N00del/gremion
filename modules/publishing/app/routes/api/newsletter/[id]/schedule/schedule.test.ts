// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Security sweep: scheduling a newsletter is a deferred send-now. The scheduler
// dispatches any row with scheduled_at <= now(), so this route must carry the same
// gate as send-now (ITAdmin/CouncilAdmin), refuse past/near-past times and failed
// newsletters, and leave an audit_log trail.

const { mockResolveBackend, mockWriteAudit } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  mockWriteAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('$lib/server/newsletter/backend/resolve', () => ({
  resolveNewsletterBackendOr503: mockResolveBackend,
}))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: mockWriteAudit }))

import { POST } from './+server'
import { Role } from '$lib/auth'

const backend = {
  getNewsletter: vi.fn(),
  updateNewsletter: vi.fn(),
  recordNewsletterAudit: vi.fn().mockResolvedValue(undefined),
}

function call(roles: string[], scheduled_at: string, id = '7') {
  return POST({
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify({ scheduled_at }) }),
    params: { id },
    locals: { user: { id: 'u1', roles } },
  } as never) as Promise<Response>
}
const future = (min: number) => new Date(Date.now() + min * 60_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveBackend.mockReturnValue(backend)
  backend.getNewsletter.mockResolvedValue({ id: 7, status: 'draft' })
  backend.updateNewsletter.mockResolvedValue(undefined)
})

describe('newsletter schedule route', () => {
  it('rejects Finance-only users (needs ITAdmin/CouncilAdmin like send-now)', async () => {
    const res = await call([Role.Finance], future(60))
    expect(res.status).toBe(403)
    expect(backend.updateNewsletter).not.toHaveBeenCalled()
  })

  it('allows ITAdmin and CouncilAdmin', async () => {
    expect((await call([Role.ITAdmin], future(60))).status).toBe(200)
    expect((await call([Role.CouncilAdmin], future(60))).status).toBe(200)
  })

  it('rejects past scheduled_at', async () => {
    const res = await call([Role.ITAdmin], new Date(Date.now() - 3600_000).toISOString())
    expect(res.status).toBe(400)
    expect(backend.updateNewsletter).not.toHaveBeenCalled()
  })

  it('rejects scheduled_at inside the 5 minute margin', async () => {
    const res = await call([Role.ITAdmin], future(1))
    expect(res.status).toBe(400)
  })

  it('refuses failed newsletters', async () => {
    backend.getNewsletter.mockResolvedValue({ id: 7, status: 'failed' })
    const res = await call([Role.ITAdmin], future(60))
    expect(res.status).toBe(409)
    expect(backend.updateNewsletter).not.toHaveBeenCalled()
  })

  it('writes an audit_log entry on schedule', async () => {
    const res = await call([Role.ITAdmin], future(60))
    expect(res.status).toBe(200)
    expect(mockWriteAudit).toHaveBeenCalledTimes(1)
    expect(mockWriteAudit.mock.calls[0]![0]).toMatchObject({ userId: 'u1', field: 'newsletter_scheduled' })
  })
})
