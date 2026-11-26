import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The render callback reads an ODT from the shared Nextcloud admin space on behalf
// of the newsletter leaf. It serves exactly two places: the calling customer's own
// draft folder and the legacy flat folder from before drafts were keyed by
// customer. Everything else is refused, whatever the caller names.

const { mockDownload, mockConvert } = vi.hoisted(() => ({ mockDownload: vi.fn(), mockConvert: vi.fn() }))

vi.mock('$lib/server/files/nextcloud-client', () => ({
  createNextcloudClient: () => ({ download: mockDownload }),
}))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({ convertOdtToHtml: mockConvert }))

import { POST } from './+server'

const SECRET = 'render-allowlist-secret-0123456789'
const TENANT_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const TENANT_B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const BASE = '/remote.php/dav/files/ncadmin/_newsletters'

function call(odtPath: unknown, tenantId: string = TENANT_A) {
  return POST({
    request: new Request('http://localhost/api/internal/newsletter/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': SECRET },
      body: JSON.stringify({ odtPath }),
    }),
    locals: { tenant: { id: tenantId, slug: 'rat' } },
  } as never)
}

describe('POST /api/internal/newsletter/render — what may be read', () => {
  const saved = { secret: process.env.INTERNAL_NEWSLETTER_SECRET, user: process.env.NEXTCLOUD_ADMIN_USER }
  beforeEach(() => {
    process.env.INTERNAL_NEWSLETTER_SECRET = SECRET
    process.env.NEXTCLOUD_ADMIN_USER = 'ncadmin'
    mockDownload.mockReset().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) })
    mockConvert.mockReset().mockResolvedValue('<p>Hallo</p>')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (saved.secret === undefined) delete process.env.INTERNAL_NEWSLETTER_SECRET
    else process.env.INTERNAL_NEWSLETTER_SECRET = saved.secret
    if (saved.user === undefined) delete process.env.NEXTCLOUD_ADMIN_USER
    else process.env.NEXTCLOUD_ADMIN_USER = saved.user
  })

  it("renders the calling customer's own draft", async () => {
    const path = `${BASE}/${TENANT_A}/0190a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5d.odt`
    const res = await call(path)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ html: '<p>Hallo</p>' })
    expect(mockDownload).toHaveBeenCalledWith(path, 'ncadmin')
  })

  it('reads the file as the configured Nextcloud admin user', async () => {
    process.env.NEXTCLOUD_ADMIN_USER = 'other-admin'
    const path = `/remote.php/dav/files/other-admin/_newsletters/${TENANT_A}/x.odt`
    const res = await call(path)
    expect(res.status).toBe(200)
    expect(mockDownload).toHaveBeenCalledWith(path, 'other-admin')
  })

  it('still renders a legacy flat draft', async () => {
    const path = `${BASE}/rundbrief-1700000000000.odt`
    const res = await call(path)
    expect(res.status).toBe(200)
    expect(mockDownload).toHaveBeenCalledWith(path, 'ncadmin')
  })

  it("refuses another customer's draft folder", async () => {
    const res = await call(`${BASE}/${TENANT_B}/x.odt`, TENANT_A)
    expect(res.status).toBe(403)
    expect(mockDownload).not.toHaveBeenCalled()
  })

  const REFUSED: Array<[string, string]> = [
    ['a news draft', `/remote.php/dav/files/ncadmin/news-posts/${TENANT_A}/drafts/7.odt`],
    ['a path outside the dav space', '/files/nl.odt'],
    ['a path in the admin space outside the newsletter folder', '/remote.php/dav/files/ncadmin/Documents/x.odt'],
    ['a traversal out of the own folder', `${BASE}/${TENANT_A}/../${TENANT_B}/x.odt`],
    ['a traversal out of the newsletter folder', `${BASE}/../news-posts/${TENANT_A}/drafts/7.odt`],
    ['a leading traversal', '../../etc/passwd'],
    ['an encoded slash', `${BASE}/${TENANT_B}%2Fx.odt`],
    ['an upper-case encoded slash', `${BASE}%2F${TENANT_B}%2Fx.odt`],
    ['an encoded dot-dot', `${BASE}/%2e%2e/news-posts/x.odt`],
    ['a double-encoded separator', `${BASE}/${TENANT_B}%252Fx.odt`],
    ['a backslash separator', `${BASE}\\${TENANT_B}\\x.odt`],
    ['a subdirectory of the legacy folder', `${BASE}/sub/x.odt`],
    ['a nested folder in the own folder', `${BASE}/${TENANT_A}/sub/x.odt`],
    ['a different Nextcloud user space', `/remote.php/dav/files/someone/_newsletters/x.odt`],
    ['a file that is not an ODT', `${BASE}/${TENANT_A}/x.php`],
    ['the folder itself', `${BASE}/${TENANT_A}/`],
    ['the newsletter folder itself', `${BASE}/`],
    ['a path with a query', `${BASE}/${TENANT_A}/x.odt?y=../z`],
    ['a path with a fragment', `${BASE}/${TENANT_A}/x.odt#../z`],
    ['a path with a NUL byte', `${BASE}/${TENANT_A}/x\u0000.odt`],
    ['a path with a newline', `${BASE}/${TENANT_A}/x\n.odt`],
    ['an absolute URL', `https://cloud.example.org${BASE}/${TENANT_A}/x.odt`],
  ]
  for (const [label, path] of REFUSED) {
    it(`refuses ${label}`, async () => {
      const res = await call(path)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
      expect(mockDownload).not.toHaveBeenCalled()
      expect(mockConvert).not.toHaveBeenCalled()
    })
  }

  it('serves only the legacy flat folder when the tenant id is not a UUID', async () => {
    const own = await call(`${BASE}/not-a-uuid/x.odt`, 'not-a-uuid')
    expect(own.status).toBe(403)
    const legacy = await call(`${BASE}/rundbrief-1700000000000.odt`, 'not-a-uuid')
    expect(legacy.status).toBe(200)
  })

  it('refuses a path that is not a string', async () => {
    const res = await call(42)
    expect(res.status).toBe(400)
    expect(mockDownload).not.toHaveBeenCalled()
  })
})
