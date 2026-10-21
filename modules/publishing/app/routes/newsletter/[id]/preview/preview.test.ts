import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// #232 — the newsletter ODT preview page renders Collabora-converted HTML via
// `{@html data.html}` (+page.svelte). LibreOffice/Collabora output is untrusted
// (G-011 class): it can carry inline <script>/onerror payloads. Sanitizing at
// this sink is the PRIMARY gate — do not rely on the CSP alone. (Since #259-3
// the app CSP is nonce-based and no longer allows 'unsafe-inline' on script-src,
// so an inline <script> that slipped past the sanitizer would now ALSO be
// CSP-blocked; the sanitizer + nonce CSP are defence-in-depth, not either/or.)
//
// This pins that the page loader runs the conversion output through
// `sanitizeRichHtml` before returning it — matching the protocol-publish
// (api/protocols/[id]/publish/+server.ts) and news-edit flows. The sanitizer's
// own allowlist tests live in lib/server/security/html-sanitize.test.ts; the
// real sanitizer runs here (not mocked) so this verifies the genuine wiring.
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
  resolveNewsletterBackendForPage: mockResolveBackend,
}))
vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: mockCreateNextcloudClient,
}))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({
  convertOdtToHtml: mockConvertOdtToHtml,
}))

import { load } from './+page.server'

function makeEvent() {
  return {
    locals: { user: { id: 'u1', roles: ['finance'] } },
    params: { id: '7' },
  } as unknown as Parameters<typeof load>[0]
}

// The happy path (Finance role, valid id, newsletter present) always returns
// { html }; load()'s type widens to void via its redirect/error branches, so
// narrow it once here for the assertions.
async function loadPreview() {
  return (await load(makeEvent())) as { html: string }
}

describe('newsletter preview loader — #232 {@html} sanitization', () => {
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

  it('strips <script> from the converted HTML before returning it', async () => {
    mockConvertOdtToHtml.mockResolvedValue('<p>Hi</p><script>fetch("/leak")</script><p>Bye</p>')
    const data = await loadPreview()
    expect(data.html).not.toContain('<script')
    expect(data.html).not.toContain('fetch("/leak")')
    expect(data.html).toContain('<p>Hi</p>')
    expect(data.html).toContain('<p>Bye</p>')
  })

  it('strips onerror handlers from the converted HTML', async () => {
    mockConvertOdtToHtml.mockResolvedValue('<img src="x.png" onerror="alert(1)" alt="boom">')
    const data = await loadPreview()
    expect(data.html).not.toMatch(/onerror/i)
    expect(data.html).not.toContain('alert(1)')
  })

  it('strips <iframe> from the converted HTML', async () => {
    mockConvertOdtToHtml.mockResolvedValue('<p>ok</p><iframe src="https://evil.example.com/"></iframe>')
    const data = await loadPreview()
    expect(data.html).not.toContain('<iframe')
    expect(data.html).not.toContain('evil.example.com')
  })

  it('preserves safe markup unchanged', async () => {
    const safe = '<p>Hello <strong>world</strong></p>'
    mockConvertOdtToHtml.mockResolvedValue(safe)
    const data = await loadPreview()
    expect(data.html).toBe(safe)
  })
})
