// src/lib/server/storage/nextcloud.test.ts
// Unit tests for NextcloudStorageBackend — mocked client, no real Nextcloud.
import { describe, it, expect } from 'vitest'
import { NextcloudStorageBackend } from './nextcloud'

type Call = { method: string; args: unknown[] }

function mockClient() {
  const calls: Call[] = []
  const mkcolFails: Map<string, Error> = new Map()
  const deleteFails: Map<string, Error> = new Map()
  const downloadBytes: Map<string, Uint8Array> = new Map()
  const client = {
    upload: async (path: string, user: string, body: BodyInit, ct: string) => {
      calls.push({ method: 'upload', args: [path, user, body, ct] })
    },
    download: async (path: string, user: string) => {
      calls.push({ method: 'download', args: [path, user] })
      const bytes = downloadBytes.get(path) ?? new Uint8Array([0])
      // Copy into a fresh ArrayBuffer for BodyInit compatibility.
      const ab = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(ab).set(bytes)
      return new Response(ab)
    },
    delete: async (path: string, user: string) => {
      calls.push({ method: 'delete', args: [path, user] })
      const err = deleteFails.get(path)
      if (err) throw err
    },
    mkcol: async (path: string, user: string) => {
      calls.push({ method: 'mkcol', args: [path, user] })
      const err = mkcolFails.get(path)
      if (err) throw err
    }
  }
  return { client, calls, mkcolFails, deleteFails, downloadBytes }
}

describe('NextcloudStorageBackend.put', () => {
  it('MKCOLs each parent folder then PUTs the bytes; returns the dav handle', async () => {
    const { client, calls } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    const handle = await backend.put('finance/expense/7/r.pdf', new Uint8Array([1, 2, 3]))

    const mkcolPaths = calls.filter((c) => c.method === 'mkcol').map((c) => c.args[0])
    expect(mkcolPaths).toEqual([
      '/remote.php/dav/files/admin/finance',
      '/remote.php/dav/files/admin/finance/expense',
      '/remote.php/dav/files/admin/finance/expense/7'
    ])
    const upload = calls.find((c) => c.method === 'upload')!
    expect(upload.args[0]).toBe('/remote.php/dav/files/admin/finance/expense/7/r.pdf')
    expect(upload.args[1]).toBe('admin')
    expect(handle).toBe('/remote.php/dav/files/admin/finance/expense/7/r.pdf')
  })

  it('swallows MKCOL 405 (already exists) and proceeds with upload', async () => {
    const { client, calls, mkcolFails } = mockClient()
    mkcolFails.set('/remote.php/dav/files/admin/finance', new Error('Nextcloud MKCOL /finance → 405: Method Not Allowed'))
    const backend = new NextcloudStorageBackend(client, 'admin')
    await backend.put('finance/r.pdf', new Uint8Array([9]))
    expect(calls.some((c) => c.method === 'upload')).toBe(true)
  })
})

describe('NextcloudStorageBackend.read / delete', () => {
  it('read forwards to client.download and returns the bytes', async () => {
    const { client, downloadBytes } = mockClient()
    const handle = '/remote.php/dav/files/admin/x/y.bin'
    downloadBytes.set(handle, new Uint8Array([42, 43, 44]))
    const backend = new NextcloudStorageBackend(client, 'admin')
    const got = await backend.read(handle)
    expect(Array.from(got)).toEqual([42, 43, 44])
  })

  it('delete is idempotent on 404 from the WebDAV client', async () => {
    const { client, deleteFails } = mockClient()
    const handle = '/remote.php/dav/files/admin/gone.bin'
    deleteFails.set(handle, new Error('Nextcloud DELETE /gone.bin → 404: Not Found'))
    const backend = new NextcloudStorageBackend(client, 'admin')
    await expect(backend.delete(handle)).resolves.toBeUndefined()
  })
})

describe('NextcloudStorageBackend.davPath — path-traversal defence (#231)', () => {
  it('rejects a key that escapes the namespace via ..', async () => {
    const { client, calls } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    await expect(
      backend.put('finance/expense/7/../../../escape.odt', new Uint8Array([1]))
    ).rejects.toThrow(/escapes root/)
    expect(calls.some((c) => c.method === 'upload')).toBe(false)
  })

  it('rejects traversal even when the key has a leading slash', async () => {
    const { client } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    await expect(
      backend.put('/finance/../../etc/passwd', new Uint8Array([1]))
    ).rejects.toThrow(/escapes root/)
  })

  it('percent-encodes special characters so they cannot re-route the WebDAV URL', async () => {
    const { client, calls } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    const handle = await backend.put('finance/expense/7/a b#c.pdf', new Uint8Array([1]))
    expect(handle).toBe('/remote.php/dav/files/admin/finance/expense/7/a%20b%23c.pdf')
    expect(handle).not.toMatch(/[ #?]/)
    const upload = calls.find((c) => c.method === 'upload')!
    expect(upload.args[0]).toBe(handle)
  })

  it('leaves plain-ASCII keys byte-identical (no handle migration needed)', async () => {
    const { client } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    const handle = await backend.put('finance/expense/42/receipt.pdf', new Uint8Array([1]))
    expect(handle).toBe('/remote.php/dav/files/admin/finance/expense/42/receipt.pdf')
  })

  it('rejects backslash-style traversal (Windows separators normalised before the .. check)', async () => {
    const { client, calls } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    await expect(
      backend.put('finance\\..\\..\\etc\\passwd', new Uint8Array([1]))
    ).rejects.toThrow(/escapes root/)
    expect(calls.some((c) => c.method === 'upload')).toBe(false)
  })

  it('neutralises encoded-dot traversal: %2e%2e is double-escaped, never collapsed to ..', async () => {
    const { client } = mockClient()
    const backend = new NextcloudStorageBackend(client, 'admin')
    const handle = await backend.put('finance/expense/7/%2e%2e/x.pdf', new Uint8Array([1]))
    // The '%' is itself percent-encoded, so the segment stays a literal — the
    // WebDAV server decodes it once to "%2e%2e", never to "..".
    expect(handle).toContain('%252e%252e')
    expect(handle).not.toMatch(/\/\.\.(\/|$)/)
  })
})
