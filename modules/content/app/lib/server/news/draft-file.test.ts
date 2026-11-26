import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureNewsDraft, newsDraftFolder, newsDraftPath, newsDraftUser } from './draft-file'

const TENANT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('news draft Nextcloud user', () => {
  const saved = process.env.NEXTCLOUD_ADMIN_USER
  beforeEach(() => {
    process.env.NEXTCLOUD_ADMIN_USER = 'ncadmin'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXTCLOUD_ADMIN_USER
    else process.env.NEXTCLOUD_ADMIN_USER = saved
  })

  it('is the configured Nextcloud admin user', () => {
    expect(newsDraftUser()).toBe('ncadmin')
  })

  it('falls back to admin only when the setting is absent', () => {
    delete process.env.NEXTCLOUD_ADMIN_USER
    expect(newsDraftUser()).toBe('admin')
  })

  it('builds the draft path under the configured user and the tenant id', () => {
    expect(newsDraftFolder(TENANT)).toBe(`/remote.php/dav/files/ncadmin/news-posts/${TENANT}/drafts`)
    expect(newsDraftPath(TENANT, 7)).toBe(`/remote.php/dav/files/ncadmin/news-posts/${TENANT}/drafts/7.odt`)
  })

  it('runs every Nextcloud call as the configured user', async () => {
    const nc = {
      mkcol: vi.fn().mockResolvedValue(undefined),
      getFileId: vi.fn().mockRejectedValue({ status: 404 }),
      upload: vi.fn().mockResolvedValue(undefined),
    }
    await ensureNewsDraft(nc, TENANT, 7, async () => new Uint8Array([1]))
    expect(nc.mkcol.mock.calls.length).toBe(3)
    for (const call of nc.mkcol.mock.calls) expect(call[1]).toBe('ncadmin')
    expect(nc.getFileId.mock.calls[0][1]).toBe('ncadmin')
    expect(nc.upload.mock.calls[0][1]).toBe('ncadmin')
    expect(nc.upload.mock.calls[0][0]).toBe(`/remote.php/dav/files/ncadmin/news-posts/${TENANT}/drafts/7.odt`)
  })
})
