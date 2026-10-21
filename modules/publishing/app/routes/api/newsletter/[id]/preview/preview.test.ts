import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// #232 (sibling sink) — the API preview endpoint returns Collabora-converted
// HTML with `Content-Type: text/html`, directly navigable in a browser at the
// gremion-ui origin (Finance-gated GET). That is the same untrusted-HTML class as
// the +page.svelte {@html} preview: an inline <script> in the converted markup
// executes at the app origin in the viewing Finance user's session.
//
// This pins that the GET handler sanitizes the conversion output before
// returning it, matching the page loader and the protocol-publish/news-edit
// flows. The real sanitizer runs here (not mocked) to verify genuine wiring.
// ─────────────────────────────────────────────────────────────────────────────

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
const { mockResolveBackend, mockGetNewsletter } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  mockGetNewsletter: vi.fn(),
}))
const { mockCreateNextcloudClient, mockDownload } = vi.hoisted(() => ({
  mockCreateNextcloudClient: vi.fn(),
  mockDownload: vi.fn(),
}))
const { mockConvertOdtToHtml } = vi.hoisted(() => ({ mockConvertOdtToHtml: vi.fn() }))

vi.mock('$lib/auth', () => ({
  hasRole: mockHasRole,
  Role: { Finance: 'finance' },
}))
vi.mock('$lib/server/newsletter/backend/resolve', () => ({
  resolveNewsletterBackendOr503: mockResolveBackend,
}))
vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: mockCreateNextcloudClient,
}))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({
  convertOdtToHtml: mockConvertOdtToHtml,
}))

import { GET } from './+server'

function makeEvent() {
  return {
    locals: { user: { id: 'u1', roles: ['finance'] } },
    params: { id: '7' },
  } as unknown as Parameters<typeof GET>[0]
}

describe('newsletter preview API — #232 text/html sanitization', () => {
  beforeEach(() => {
    mockHasRole.mockReset().mockReturnValue(true)
    mockResolveBackend.mockReset()
    mockGetNewsletter.mockReset()
    mockCreateNextcloudClient.mockReset()
    mockDownload.mockReset()
    mockConvertOdtToHtml.mockReset()

    mockGetNewsletter.mockResolvedValue({ id: 7, odt_path: '/newsletters/7.odt' })
    mockResolveBackend.mockReturnValue({ getNewsletter: mockGetNewsletter })
    mockDownload.mockResolvedValue(new Response('odt'))
    mockCreateNextcloudClient.mockReturnValue({ download: mockDownload })
  })

  it('strips <script> from the text/html response body', async () => {
    mockConvertOdtToHtml.mockResolvedValue('<p>Hi</p><script>fetch("/leak")</script><p>Bye</p>')
    const res = await GET(makeEvent())
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('<script')
    expect(body).not.toContain('fetch("/leak")')
    expect(body).toContain('<p>Hi</p>')
    expect(body).toContain('<p>Bye</p>')
  })

  it('strips onerror handlers from the response body', async () => {
    mockConvertOdtToHtml.mockResolvedValue('<img src="x.png" onerror="alert(1)" alt="boom">')
    const res = await GET(makeEvent())
    const body = await res.text()
    expect(body).not.toMatch(/onerror/i)
    expect(body).not.toContain('alert(1)')
  })

  it('preserves safe markup unchanged', async () => {
    const safe = '<p>Hello <strong>world</strong></p>'
    mockConvertOdtToHtml.mockResolvedValue(safe)
    const res = await GET(makeEvent())
    const body = await res.text()
    expect(body).toBe(safe)
  })
})
