import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * F1-FIX-03 / H17 (S2#0, S3#0, S3#26): `.svg` was on the inline-viewable list
 * and GET /api/files/<path> echoed the upstream Content-Type with no CSP (the
 * app CSP applies to text/html only). An uploaded SVG containing <script>,
 * opened with ?inline=1, ran on the app origin with the viewer's session.
 *
 * Post-conditions pinned here, against the REAL route handler (only the
 * Nextcloud backend is faked, answering with whatever Content-Type an attacker
 * could make it send):
 *   - an SVG is never inline: attachment, never image/svg+xml;
 *   - every file response carries a Content-Type from a fixed allowlist keyed
 *     on the extension, never the upstream value;
 *   - every file response except an inline PDF carries
 *     `Content-Security-Policy: sandbox; default-src 'none'` (no script, opaque
 *     origin), and nosniff.
 */

const { mockDownload } = vi.hoisted(() => ({ mockDownload: vi.fn() }))

vi.mock('$lib/server/files/backend/resolve', () => ({
  resolveFilesBackendOr503: () => ({ download: mockDownload, propfind: vi.fn() }),
}))

import { GET } from './+server'

function event(path: string, query = '') {
  return {
    params: { path },
    locals: {
      user: { id: 'u-1', email: '', name: 'A', roles: ['member'], groups: [], loa: 0, authTime: 0 },
      accessToken: 'tok',
      accessTokenExpires: null,
    },
    url: new URL(`http://localhost/api/files/${path}${query}`),
    request: new Request(`http://localhost/api/files/${path}${query}`),
  } as never
}

function upstream(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/members")</script></svg>'
const SANDBOX = /(^|;)\s*sandbox\s*(;|$)/
const DEFAULT_NONE = /default-src 'none'/

beforeEach(() => {
  mockDownload.mockReset()
})

describe('GET /api/files/[...path] — no active content from the app origin (H17)', () => {
  it('x.svg?inline=1 is an ATTACHMENT, never image/svg+xml, and sandboxed', async () => {
    mockDownload.mockResolvedValue(upstream(SVG, 'image/svg+xml'))
    const res = (await GET(event('Docs/x.svg', '?inline=1'))) as Response
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Type')).not.toMatch(/svg/)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toMatch(SANDBOX)
    expect(csp).toMatch(DEFAULT_NONE)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('an upper-case X.SVG is treated the same', async () => {
    mockDownload.mockResolvedValue(upstream(SVG, 'image/svg+xml'))
    const res = (await GET(event('X.SVG', '?inline=1'))) as Response
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('a .png whose upstream claims text/html is served as image/png, sandboxed', async () => {
    mockDownload.mockResolvedValue(upstream('<script>alert(1)</script>', 'text/html'))
    const res = (await GET(event('a.png', '?inline=1'))) as Response
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/)
    expect(res.headers.get('Content-Security-Policy') ?? '').toMatch(SANDBOX)
  })

  it('a .html file is never rendered: attachment, octet-stream, sandboxed', async () => {
    mockDownload.mockResolvedValue(upstream('<script>alert(1)</script>', 'text/html'))
    const res = (await GET(event('page.html', '?inline=1'))) as Response
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Security-Policy') ?? '').toMatch(SANDBOX)
  })

  it('.txt and .md are plain text, never HTML', async () => {
    for (const name of ['n.txt', 'n.md']) {
      mockDownload.mockResolvedValue(upstream('# hi', 'text/html'))
      const res = (await GET(event(name, '?inline=1'))) as Response
      expect(res.headers.get('Content-Type'), name).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('Content-Security-Policy') ?? '', name).toMatch(SANDBOX)
    }
  })

  it('an inline PDF keeps application/pdf (the browser viewer), whatever upstream says', async () => {
    mockDownload.mockResolvedValue(upstream('%PDF-1.7', 'text/html'))
    const res = (await GET(event('p.pdf', '?inline=1'))) as Response
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/)
  })

  it('every download (no ?inline) is an attachment with an allowlisted type and the sandbox CSP', async () => {
    const cases: Array<[string, string]> = [
      ['a.odt', 'application/octet-stream'],
      ['a.pdf', 'application/pdf'],
      ['a.jpeg', 'image/jpeg'],
      ['a.svg', 'application/octet-stream'],
      ['a.exe', 'application/octet-stream'],
    ]
    for (const [name, type] of cases) {
      mockDownload.mockResolvedValue(upstream('x', 'text/html; charset=utf-8'))
      const res = (await GET(event(name))) as Response
      expect(res.headers.get('Content-Disposition'), name).toMatch(/^attachment;/)
      expect(res.headers.get('Content-Type'), name).toBe(type)
      expect(res.headers.get('Content-Security-Policy') ?? '', name).toMatch(SANDBOX)
      expect(res.headers.get('Content-Security-Policy') ?? '', name).toMatch(DEFAULT_NONE)
    }
  })
})
