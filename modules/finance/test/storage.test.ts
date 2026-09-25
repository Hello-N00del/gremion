// test/storage.test.ts — unit test for the leaf storage seam (#383 Lane E2 / R7).
//   - LocalStorageBackend: put→read byte round-trip, idempotent delete, traversal reject.
//   - NextcloudStorageBackend (over a MOCK StorageWebdavClient — NO live Nextcloud):
//     the storage_path HANDLE is byte-identical to the native oracle
//     (/remote.php/dav/files/<user>/<encoded>), spaces/# percent-encoded, ".." rejected,
//     lazy MKCOL parent creation (405/409 swallowed), read round-trip, delete swallows 404.
//   - getStorage() env selection (local default / nextcloud / unknown → throw).

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStorageBackend } from '../src/storage/local.ts'
import { NextcloudStorageBackend, type StorageWebdavClient } from '../src/storage/nextcloud.ts'
import { FinanceWebdavError } from '../src/nextcloud/webdav-client.ts'
import { getStorage, resetStorageForTest } from '../src/storage/index.ts'

// ── LocalStorageBackend ─────────────────────────────────────────────────────
describe('LocalStorageBackend', () => {
  const roots: string[] = []
  const freshRoot = () => {
    const r = mkdtempSync(join(tmpdir(), 'fin-store-'))
    roots.push(r)
    return r
  }
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('put→read round-trips exact bytes and returns an absolute handle', async () => {
    const be = new LocalStorageBackend(freshRoot())
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const handle = await be.put('finance/expense/1/beleg.pdf', bytes)
    expect(handle).toMatch(/beleg\.pdf$/)
    expect(await be.read(handle)).toEqual(bytes)
  })

  it('delete is idempotent (missing object is not an error)', async () => {
    const be = new LocalStorageBackend(freshRoot())
    const handle = await be.put('a/b.bin', new Uint8Array([9]))
    await be.delete(handle)
    await expect(be.delete(handle)).resolves.toBeUndefined() // second delete: no throw
  })

  it('rejects a traversal relPath that would escape the root', async () => {
    const be = new LocalStorageBackend(freshRoot())
    await expect(be.put('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/escapes root/)
  })
})

// ── NextcloudStorageBackend (mock WebDAV client) ─────────────────────────────
/** In-memory mock of the StorageWebdavClient — records every call + keeps bytes. */
function mockWebdav(opts: { mkcolStatus?: number; deleteMissing?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: Array<{ op: string; path: string; user: string }> = []
  const client: StorageWebdavClient = {
    async upload(path, user, body, _ct) {
      calls.push({ op: 'upload', path, user })
      files.set(path, new Uint8Array(await body.arrayBuffer()))
    },
    async download(path, user) {
      calls.push({ op: 'download', path, user })
      const b = files.get(path)
      if (!b) throw new FinanceWebdavError('GET', path, 404, 'not found')
      return new Response(b)
    },
    async delete(path, user) {
      calls.push({ op: 'delete', path, user })
      if (!files.has(path)) {
        if (opts.deleteMissing) throw new FinanceWebdavError('DELETE', path, 404, 'gone')
        return
      }
      files.delete(path)
    },
    async mkcol(path, user) {
      calls.push({ op: 'mkcol', path, user })
      if (opts.mkcolStatus) throw new FinanceWebdavError('MKCOL', path, opts.mkcolStatus, 'exists')
    },
  }
  return { client, files, calls }
}

describe('NextcloudStorageBackend (handle parity + idempotency)', () => {
  it('put returns the native-oracle WebDAV handle and MKCOLs each parent folder', async () => {
    const { client, files, calls } = mockWebdav({ mkcolStatus: 405 }) // parents already exist
    const be = new NextcloudStorageBackend(client, 'admin')
    const bytes = new Uint8Array([1, 2, 3])
    const handle = await be.put('finance/expense/1/beleg.pdf', bytes)
    expect(handle).toBe('/remote.php/dav/files/admin/finance/expense/1/beleg.pdf')
    expect(files.get(handle)).toEqual(bytes)
    // MKCOL walked finance, finance/expense, finance/expense/1 (405 swallowed).
    const mkcols = calls.filter((c) => c.op === 'mkcol').map((c) => c.path)
    expect(mkcols).toEqual([
      '/remote.php/dav/files/admin/finance',
      '/remote.php/dav/files/admin/finance/expense',
      '/remote.php/dav/files/admin/finance/expense/1',
    ])
    // impersonation user forwarded on every op.
    expect(calls.every((c) => c.user === 'admin')).toBe(true)
  })

  it('percent-encodes attacker-influenced filename segments (space / #)', async () => {
    const { client } = mockWebdav({ mkcolStatus: 409 })
    const be = new NextcloudStorageBackend(client, 'admin')
    const handle = await be.put('finance/expense/1/my receipt #2.pdf', new Uint8Array([0]))
    expect(handle).toBe('/remote.php/dav/files/admin/finance/expense/1/my%20receipt%20%232.pdf')
  })

  it('rejects a ".." traversal segment in the key', async () => {
    const { client } = mockWebdav()
    const be = new NextcloudStorageBackend(client, 'admin')
    await expect(be.put('finance/../../../etc/x', new Uint8Array([0]))).rejects.toThrow(/escapes root/)
  })

  it('read round-trips exact bytes via the handle', async () => {
    const { client } = mockWebdav({ mkcolStatus: 405 })
    const be = new NextcloudStorageBackend(client, 'admin')
    const bytes = new Uint8Array([10, 20, 30, 40])
    const handle = await be.put('finance/expense/2/x.png', bytes)
    expect(await be.read(handle)).toEqual(bytes)
  })

  it('delete swallows a 404 (idempotent)', async () => {
    const { client } = mockWebdav({ deleteMissing: true })
    const be = new NextcloudStorageBackend(client, 'admin')
    await expect(be.delete('/remote.php/dav/files/admin/finance/expense/9/gone.pdf')).resolves.toBeUndefined()
  })

  it('encodes an email-style storage user in the handle', async () => {
    const { client } = mockWebdav({ mkcolStatus: 405 })
    const be = new NextcloudStorageBackend(client, 'svc@stura')
    const handle = await be.put('finance/expense/1/a.pdf', new Uint8Array([0]))
    expect(handle).toBe('/remote.php/dav/files/svc%40stura/finance/expense/1/a.pdf')
  })
})

// ── getStorage() env selection ───────────────────────────────────────────────
describe('getStorage() backend selection', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    resetStorageForTest()
  })

  it('defaults to the local backend', () => {
    delete process.env.STORAGE_BACKEND
    resetStorageForTest()
    expect(getStorage()).toBeInstanceOf(LocalStorageBackend)
  })

  it('selects the nextcloud backend', () => {
    process.env.STORAGE_BACKEND = 'nextcloud'
    resetStorageForTest()
    expect(getStorage()).toBeInstanceOf(NextcloudStorageBackend)
  })

  it('throws on an unknown backend (fail-closed)', () => {
    process.env.STORAGE_BACKEND = 's3'
    resetStorageForTest()
    expect(() => getStorage()).toThrow(/unknown STORAGE_BACKEND/)
  })
})
