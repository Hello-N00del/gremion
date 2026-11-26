import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The newsletter draft ODT lives on the ONE shared Nextcloud admin space. Its
// path therefore carries the tenant id and a random file name: two customers
// that create a newsletter with the same title in the same millisecond must not
// land on the same file, and the cleanup after a failed insert must only ever
// touch the file this request created.

const { mockHasRole } = vi.hoisted(() => ({ mockHasRole: vi.fn().mockReturnValue(true) }))
const { mockResolveBackend, backend } = vi.hoisted(() => ({
  mockResolveBackend: vi.fn(),
  backend: {
    createNewsletter: vi.fn(),
    setNewsletterRecipients: vi.fn(),
    listNewsletters: vi.fn(),
  },
}))
const { nc } = vi.hoisted(() => ({
  nc: { mkcol: vi.fn(), upload: vi.fn(), delete: vi.fn() },
}))
const { mockCreateEmptyOdt } = vi.hoisted(() => ({ mockCreateEmptyOdt: vi.fn() }))

vi.mock('$lib/auth', () => ({ hasRole: mockHasRole, Role: { Finance: 'finance' } }))
vi.mock('$lib/server/newsletter/backend/resolve', () => ({
  resolveNewsletterBackendOr503: mockResolveBackend,
}))
vi.mock('$lib/server/files/nextcloud-client', () => ({ createNextcloudClient: () => nc }))
vi.mock('$lib/server/newsletter/collabora-convert', () => ({ createEmptyOdt: mockCreateEmptyOdt }))

import { POST } from './+server'

const TENANT_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const TENANT_B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function makeEvent(tenantId: string, title = 'Sommer-Update') {
  return {
    request: new Request('http://localhost/api/newsletter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, subject: 'Betreff' }),
    }),
    locals: { user: { id: 'u1', roles: ['finance'] }, tenant: { id: tenantId, slug: 'rat' } },
  } as unknown as Parameters<typeof POST>[0]
}

const mkcolPaths = () => nc.mkcol.mock.calls.map((c) => c[0] as string)

describe('POST /api/newsletter — per-customer draft path', () => {
  const saved = process.env.NEXTCLOUD_ADMIN_USER
  beforeEach(() => {
    process.env.NEXTCLOUD_ADMIN_USER = 'ncadmin'
    mockHasRole.mockReset().mockReturnValue(true)
    mockResolveBackend.mockReset().mockReturnValue(backend)
    backend.createNewsletter.mockReset().mockImplementation(async (v: { odt_path: string }) => ({ id: 1, ...v }))
    backend.setNewsletterRecipients.mockReset()
    nc.mkcol.mockReset().mockResolvedValue(undefined)
    nc.upload.mockReset().mockResolvedValue(undefined)
    nc.delete.mockReset().mockResolvedValue(undefined)
    mockCreateEmptyOdt.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (saved === undefined) delete process.env.NEXTCLOUD_ADMIN_USER
    else process.env.NEXTCLOUD_ADMIN_USER = saved
  })

  it('stores the draft under the tenant id with a random file name', async () => {
    const res = await POST(makeEvent(TENANT_A))
    expect(res.status).toBe(201)
    const path = nc.upload.mock.calls[0][0] as string
    expect(path).toMatch(
      new RegExp(`^/remote\\.php/dav/files/ncadmin/_newsletters/${TENANT_A}/${UUID_RE}\\.odt$`),
    )
    expect(backend.createNewsletter.mock.calls[0][0].odt_path).toBe(path)
  })

  it('gives two customers with the same title in the same millisecond different paths', async () => {
    await POST(makeEvent(TENANT_A, 'Rundbrief'))
    await POST(makeEvent(TENANT_B, 'Rundbrief'))
    const [a, b] = nc.upload.mock.calls.map((c) => c[0] as string)
    expect(a).not.toBe(b)
    expect(a).toContain(`/_newsletters/${TENANT_A}/`)
    expect(b).toContain(`/_newsletters/${TENANT_B}/`)
  })

  it('gives one customer two different paths for the same title in the same millisecond', async () => {
    await POST(makeEvent(TENANT_A, 'Rundbrief'))
    await POST(makeEvent(TENANT_A, 'Rundbrief'))
    const [a, b] = nc.upload.mock.calls.map((c) => c[0] as string)
    expect(a).not.toBe(b)
  })

  it('creates both folder levels, shared folder first', async () => {
    await POST(makeEvent(TENANT_A))
    expect(mkcolPaths()).toEqual([
      '/remote.php/dav/files/ncadmin/_newsletters',
      `/remote.php/dav/files/ncadmin/_newsletters/${TENANT_A}`,
    ])
    for (const c of nc.mkcol.mock.calls) expect(c[1]).toBe('ncadmin')
    // the file is uploaded after both folders exist
    expect(nc.mkcol.mock.invocationCallOrder[1]).toBeLessThan(nc.upload.mock.invocationCallOrder[0])
  })

  it('tolerates a folder that already exists (405) at both levels', async () => {
    nc.mkcol.mockRejectedValue(Object.assign(new Error('exists'), { status: 405 }))
    const res = await POST(makeEvent(TENANT_A))
    expect(res.status).toBe(201)
    expect(nc.upload).toHaveBeenCalledTimes(1)
  })

  it('answers 502 and uploads nothing when a folder cannot be created for another reason', async () => {
    nc.mkcol.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(makeEvent(TENANT_A))
    expect(res.status).toBe(502)
    expect(nc.upload).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('refuses a tenant id that is not a UUID without touching Nextcloud', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(makeEvent('../other'))
    expect(res.status).toBe(500)
    expect(nc.mkcol).not.toHaveBeenCalled()
    expect(nc.upload).not.toHaveBeenCalled()
    expect(backend.createNewsletter).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('removes only the file this request created when the insert fails', async () => {
    backend.createNewsletter.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(makeEvent(TENANT_A))
    expect(res.status).toBe(500)
    const uploaded = nc.upload.mock.calls[0][0]
    expect(nc.delete).toHaveBeenCalledTimes(1)
    expect(nc.delete.mock.calls[0][0]).toBe(uploaded)
    expect(uploaded).toContain(`/_newsletters/${TENANT_A}/`)
    errSpy.mockRestore()
  })
})
