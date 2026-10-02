// modules/files/test/webdav-client.test.ts
// F1-FIX-03 guards for the files leaf's WebDAV client and its HTTP surface:
//
//   K5#2 (DOWNGRADED) / S4#24: the chunked-upload MOVE Destination was built from
//     the DECODED path with no re-encoding: '#' / '?' cut the name (fragment /
//     query) and a non-Latin-1 character (an en dash) is not even a legal header
//     value. The same raw concatenation built the move/copy Destination and every
//     request URL.
//   K5#3 / K5#32 (kernel twins of S4#1): a browser op without x-webdav-bearer
//     silently fell back to the Nextcloud ADMIN Basic credentials, and only 1 of
//     the 8 ops validated its path; the rest forwarded any string by concatenation.
//
// Post-conditions: every path is validated (prefix /remote.php/dav/files/<user>/,
// no '..', canonical user segment) and sent with each segment encoded exactly
// once; a browser op without the user's bearer is a 401 and never reaches
// Nextcloud; the admin credentials are used ONLY by the system-scoped
// upload-chunk op.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebdavClient } from '../src/nextcloud/webdav-client.ts'
import { createServer } from '../src/http/server.ts'

const BASE = 'http://nc.test'
const ADMIN_BASIC = 'Basic ' + Buffer.from('admin:admin-pw').toString('base64')

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

let calls: Call[] = []

const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v
  calls.push({ url, method: init?.method ?? 'GET', headers })
  if (init?.method === 'PROPFIND') {
    return new Response(
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
      { status: 207, headers: { 'content-type': 'application/xml' } },
    )
  }
  return new Response('ok', { status: 201 })
}) as typeof fetch

function client(): WebdavClient {
  return new WebdavClient({ baseUrl: BASE, adminUser: 'admin', adminPassword: 'admin-pw' })
}

// The client calls the global fetch; the HTTP-surface tests below talk to the
// leaf over node:http, so stubbing the global touches only the Nextcloud side.
beforeAll(() => {
  vi.stubGlobal('fetch', stubFetch)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  calls = []
})

const WEIRD = 'a #1 ?x – y.pdf'
const WEIRD_ENC = 'a%20%231%20%3Fx%20%E2%80%93%20y.pdf'

describe('MOVE destination encoding (K5#2, S4#24)', () => {
  it('the chunked-upload assemble MOVE lands under the EXACT name (# ? space en-dash)', async () => {
    const r = await client().uploadChunk({
      userId: 'alice',
      uploadId: 'up-1',
      chunkIndex: 0,
      totalChunks: 1,
      sanitizedPath: `Ordner/${WEIRD}`,
      totalSize: '3',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(r).toEqual({ complete: true })
    const move = calls.find((c) => c.method === 'MOVE')
    expect(move).toBeDefined()
    expect(move!.headers.Destination).toBe(`${BASE}/remote.php/dav/files/alice/Ordner/${WEIRD_ENC}`)
    expect(decodeURIComponent(new URL(move!.headers.Destination).pathname)).toBe(
      `/remote.php/dav/files/alice/Ordner/${WEIRD}`,
    )
    // A legal header value: nothing outside printable ASCII.
    expect(move!.headers.Destination).toMatch(/^[\x21-\x7e]+$/)
    // upload-chunk is the one system-scoped op: admin Basic, by design.
    expect(move!.headers.Authorization).toBe(ADMIN_BASIC)
  })

  it('move() and copy() send an encoded source URL and an encoded Destination', async () => {
    await client().move('/remote.php/dav/files/alice/Alt #1.pdf', `/remote.php/dav/files/alice/${WEIRD}`, 'tok')
    await client().copy('/remote.php/dav/files/alice/Alt #1.pdf', `/remote.php/dav/files/alice/${WEIRD}`, 'tok')
    expect(calls.map((c) => [c.method, c.url, c.headers.Destination])).toEqual([
      ['MOVE', `${BASE}/remote.php/dav/files/alice/Alt%20%231.pdf`, `${BASE}/remote.php/dav/files/alice/${WEIRD_ENC}`],
      ['COPY', `${BASE}/remote.php/dav/files/alice/Alt%20%231.pdf`, `${BASE}/remote.php/dav/files/alice/${WEIRD_ENC}`],
    ])
    for (const c of calls) expect(c.headers.Authorization).toBe('Bearer tok')
  })

  it('a download of a name with # and ? reaches that file, not a truncated one', async () => {
    await client().download('/remote.php/dav/files/alice/Q&A #3?.pdf', 'tok')
    expect(calls[0].url).toBe(`${BASE}/remote.php/dav/files/alice/Q%26A%20%233%3F.pdf`)
  })

  it('an encoded user segment (e.g. an e-mail style name) is kept as sent, not double-encoded', async () => {
    await client().propfind('/remote.php/dav/files/jane%40example.org/', 'tok')
    expect(calls[0].url).toBe(`${BASE}/remote.php/dav/files/jane%40example.org/`)
  })
})

// ── The HTTP surface: bearer required, every path validated ─────────────────

const SECRET = 'leaf-secret'
const GUARD = {
  'x-internal-auth': SECRET,
  'x-tenant-id': '11111111-1111-1111-1111-111111111111',
  'x-tenant-slug': 'alpha',
}

let server: http.Server
let port: number

beforeAll(async () => {
  server = createServer({ secret: SECRET, client: client() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** node:http, not fetch: the leaf's client is stubbed, the transport is real. */
function post(path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { ...GUARD, ...headers } },
      (res) => {
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const JSON_H = { 'content-type': 'application/json' }
const OK_PATH = '/remote.php/dav/files/alice/Bericht.pdf'

describe('browser ops require the user bearer: no admin fallback (K5#3, K5#32)', () => {
  const ops: Array<[string, Record<string, string>, string]> = [
    ['/api/v1/propfind', JSON_H, JSON.stringify({ path: '/remote.php/dav/files/alice/', user: 'alice' })],
    ['/api/v1/download', JSON_H, JSON.stringify({ path: OK_PATH, user: 'alice' })],
    ['/api/v1/mkcol', JSON_H, JSON.stringify({ path: '/remote.php/dav/files/alice/Neu', user: 'alice' })],
    ['/api/v1/delete', JSON_H, JSON.stringify({ path: OK_PATH, user: 'alice' })],
    ['/api/v1/move', JSON_H, JSON.stringify({ from: OK_PATH, to: '/remote.php/dav/files/alice/B.pdf', user: 'alice' })],
    ['/api/v1/copy', JSON_H, JSON.stringify({ from: OK_PATH, to: '/remote.php/dav/files/alice/B.pdf', user: 'alice' })],
    ['/api/v1/upload', { 'content-type': 'text/plain', 'x-webdav-path': OK_PATH }, 'hello'],
  ]
  for (const [op, headers, body] of ops) {
    it(`${op} without x-webdav-bearer is a 401 and never reaches Nextcloud`, async () => {
      const r = await post(op, headers, body)
      expect(r.status).toBe(401)
      expect(calls).toEqual([])
    })
    it(`${op} with the bearer reaches Nextcloud AS the user`, async () => {
      const r = await post(op, { ...headers, 'x-webdav-bearer': 'user-tok' }, body)
      expect(r.status).toBe(200)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) expect(c.headers.Authorization).toBe('Bearer user-tok')
    })
  }
})

describe('every path is validated before it reaches Nextcloud (K5#3, K5#32)', () => {
  const BAD_PATHS = [
    '/ocs/v2.php/cloud/users',
    '/remote.php/dav/files/alice/../bob/secret.pdf',
    '/remote.php/dav/files/alice/%2e%2e/bob/secret.pdf',
    '/remote.php/dav/files/../x',
    '/remote.php/dav/files//x',
    '/remote.php/dav/uploads/alice/up-1/.file',
    'http://evil.example/remote.php/dav/files/alice/x',
    '//evil.example/remote.php/dav/files/alice/x',
  ]
  for (const bad of BAD_PATHS) {
    it(`propfind of '${bad}' is a 400 and nothing is fetched`, async () => {
      const r = await post('/api/v1/propfind', { ...JSON_H, 'x-webdav-bearer': 'tok' }, JSON.stringify({ path: bad, user: 'alice' }))
      expect(r.status).toBe(400)
      expect(calls).toEqual([])
    })
  }

  it('a move whose DESTINATION escapes the user tree is a 400 and nothing is fetched', async () => {
    const r = await post(
      '/api/v1/move',
      { ...JSON_H, 'x-webdav-bearer': 'tok' },
      JSON.stringify({ from: OK_PATH, to: '/remote.php/dav/files/alice/../../../../ocs/x', user: 'alice' }),
    )
    expect(r.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('a copy whose destination is not a string is a 400', async () => {
    const r = await post(
      '/api/v1/copy',
      { ...JSON_H, 'x-webdav-bearer': 'tok' },
      JSON.stringify({ from: OK_PATH, to: 42, user: 'alice' }),
    )
    expect(r.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('an upload whose x-webdav-path traverses is a 400', async () => {
    const r = await post(
      '/api/v1/upload',
      { 'content-type': 'text/plain', 'x-webdav-path': '/remote.php/dav/files/alice/../bob/x.txt', 'x-webdav-bearer': 'tok' },
      'x',
    )
    expect(r.status).toBe(400)
    expect(calls).toEqual([])
  })
})
