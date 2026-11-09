/**
 * Cross-customer isolation of the files module, on the code path the pilot runs
 * (isolation:tenant, kind `fake-upstream-app`).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The pilot runs files in-process
 * (FILES_BACKEND unset): the real route handlers and the real NextcloudClient /
 * InprocessFilesClient talk to ONE shared Nextcloud. Customers are told apart
 * by the caller's own session: its Keycloak user id is the Nextcloud user id
 * (user_oidc --unique-uid=0) and its access token is the WebDAV bearer. So the
 * app-layer promise under test is exactly this:
 *
 *   every upstream request a caller can cause carries that caller's own bearer
 *   (or, for the chunked upload, the admin credential on a URL that names that
 *   caller's own upload and files folder), and its WebDAV path, normalised the
 *   way fetch normalises it, stays under /remote.php/dav/files/<caller>/ .
 *
 * The upstream here is a RECORDING FAKE that enforces what Nextcloud enforces
 * (a user bearer reads and writes only its own folder) and records every
 * request after URL normalisation. It shows app-layer scoping against ONE
 * shared Nextcloud. It does NOT show that a second customer can be added to a
 * running installation, nor Nextcloud's own authorisation (docs/ops/
 * isolation-evidence.md says so; a live two-customer probe is owed).
 *
 * Route coverage is derived from the route table on disk
 * (routes/api/files/** /+server.ts): every exported method must have at least
 * one positive control and one attack, or the last test fails. A zero-attempt
 * run fails too. Positive controls run first; if one fails nothing after it
 * means anything.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'

const NC_ENV: Record<string, string> = {
  NEXTCLOUD_URL: 'http://nc.test',
  NEXTCLOUD_ADMIN_USER: 'admin',
  NEXTCLOUD_ADMIN_PASSWORD: 'admin-pw',
}
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => NC_ENV[name] }))

import { GET as listOrDownload, PUT, DELETE, PATCH } from '../../../routes/api/files/[...path]/+server'
import { POST as uploadChunk } from '../../../routes/api/files/upload-chunk/+server'
import { GET as editToken } from '../../../routes/api/files/edit-token/[...path]/+server'
import { getFilesBackend } from './backend'
import { createNextcloudClient } from './nextcloud-client'

// ---- the two customers' users ------------------------------------------------

const A_ID = 'a1a1a1a1-0000-4000-8000-00000000000a'
const B_ID = 'b2b2b2b2-0000-4000-8000-00000000000b'
const TOKENS: Record<string, string> = { 'tok-A': A_ID, 'tok-B': B_ID }
const A_ROOT = `/remote.php/dav/files/${A_ID}`
const B_ROOT = `/remote.php/dav/files/${B_ID}`
const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)

const user = (id: string, roles: Role[] = [Role.Member]): SessionUser => ({ id, email: '', name: id, roles, groups: [], loa: 0, authTime: 0 }) as SessionUser
const A = user(A_ID)
const B = user(B_ID)

// ---- the recording fake Nextcloud --------------------------------------------

interface Recorded {
  method: string
  /** decoded pathname, after the normalisation fetch applies (.. and %2e%2e collapse, \ is /) */
  path: string
  auth: string | null
  destination: string | null
  impersonate: string | null
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')

class FakeNextcloud {
  readonly files = new Map<string, string>()
  readonly chunks = new Map<string, string[]>()
  readonly requests: Recorded[] = []
  private readonly fileIds = new Map<number, string>()
  private nextId = 100

  seed(uid: string, rel: string, content: string): void {
    this.files.set(`/remote.php/dav/files/${uid}/${rel}`, content)
    const id = this.nextId++
    this.fileIds.set(id, `/remote.php/dav/files/${uid}/${rel}`)
  }
  read(uid: string, rel: string): string | undefined {
    return this.files.get(`/remote.php/dav/files/${uid}/${rel}`)
  }
  mark(): number {
    return this.requests.length
  }
  since(mark: number): Recorded[] {
    return this.requests.slice(mark)
  }

  private who(auth: string | null): { kind: 'user'; uid: string } | { kind: 'admin' } | null {
    if (!auth) return null
    if (auth.startsWith('Bearer ')) {
      const uid = TOKENS[auth.slice('Bearer '.length)]
      return uid ? { kind: 'user', uid } : null
    }
    if (auth.startsWith('Basic ')) return Buffer.from(auth.slice('Basic '.length), 'base64').toString() === 'admin:admin-pw' ? { kind: 'admin' } : null
    return null
  }

  async handle(input: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(input)
    const path = decodeURIComponent(u.pathname)
    const h = new Headers(init.headers as HeadersInit)
    const dest = h.get('Destination')
    const rec: Recorded = {
      method: String(init.method ?? 'GET'),
      path,
      auth: h.get('Authorization'),
      destination: dest ? decodeURIComponent(new URL(dest).pathname) : null,
      impersonate: h.get('X-Nextcloud-User'),
    }
    this.requests.push(rec)
    // The single-use direct-view page carries its token in the path and no credential.
    if (rec.method === 'GET' && path === '/apps/richdocuments/direct/abc') {
      return new Response(
        `<input type="hidden" id="initial-state-richdocuments-document" value="${b64({ token: 'wopi-tok', token_ttl: 1999999999, urlsrc: 'https://office.test/browser/x/cool.html?', fileId: '42' })}">` +
          `<input type="hidden" id="initial-state-richdocuments-wopi_callback_url" value="${b64('http://nc.test')}">`,
        { status: 200 },
      )
    }
    const who = this.who(rec.auth)
    if (!who) return new Response('unauthenticated', { status: 401 })
    const mayTouch = (p: string): boolean => {
      const m = /^\/remote\.php\/dav\/(?:files|uploads)\/([^/]+)/.exec(p)
      if (!m) return true
      return who.kind === 'admin' || who.uid === m[1]
    }
    if (!mayTouch(path) || (rec.destination !== null && !mayTouch(rec.destination))) return new Response('forbidden', { status: 403 })

    const m = rec.method
    if (path.startsWith('/remote.php/dav/files/')) {
      if (m === 'PROPFIND') {
        const body = await new Response(init.body as BodyInit).text()
        const wantsId = body.includes('oc:fileid')
        const key = path.replace(/\/$/, '')
        const isDir = [...this.files.keys()].some((k) => k.startsWith(`${key}/`)) || this.files.has(`${key}/`)
        if (!isDir && !this.files.has(key)) return new Response('not found', { status: 404 })
        if (wantsId) {
          const id = [...this.fileIds].find(([, p]) => p === key)?.[0] ?? 1
          return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>${id}</oc:fileid></d:prop></d:propstat></d:response></d:multistatus>`, { status: 207 })
        }
        const children = [...this.files.keys()].filter((k) => k.startsWith(`${key}/`) && !k.slice(key.length + 1).includes('/') && !k.endsWith('/'))
        const row = (href: string, coll: boolean) =>
          `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${href.replace(/\/$/, '').split('/').pop()}</d:displayname><d:getlastmodified>Mon, 09 Nov 2026 10:00:00 GMT</d:getlastmodified><d:getetag>"e"</d:getetag><d:resourcetype>${coll ? '<d:collection/>' : ''}</d:resourcetype></d:prop></d:propstat></d:response>`
        const rows = isDir ? [row(`${key}/`, true), ...children.map((k) => row(k, false))] : [row(key, false)]
        return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`, { status: 207 })
      }
      if (m === 'GET') {
        const body = this.files.get(path)
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 })
      }
      if (m === 'PUT') {
        this.files.set(path, await new Response(init.body as BodyInit).text())
        return new Response(null, { status: 201 })
      }
      if (m === 'MKCOL') {
        this.files.set(`${path}/`, '')
        return new Response(null, { status: 201 })
      }
      if (m === 'DELETE') {
        if (!this.files.has(path)) return new Response('not found', { status: 404 })
        this.files.delete(path)
        return new Response(null, { status: 204 })
      }
      if (m === 'MOVE' || m === 'COPY') {
        const body = this.files.get(path)
        if (body === undefined || !rec.destination) return new Response('not found', { status: 404 })
        this.files.set(rec.destination, body)
        if (m === 'MOVE') this.files.delete(path)
        return new Response(null, { status: 201 })
      }
    }
    const up = /^\/remote\.php\/dav\/uploads\/([^/]+)\/([^/]+)\/(.+)$/.exec(path)
    if (up) {
      const key = `${up[1]}/${up[2]}`
      if (m === 'PUT') {
        const list = this.chunks.get(key) ?? []
        list.push(await new Response(init.body as BodyInit).text())
        this.chunks.set(key, list)
        return new Response(null, { status: 201 })
      }
      if (m === 'MOVE' && up[3] === '.file' && rec.destination) {
        this.files.set(rec.destination, (this.chunks.get(key) ?? []).join(''))
        return new Response(null, { status: 201 })
      }
    }
    if (m === 'POST' && path === '/ocs/v2.php/apps/richdocuments/api/v1/document') {
      const fileId = Number(new URLSearchParams(String(init.body)).get('fileId'))
      const p = this.fileIds.get(fileId)
      if (!p || !mayTouch(p)) return new Response('forbidden', { status: 403 })
      return Response.json({ ocs: { data: { url: 'http://nc.test/apps/richdocuments/direct/abc' } } })
    }
    return new Response('not implemented in the fake', { status: 501 })
  }
}

let nc: FakeNextcloud

beforeEach(() => {
  delete process.env.FILES_BACKEND
  nc = new FakeNextcloud()
  nc.seed(A_ID, 'Docs/a-note.txt', 'canary-a-note')
  nc.seed(A_ID, 'Docs/a-doc.docx', 'canary-a-doc')
  nc.seed(B_ID, 'Docs/b-secret.txt', 'canary-b-secret')
  nc.seed(B_ID, 'Docs/b-secret.docx', 'canary-b-doc')
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => nc.handle(String(input), init)))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- route table, from disk ---------------------------------------------------

// (jsdom environment: import.meta.url is not a file: URL here, import.meta.dirname is)
const ROUTES_DIR = join(import.meta.dirname, '..', '..', '..', 'routes', 'api', 'files')

function routeTable(): string[] {
  const out: string[] = []
  const walk = (dir: string, url: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${url}/${e.name}`)
      else if (e.name === '+server.ts') {
        for (const m of readFileSync(join(dir, e.name), 'utf8').matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)) out.push(`${m[1]} ${url}`)
      }
    }
  }
  walk(ROUTES_DIR, '/api/files')
  return out.sort()
}

const controlled = new Set<string>()
const attacked = new Set<string>()
let attempts = 0

const R = {
  list: 'GET /api/files/[...path]',
  put: 'PUT /api/files/[...path]',
  del: 'DELETE /api/files/[...path]',
  patch: 'PATCH /api/files/[...path]',
  chunk: 'POST /api/files/upload-chunk',
  edit: 'GET /api/files/edit-token/[...path]',
} as const

// ---- request builders ---------------------------------------------------------

type Handler = (e: never) => unknown
function event(as: SessionUser, token: string, p: { path?: string; query?: string; method?: string; body?: BodyInit | null; headers?: Record<string, string>; route?: string }) {
  const base = p.route ?? '/api/files/'
  const url = new URL(`http://localhost${base}${p.path ?? ''}${p.query ?? ''}`)
  return {
    params: { path: p.path ?? '' },
    locals: { user: as, accessToken: token, accessTokenExpires: null },
    url,
    request: new Request(url, { method: p.method ?? 'GET', ...(p.body !== undefined && p.body !== null ? { body: p.body } : {}), ...(p.headers ? { headers: p.headers } : {}) }),
  } as never
}
const call = (h: Handler, e: never) => Promise.resolve(h(e))

/** Everything the attack caused must belong to the attacker: its bearer, its folder. */
function expectConfinedToA(reqs: Recorded[]): void {
  for (const r of reqs) {
    // the single-use direct-view page: its token is in the path, it carries no credential
    if (r.method === 'GET' && r.path.startsWith('/apps/richdocuments/direct/')) {
      expect(r.auth).toBeNull()
      continue
    }
    const isUser = r.auth === 'Bearer tok-A'
    const isAdminChunk = r.auth?.startsWith('Basic ') === true
    expect(isUser || isAdminChunk, `request ${r.method} ${r.path} carries ${r.auth}`).toBe(true)
    if (r.auth === 'Bearer tok-B') throw new Error('the caller sent the other customer\'s bearer')
    const ok = (p: string) => p === A_ROOT || p.startsWith(`${A_ROOT}/`) || p.startsWith(`/remote.php/dav/uploads/${A_ID}/`) || p.startsWith('/ocs/v2.php/apps/richdocuments/') || p.startsWith('/apps/richdocuments/')
    expect(ok(r.path), `${r.method} ${r.path} is outside the caller's folder`).toBe(true)
    if (r.destination !== null) expect(r.destination === A_ROOT || r.destination.startsWith(`${A_ROOT}/`), `destination ${r.destination} is outside the caller's folder`).toBe(true)
  }
}
const bIntact = () => {
  expect(nc.read(B_ID, 'Docs/b-secret.txt')).toBe('canary-b-secret')
  expect(nc.read(B_ID, 'Docs/b-secret.docx')).toBe('canary-b-doc')
  expect([...nc.files.keys()].filter((k) => k.startsWith(`${B_ROOT}/`)).sort()).toEqual([`${B_ROOT}/Docs/b-secret.docx`, `${B_ROOT}/Docs/b-secret.txt`])
}
const control = (route: string, fn: () => Promise<void>) => async () => {
  controlled.add(route)
  await fn()
}
const attack = (route: string, fn: () => Promise<void>) => async () => {
  attacked.add(route)
  attempts++
  await fn()
}

// The path strings the browser can put after /api/files/ (SvelteKit has decoded them once).
const TRAVERSALS: Array<[string, string]> = [
  ['dot-dot to the other customer', `../${B_ID}/Docs/b-secret.txt`],
  ['dot-dot in the middle', `Docs/../../${B_ID}/Docs/b-secret.txt`],
  ['percent-encoded dot-dot', `%2e%2e/${B_ID}/Docs/b-secret.txt`],
  ['double-encoded dot-dot and slash', `%252e%252e%252f${B_ID}/Docs/b-secret.txt`],
  ['backslash dot-dot (fetch turns it into /..)', `..${BS}${B_ID}/Docs/b-secret.txt`],
  ['backslash in the middle', `Docs${BS}..${BS}..${BS}${B_ID}/Docs/b-secret.txt`],
  ['encoded backslash dot-dot', `..%5C${B_ID}/Docs/b-secret.txt`],
  // fetch's URL parser deletes tab and newline anywhere in the path: `.<LF>.` becomes `..`
  ['newline inside a dot segment (fetch deletes it)', `.${NL}./${B_ID}/Docs/b-secret.txt`],
  ['encoded newline inside a dot segment', `.%0a./${B_ID}/Docs/b-secret.txt`],
  ['tab inside an encoded dot segment', `%2e%09%2e/${B_ID}/Docs/b-secret.txt`],
]

// ================================================================================
// 0. the backend the pilot runs
// ================================================================================

describe('the code path under test is the one the pilot runs', () => {
  it('FILES_BACKEND unset resolves to the in-process client, and each request builds its own client with its own bearer', () => {
    const a = getFilesBackend({ webdavBearer: 'tok-A' })
    const b = getFilesBackend({ webdavBearer: 'tok-B' })
    expect(a.kind).toBe('inprocess')
    expect(a).not.toBe(b)
    expect(createNextcloudClient({ webdavBearer: 'tok-A' })).not.toBe(createNextcloudClient({ webdavBearer: 'tok-B' }))
  })
})

// ================================================================================
// 1. positive controls: each customer reaches its own data through every route
// ================================================================================

describe('positive controls: A and B each reach their own data, with their own bearer, in their own folder', () => {
  it('GET list: A sees its own folder and nothing of B', async () => {
    controlled.add(R.list)
    const m = nc.mark()
    const res = (await call(listOrDownload, event(A, 'tok-A', { path: 'Docs' }))) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: { name: string }[] }
    expect(body.files.map((f) => f.name).sort()).toEqual(['a-doc.docx', 'a-note.txt'])
    const reqs = nc.since(m)
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.every((r) => r.method === 'PROPFIND' && r.path === `${A_ROOT}/Docs` && r.auth === 'Bearer tok-A')).toBe(true)
  })

  it('GET download: A reads its file, B reads its own (the fake does hold B data, so an attack that returns none means something)', async () => {
    controlled.add(R.list)
    const m = nc.mark()
    const a = (await call(listOrDownload, event(A, 'tok-A', { path: 'Docs/a-note.txt' }))) as Response
    expect(await a.text()).toBe('canary-a-note')
    expect(nc.since(m).every((r) => r.path === `${A_ROOT}/Docs/a-note.txt` && r.auth === 'Bearer tok-A')).toBe(true)
    const b = (await call(listOrDownload, event(B, 'tok-B', { path: 'Docs/b-secret.txt' }))) as Response
    expect(await b.text()).toBe('canary-b-secret')
  })

  it('PUT: A uploads and creates a folder, in its own folder; B is untouched', async () => {
    controlled.add(R.put)
    const m = nc.mark()
    await call(PUT, event(A, 'tok-A', { path: 'Docs/new.txt', method: 'PUT', body: 'hello', headers: { 'Content-Type': 'text/plain' } }))
    await call(PUT, event(A, 'tok-A', { path: 'Docs/sub', query: '?mkdir=true', method: 'PUT' }))
    expect(nc.read(A_ID, 'Docs/new.txt')).toBe('hello')
    expect(nc.files.has(`${A_ROOT}/Docs/sub/`)).toBe(true)
    expectConfinedToA(nc.since(m))
    bIntact()
  })

  it('DELETE: A deletes its own file', async () => {
    controlled.add(R.del)
    const m = nc.mark()
    await call(DELETE, event(A, 'tok-A', { path: 'Docs/a-note.txt', method: 'DELETE' }))
    expect(nc.read(A_ID, 'Docs/a-note.txt')).toBeUndefined()
    expectConfinedToA(nc.since(m))
    bIntact()
  })

  it('PATCH: A moves, renames and copies inside its own folder', async () => {
    controlled.add(R.patch)
    const m = nc.mark()
    const patch = (p: string, action: string, destination: string) =>
      call(PATCH, event(A, 'tok-A', { path: p, method: 'PATCH', body: JSON.stringify({ action, destination }) }))
    await patch('Docs/a-note.txt', 'copy', 'Docs/copy.txt')
    await patch('Docs/a-note.txt', 'move', 'Docs/moved.txt')
    await patch('Docs/moved.txt', 'rename', 'Docs/renamed.txt')
    expect(nc.read(A_ID, 'Docs/copy.txt')).toBe('canary-a-note')
    expect(nc.read(A_ID, 'Docs/renamed.txt')).toBe('canary-a-note')
    expect(nc.read(A_ID, 'Docs/a-note.txt')).toBeUndefined()
    expectConfinedToA(nc.since(m))
    bIntact()
  })

  it('POST upload-chunk: A assembles a two-chunk upload into its own folder, through its own upload session', async () => {
    controlled.add(R.chunk)
    const m = nc.mark()
    const post = (i: number, body: string) =>
      call(uploadChunk, event(A, 'tok-A', { route: '/api/files/upload-chunk', query: `?uploadId=up-1&chunkIndex=${i}&totalChunks=2&finalPath=Docs/big.bin&totalSize=6`, method: 'POST', body }))
    await post(0, 'abc')
    await post(1, 'def')
    expect(nc.read(A_ID, 'Docs/big.bin')).toBe('abcdef')
    const reqs = nc.since(m)
    expect(reqs.some((r) => r.path.startsWith(`/remote.php/dav/uploads/${A_ID}/up-1/`))).toBe(true)
    expectConfinedToA(reqs)
    bIntact()
  })

  it('GET edit-token: A gets an editor url for its own document', async () => {
    controlled.add(R.edit)
    const m = nc.mark()
    const res = (await call(editToken, event(A, 'tok-A', { route: '/api/files/edit-token/', path: 'Docs/a-doc.docx' }))) as Response
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; editorUrl: string }
    expect(body.token).toBe('wopi-tok')
    expectConfinedToA(nc.since(m))
  })
})

// ================================================================================
// 2. attacks, as A, against B's record
// ================================================================================

describe('GET /api/files/[...path]: A cannot read B', () => {
  for (const [what, p] of TRAVERSALS) {
    it(`${what}: refused before any upstream request`, attack(R.list, async () => {
      const m = nc.mark()
      await expect(call(listOrDownload, event(A, 'tok-A', { path: p }))).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
    }))
  }

  it("B's user id as a path under A's own folder reads nothing of B (404 from A's folder), and the request stays under A", attack(R.list, async () => {
    const m = nc.mark()
    for (const p of [`${B_ID}/Docs/b-secret.txt`, `/${B_ID}/Docs/b-secret.txt`, `//${B_ID}/Docs/b-secret.txt`]) {
      await expect(call(listOrDownload, event(A, 'tok-A', { path: p }))).rejects.toMatchObject({ status: 404 })
    }
    expectConfinedToA(nc.since(m))
    expect(nc.since(m).length).toBeGreaterThan(0)
  }))

  it("the Nextcloud answer is never B's data, whatever the path", attack(R.list, async () => {
    const m = nc.mark()
    const res = (await call(listOrDownload, event(A, 'tok-A', { path: 'Docs' }))) as Response
    expect(JSON.stringify(await res.json())).not.toContain('b-secret')
    expectConfinedToA(nc.since(m))
  }))

  it('a request carries exactly its caller bearer, also when A and B are served at the same time', attack(R.list, async () => {
    const m = nc.mark()
    await Promise.all([
      ...Array.from({ length: 8 }, () => call(listOrDownload, event(A, 'tok-A', { path: 'Docs/a-note.txt' }))),
      ...Array.from({ length: 8 }, () => call(listOrDownload, event(B, 'tok-B', { path: 'Docs/b-secret.txt' }))),
    ])
    const reqs = nc.since(m)
    expect(reqs).toHaveLength(16)
    for (const r of reqs) {
      expect(r.auth === 'Bearer tok-A' ? r.path.startsWith(`${A_ROOT}/`) : r.auth === 'Bearer tok-B' && r.path.startsWith(`${B_ROOT}/`)).toBe(true)
    }
  }))

  it('a guest-only session is answered without an upstream request at all', attack(R.list, async () => {
    const m = nc.mark()
    const res = (await call(listOrDownload, event(user(A_ID, [Role.Guest]), 'tok-A', { path: 'Docs' }))) as Response
    expect(res.status).toBe(403)
    expect(nc.since(m)).toEqual([])
  }))
})

describe('PUT /api/files/[...path]: A cannot write into B', () => {
  for (const [what, p] of TRAVERSALS) {
    it(`upload, ${what}: refused, B untouched`, attack(R.put, async () => {
      const m = nc.mark()
      await expect(call(PUT, event(A, 'tok-A', { path: p, method: 'PUT', body: 'planted', headers: { 'Content-Type': 'text/plain' } }))).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
      bIntact()
    }))
  }

  it('mkdir into B is refused, B untouched', attack(R.put, async () => {
    const m = nc.mark()
    await expect(call(PUT, event(A, 'tok-A', { path: `../${B_ID}/Docs/planted`, query: '?mkdir=true', method: 'PUT' }))).rejects.toMatchObject({ status: 400 })
    expect(nc.since(m)).toEqual([])
    bIntact()
  }))

  it("a write under B's id inside A's own folder lands in A, never in B", attack(R.put, async () => {
    const m = nc.mark()
    await call(PUT, event(A, 'tok-A', { path: `${B_ID}/Docs/planted.txt`, method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/plain' } }))
    expect(nc.read(A_ID, `${B_ID}/Docs/planted.txt`)).toBe('x')
    expectConfinedToA(nc.since(m))
    bIntact()
  }))

  it('a guest-only session cannot write: no upstream request', attack(R.put, async () => {
    const m = nc.mark()
    await expect(call(PUT, event(user(A_ID, [Role.Guest]), 'tok-A', { path: 'Docs/x.txt', method: 'PUT', body: 'x' }))).rejects.toMatchObject({ status: 403 })
    expect(nc.since(m)).toEqual([])
  }))
})

describe('DELETE /api/files/[...path]: A cannot delete from B', () => {
  for (const [what, p] of TRAVERSALS) {
    it(`${what}: refused, B untouched`, attack(R.del, async () => {
      const m = nc.mark()
      await expect(call(DELETE, event(A, 'tok-A', { path: p, method: 'DELETE' }))).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
      bIntact()
    }))
  }

  it("A's bearer against B's folder is refused by Nextcloud, even if a path reached it (the fake's own rule)", attack(R.del, async () => {
    const res = await nc.handle(`http://nc.test${B_ROOT}/Docs/b-secret.txt`, { method: 'DELETE', headers: { Authorization: 'Bearer tok-A' } })
    expect(res.status).toBe(403)
    bIntact()
  }))
})

describe('PATCH /api/files/[...path]: A cannot move or copy from or into B', () => {
  const patch = (p: string, action: string, destination: string) =>
    call(PATCH, event(A, 'tok-A', { path: p, method: 'PATCH', body: JSON.stringify({ action, destination }) }))

  for (const [what, p] of TRAVERSALS) {
    it(`source, ${what}: refused, no upstream request`, attack(R.patch, async () => {
      const m = nc.mark()
      await expect(patch(p, 'copy', 'Docs/stolen.txt')).rejects.toMatchObject({ status: 400 })
      await expect(patch(p, 'move', 'Docs/stolen.txt')).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
      expect(nc.read(A_ID, 'Docs/stolen.txt')).toBeUndefined()
      bIntact()
    }))
    it(`destination, ${what}: refused, no upstream request, A's file stays`, attack(R.patch, async () => {
      const m = nc.mark()
      for (const action of ['move', 'rename', 'copy']) await expect(patch('Docs/a-note.txt', action, p)).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
      expect(nc.read(A_ID, 'Docs/a-note.txt')).toBe('canary-a-note')
      bIntact()
    }))
  }

  it("a destination naming B's id lands under A's own folder", attack(R.patch, async () => {
    const m = nc.mark()
    await patch('Docs/a-note.txt', 'copy', `${B_ID}/Docs/b-secret.txt`)
    expect(nc.read(A_ID, `${B_ID}/Docs/b-secret.txt`)).toBe('canary-a-note')
    expectConfinedToA(nc.since(m))
    bIntact()
  }))

  it('an unknown action is refused before any upstream request', attack(R.patch, async () => {
    const m = nc.mark()
    await expect(patch('Docs/a-note.txt', 'link', 'Docs/x')).rejects.toMatchObject({ status: 400 })
    expect(nc.since(m)).toEqual([])
  }))
})

describe('POST /api/files/upload-chunk: the admin-credentialed chunk path cannot write outside the caller', () => {
  const post = (query: string, body = 'chunk') => call(uploadChunk, event(A, 'tok-A', { route: '/api/files/upload-chunk', query, method: 'POST', body }))
  const q = (o: Record<string, string>) => `?${new URLSearchParams({ uploadId: 'up-2', chunkIndex: '0', totalChunks: '1', finalPath: 'Docs/x.bin', ...o }).toString()}`

  for (const [what, p] of TRAVERSALS) {
    it(`finalPath, ${what}: refused before the first chunk leaves`, attack(R.chunk, async () => {
      const m = nc.mark()
      await expect(post(q({ finalPath: p }))).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
      bIntact()
    }))
  }

  it('uploadId carrying a path (to reach another upload session) is refused before any request', attack(R.chunk, async () => {
    const m = nc.mark()
    // `.` and `..` fit the id's character set and would climb out of the caller's upload folder.
    for (const id of [`../${B_ID}/up-3`, `${B_ID}/up-3`, `a${BS}b`, '..', '.', 'x y', '']) {
      await expect(post(q({ uploadId: id }))).rejects.toMatchObject({ status: expect.any(Number) })
    }
    expect(nc.since(m)).toEqual([])
    bIntact()
  }))

  it("a user id supplied by the caller (query) is ignored: the session's id names the upload session and the target", attack(R.chunk, async () => {
    const m = nc.mark()
    await post(q({ userId: B_ID, user: B_ID, finalPath: 'Docs/mine.bin' }))
    const reqs = nc.since(m)
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.every((r) => r.path.includes(A_ID) && !r.path.includes(B_ID) && !(r.destination ?? '').includes(B_ID))).toBe(true)
    expectConfinedToA(reqs)
    expect(nc.read(A_ID, 'Docs/mine.bin')).toBe('chunk')
    bIntact()
  }))

  it("a finalPath under B's id inside A's folder is assembled into A", attack(R.chunk, async () => {
    const m = nc.mark()
    await post(q({ finalPath: `${B_ID}/Docs/b-secret.txt` }))
    expect(nc.read(A_ID, `${B_ID}/Docs/b-secret.txt`)).toBe('chunk')
    expectConfinedToA(nc.since(m))
    bIntact()
  }))
})

describe('GET /api/files/edit-token/[...path]: A cannot obtain an editor session for B\'s document', () => {
  for (const [what, p] of TRAVERSALS) {
    it(`${what}: refused before any upstream request`, attack(R.edit, async () => {
      const m = nc.mark()
      await expect(call(editToken, event(A, 'tok-A', { route: '/api/files/edit-token/', path: p.replace('b-secret.txt', 'b-secret.docx') }))).rejects.toMatchObject({ status: 400 })
      expect(nc.since(m)).toEqual([])
    }))
  }

  it("B's id under A's folder resolves to nothing: 404 from A's folder, no editor session is created", attack(R.edit, async () => {
    const m = nc.mark()
    await expect(call(editToken, event(A, 'tok-A', { route: '/api/files/edit-token/', path: `${B_ID}/Docs/b-secret.docx` }))).rejects.toMatchObject({ status: 404 })
    const reqs = nc.since(m)
    expectConfinedToA(reqs)
    expect(reqs.some((r) => r.path.startsWith('/ocs/'))).toBe(false)
  }))

  it("A's bearer cannot mint an editor session for B's file id even when the id is known (Nextcloud's own rule, as the fake enforces it)", attack(R.edit, async () => {
    const res = await nc.handle('http://nc.test/ocs/v2.php/apps/richdocuments/api/v1/document?format=json', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-A', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'fileId=102',
    })
    expect(res.status).toBe(403)
  }))
})

// ================================================================================
// 3. coverage: the route table on disk against what was controlled and attacked
// ================================================================================

describe('coverage', () => {
  it('every route of routes/api/files/** has a positive control and an attack, and the run is not vacuous', () => {
    const table = routeTable()
    expect(table.length).toBeGreaterThan(0)
    expect(attempts).toBeGreaterThan(0)
    expect(table.filter((r) => !attacked.has(r))).toEqual([])
    expect(table.filter((r) => !controlled.has(r))).toEqual([])
    expect([...attacked, ...controlled].filter((r) => !table.includes(r))).toEqual([])
  })
})
