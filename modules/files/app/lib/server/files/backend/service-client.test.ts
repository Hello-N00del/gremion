// service-client.test.ts — files leaf HTTP ACL contract.
// Pins the request/response ENVELOPE the ServiceFilesClient sends to the leaf
// against contracts/files/openapi.files-internal.json: URL path, POST method,
// required internal/tenant/bearer headers, JSON body shape, read-retry policy,
// and non-2xx → FilesServiceError. Flag OFF this client is never used at
// runtime; this test is the only thing pinning it to the leaf contract.

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// getTenant() is fail-closed (throws without an AsyncLocalStorage context).
// Mock it so buildHeaders() can emit x-tenant-id / x-tenant-slug.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

import { ServiceFilesClient, FilesServiceError } from './service-client'

// Load the committed contract — every path the client POSTs must be declared.
const CONTRACT = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../../../contracts/files/openapi.files-internal.json'),
    'utf8',
  ),
) as { paths: Record<string, unknown> }

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Strip the base URL → the contract-relative path (drops any query string). */
function contractPath(url: string): string {
  return new URL(url).pathname
}

beforeEach(() => {
  process.env.FILES_SERVICE_URL = 'http://files-service:8080'
  process.env.INTERNAL_FILES_SECRET = 's3cr3t'
})

describe('ServiceFilesClient — leaf ACL contract', () => {
  it('kind is service', () => {
    expect(new ServiceFilesClient().kind).toBe('service')
  })

  it('propfind: POST /api/v1/propfind with secret+tenant+bearer+correlation headers and {path,user} body', async () => {
    const entry = { href: '/remote.php/dav/files/u/A', displayName: 'A', isCollection: true }
    const fetchImpl = vi.fn(async () => jsonRes({ entries: [entry] }))
    const c = new ServiceFilesClient({ webdavBearer: 'kc-token', correlationId: 'corr-1', fetchImpl })
    const out = await c.propfind('/remote.php/dav/files/u/Docs', 'u')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const path = contractPath(url)
    expect(path).toBe('/api/v1/propfind')
    expect(CONTRACT.paths[path]).toBeDefined() // declared in the contract
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-internal-auth']).toBe('s3cr3t')
    expect(headers['x-tenant-id']).toBe('tenant-1')
    expect(headers['x-tenant-slug']).toBe('default')
    expect(headers['x-webdav-bearer']).toBe('kc-token')
    expect(headers['x-correlation-id']).toBe('corr-1')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/remote.php/dav/files/u/Docs', user: 'u' })
    expect(out).toEqual([entry])
  })

  it('move: POST /api/v1/move with {from,to,user} body', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ success: true }))
    const c = new ServiceFilesClient({ fetchImpl })
    await c.move('/remote.php/dav/files/u/old.txt', '/remote.php/dav/files/u/new.txt', 'u')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(contractPath(url)).toBe('/api/v1/move')
    expect(CONTRACT.paths['/api/v1/move']).toBeDefined()
    expect(JSON.parse(init.body as string)).toEqual({
      from: '/remote.php/dav/files/u/old.txt',
      to: '/remote.php/dav/files/u/new.txt',
      user: 'u',
    })
  })

  it('upload-chunk: POST /api/v1/upload-chunk with chunk headers, returns {complete}', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ complete: true }))
    const c = new ServiceFilesClient({ fetchImpl })
    const res = await c.uploadChunk({
      userId: 'kc-sub-alice',
      uploadId: 'abc123',
      chunkIndex: 2,
      totalChunks: 3,
      sanitizedPath: 'Docs/big.zip',
      totalSize: '12345',
      body: null,
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(contractPath(url)).toBe('/api/v1/upload-chunk')
    expect(CONTRACT.paths['/api/v1/upload-chunk']).toBeDefined()
    const headers = init.headers as Record<string, string>
    expect(headers['x-upload-id']).toBe('abc123')
    expect(headers['x-upload-user']).toBe('kc-sub-alice')
    expect(headers['x-chunk-index']).toBe('2')
    expect(headers['x-total-chunks']).toBe('3')
    expect(headers['x-final-path']).toBe('Docs/big.zip')
    expect(headers['x-total-size']).toBe('12345')
    expect(res).toEqual({ complete: true })
  })

  it('every op POSTs a path declared in the files-internal contract', async () => {
    const declared = new Set(Object.keys(CONTRACT.paths))
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(contractPath(String(url)))
      // propfind expects {entries}; others tolerate {} — return a superset.
      return jsonRes({ entries: [], success: true, complete: false })
    })
    const c = new ServiceFilesClient({ fetchImpl })
    await c.propfind('/p', 'u')
    await c.download('/p', 'u')
    await c.upload('/p', 'u', 'bytes', 'text/plain')
    await c.mkcol('/p', 'u')
    await c.delete('/p', 'u')
    await c.move('/a', '/b', 'u')
    await c.copy('/a', '/b', 'u')
    await c.uploadChunk({ userId: 'u', uploadId: 'x', chunkIndex: 0, totalChunks: 1, sanitizedPath: 'f', totalSize: null, body: null })
    for (const p of seen) expect(declared.has(p), `contract missing ${p}`).toBe(true)
    expect(seen).toHaveLength(8)
  })

  it('retries a propfind once on a 503, then succeeds (idempotent read)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonRes({ entries: [] }))
    const c = new ServiceFilesClient({ fetchImpl })
    expect(await c.propfind('/p', 'u')).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a move (write) and throws FilesServiceError on 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream boom', { status: 502 }))
    const c = new ServiceFilesClient({ fetchImpl })
    await expect(c.move('/a', '/b', 'u')).rejects.toBeInstanceOf(FilesServiceError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed when INTERNAL_FILES_SECRET is unset', async () => {
    delete process.env.INTERNAL_FILES_SECRET
    const fetchImpl = vi.fn(async () => jsonRes({ entries: [] }))
    const c = new ServiceFilesClient({ fetchImpl })
    await expect(c.propfind('/p', 'u')).rejects.toThrow(/INTERNAL_FILES_SECRET/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
