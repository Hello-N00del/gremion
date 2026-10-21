// gremion-ui/src/routes/api/internal/newsletter/newsletter-callbacks.test.ts
// Task 11: TDD for kernel resolver callback endpoints (render, resolve-group, send-mail).
//
// Guard: x-internal-auth header with timingSafeEqual on INTERNAL_NEWSLETTER_SECRET.
// Tenant: comes from regular tenant resolution (x-tenant-id / x-tenant-slug headers).
//
// TDD order: tests written BEFORE the implementation (RED → GREEN).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks (hoisted before any import) ──────────────────────────────────

// Mock NC client
const mockDownload = vi.fn()
vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: vi.fn(() => ({
    download: mockDownload,
  })),
}))

// Mock collabora-convert
const mockConvertOdtToHtml = vi.fn()
vi.mock('$lib/server/newsletter/collabora-convert', () => ({
  convertOdtToHtml: mockConvertOdtToHtml,
}))

// Mock KC admin
const mockGetGroupMembers = vi.fn()
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClientForCurrentTenant: vi.fn(() => ({
    getGroupMembers: mockGetGroupMembers,
  })),
}))

// Mock tenant-mail
const mockSendMailForTenant = vi.fn()
const MockSmtpUnconfiguredError = class extends Error {
  constructor(tenantId: string) {
    super(`smtp-unconfigured for tenant ${tenantId}`)
    this.name = 'SmtpUnconfiguredError'
  }
}
vi.mock('$lib/server/mail/tenant-mail', () => ({
  sendMailForTenant: (...args: unknown[]) => mockSendMailForTenant(...args),
  SmtpUnconfiguredError: MockSmtpUnconfiguredError,
}))

// Secret for all tests
const TEST_SECRET = 'test-secret-value-abc123'

// ── Helper: build a minimal Request ─────────────────────────────────────────

function makeRequest(body: unknown, secret: string | null): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (secret !== null) headers['x-internal-auth'] = secret
  return new Request('http://localhost/api/internal/newsletter/render', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

// ── Helper: build SvelteKit event ───────────────────────────────────────────

function makeEvent(body: unknown, secret: string | null) {
  return {
    request: makeRequest(body, secret),
    locals: {
      tenant: { id: 'tid-default', slug: 'default' },
    },
  }
}

// ── Import SUTs (after mocks) ────────────────────────────────────────────────

const renderModule = await import('./render/+server')
const resolveGroupModule = await import('./resolve-group/+server')
const sendMailModule = await import('./send-mail/+server')

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.INTERNAL_NEWSLETTER_SECRET = TEST_SECRET
  mockDownload.mockReset()
  mockConvertOdtToHtml.mockReset()
  mockGetGroupMembers.mockReset()
  mockSendMailForTenant.mockReset()
})

// ═══════════════════════════════════════════════════════════════════════════════
// render endpoint
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/internal/newsletter/render', () => {
  it('RED→GREEN: returns 403 when x-internal-auth header is missing', async () => {
    const res = await renderModule.POST(makeEvent({ odtPath: '/files/nl.odt' }, null) as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 403 when secret is wrong', async () => {
    const res = await renderModule.POST(makeEvent({ odtPath: '/files/nl.odt' }, 'wrong-secret') as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 400 when odtPath is missing', async () => {
    const res = await renderModule.POST(makeEvent({}, TEST_SECRET) as never)
    expect(res.status).toBe(400)
  })

  it('RED→GREEN: returns 400 when odtPath is empty string', async () => {
    const res = await renderModule.POST(makeEvent({ odtPath: '' }, TEST_SECRET) as never)
    expect(res.status).toBe(400)
  })

  it('RED→GREEN: returns 200 with {html} on happy path', async () => {
    const fakeBuffer = new ArrayBuffer(8)
    mockDownload.mockResolvedValue({ arrayBuffer: async () => fakeBuffer })
    mockConvertOdtToHtml.mockResolvedValue('<h1>Newsletter</h1>')

    const res = await renderModule.POST(makeEvent({ odtPath: '/files/nl.odt' }, TEST_SECRET) as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { html: string }
    expect(json.html).toBe('<h1>Newsletter</h1>')

    // NC download was called with the correct path
    expect(mockDownload).toHaveBeenCalledWith('/files/nl.odt', 'admin')
    // convertOdtToHtml was called with the buffer
    expect(mockConvertOdtToHtml).toHaveBeenCalledWith(fakeBuffer)
  })

  it('RED→GREEN: returns 500 when NC download fails', async () => {
    mockDownload.mockRejectedValue(new Error('NC down'))
    const res = await renderModule.POST(makeEvent({ odtPath: '/files/nl.odt' }, TEST_SECRET) as never)
    expect(res.status).toBe(500)
  })

  it('RED→GREEN: returns 500 when collabora conversion fails', async () => {
    const fakeBuffer = new ArrayBuffer(4)
    mockDownload.mockResolvedValue({ arrayBuffer: async () => fakeBuffer })
    mockConvertOdtToHtml.mockRejectedValue(new Error('Collabora down'))
    const res = await renderModule.POST(makeEvent({ odtPath: '/files/nl.odt' }, TEST_SECRET) as never)
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// resolve-group endpoint
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/internal/newsletter/resolve-group', () => {
  it('RED→GREEN: returns 403 when x-internal-auth header is missing', async () => {
    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'group-uuid' }, null) as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 403 when secret is wrong', async () => {
    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'group-uuid' }, 'bad') as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 400 when groupId is missing', async () => {
    const res = await resolveGroupModule.POST(makeEvent({}, TEST_SECRET) as never)
    expect(res.status).toBe(400)
  })

  it('RED→GREEN: returns 400 when groupId is empty string', async () => {
    const res = await resolveGroupModule.POST(makeEvent({ groupId: '' }, TEST_SECRET) as never)
    expect(res.status).toBe(400)
  })

  it('RED→GREEN: returns 200 with email-bearing members (scheduler filter parity)', async () => {
    mockGetGroupMembers.mockResolvedValue([
      { id: 'u1', username: 'alice', email: 'alice@example.org', firstName: 'Alice', lastName: 'Smith', enabled: true, emailVerified: true },
      { id: 'u2', username: 'bob', email: '', firstName: 'Bob', lastName: 'Jones', enabled: true, emailVerified: false }, // no email → filtered
      { id: 'u3', username: 'carol', email: 'carol@example.org', firstName: 'Carol', lastName: '', enabled: true, emailVerified: true },
      { id: 'u4', username: 'dave', email: undefined, firstName: 'Dave', lastName: 'X', enabled: true, emailVerified: false }, // no email → filtered
    ])

    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'group-uuid-1' }, TEST_SECRET) as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { members: Array<{ email: string; name: string | null }> }
    // Only alice and carol have emails; bob and dave are filtered
    expect(json.members).toHaveLength(2)
    expect(json.members[0]).toEqual({ email: 'alice@example.org', name: 'Alice Smith' })
    expect(json.members[1]).toEqual({ email: 'carol@example.org', name: 'Carol' })
  })

  it('RED→GREEN: name is null when both firstName and lastName are empty/absent (scheduler parity)', async () => {
    mockGetGroupMembers.mockResolvedValue([
      { id: 'u5', username: 'eve', email: 'eve@example.org', firstName: '', lastName: '', enabled: true, emailVerified: true },
    ])

    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'g2' }, TEST_SECRET) as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { members: Array<{ email: string; name: string | null }> }
    expect(json.members[0]).toEqual({ email: 'eve@example.org', name: null })
  })

  it('RED→GREEN: empty-email-only group returns {members:[]}', async () => {
    mockGetGroupMembers.mockResolvedValue([
      { id: 'u6', username: 'nomail', email: null, firstName: 'No', lastName: 'Mail', enabled: true, emailVerified: false },
    ])

    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'g3' }, TEST_SECRET) as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { members: unknown[] }
    expect(json.members).toEqual([])
  })

  it('RED→GREEN: returns 500 when KC getGroupMembers throws', async () => {
    mockGetGroupMembers.mockRejectedValue(new Error('KC down'))
    const res = await resolveGroupModule.POST(makeEvent({ groupId: 'g4' }, TEST_SECRET) as never)
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// send-mail endpoint
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/internal/newsletter/send-mail', () => {
  const VALID_BODY = {
    to: 'alice@example.org',
    subject: 'Test newsletter',
    html: '<p>Hello</p>',
  }

  it('RED→GREEN: returns 403 when x-internal-auth header is missing', async () => {
    const res = await sendMailModule.POST(makeEvent(VALID_BODY, null) as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 403 when secret is wrong', async () => {
    const res = await sendMailModule.POST(makeEvent(VALID_BODY, 'nope') as never)
    expect(res.status).toBe(403)
  })

  it('RED→GREEN: returns 400 when required body fields are missing', async () => {
    const res = await sendMailModule.POST(makeEvent({ to: 'x@y.com' }, TEST_SECRET) as never)
    expect(res.status).toBe(400)
  })

  it('RED→GREEN: returns 200 with {messageId} on happy path', async () => {
    mockSendMailForTenant.mockResolvedValue({ messageId: '<msg-id-123@example.org>' })

    const res = await sendMailModule.POST(makeEvent(VALID_BODY, TEST_SECRET) as never)
    expect(res.status).toBe(200)
    const json = await res.json() as { messageId: string }
    expect(json.messageId).toBe('<msg-id-123@example.org>')

    expect(mockSendMailForTenant).toHaveBeenCalledWith({
      to: VALID_BODY.to,
      subject: VALID_BODY.subject,
      html: VALID_BODY.html,
    })
  })

  it('RED→GREEN: returns 200 with optional from_address and from_name forwarded', async () => {
    mockSendMailForTenant.mockResolvedValue({ messageId: '<msg2@example.org>' })

    const bodyWithFrom = { ...VALID_BODY, from_address: 'noreply@example.org', from_name: 'StuRa' }
    const res = await sendMailModule.POST(makeEvent(bodyWithFrom, TEST_SECRET) as never)
    expect(res.status).toBe(200)

    expect(mockSendMailForTenant).toHaveBeenCalledWith({
      to: VALID_BODY.to,
      subject: VALID_BODY.subject,
      html: VALID_BODY.html,
      from_address: 'noreply@example.org',
      from_name: 'StuRa',
    })
  })

  it('RED→GREEN: returns smtp-unconfigured (503) when SmtpUnconfiguredError is thrown', async () => {
    mockSendMailForTenant.mockRejectedValue(new MockSmtpUnconfiguredError('tid-default'))

    const res = await sendMailModule.POST(makeEvent(VALID_BODY, TEST_SECRET) as never)
    // Must NOT be 500 — must be a typed response the leaf can detect
    expect(res.status).toBe(503)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('smtp-unconfigured')
  })

  it('RED→GREEN: returns 500 on unexpected SMTP errors', async () => {
    mockSendMailForTenant.mockRejectedValue(new Error('Connection refused'))
    const res = await sendMailModule.POST(makeEvent(VALID_BODY, TEST_SECRET) as never)
    expect(res.status).toBe(500)
  })
})
