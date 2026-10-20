// @vitest-environment node
// gremion-ui/src/routes/api/newsletter/[id]/send-now/send-now.service.test.ts
//
// Runs in the `node` environment (not the suite-default jsdom): the service-mode
// send-now path drives the ServiceNewsletterClient, whose native undici `fetch`
// rejects jsdom's realm-foreign AbortSignal ("RequestInit: Expected signal ...
// to be an instance of AbortSignal"). The `node` env keeps the native
// fetch/AbortSignal pair consistent. This handler test uses a node:http stub and
// no DOM, matching the sibling server-only specs that carry this pragma.
//
// F-CRIT regression suite: the send-now route in NEWSLETTER_BACKEND=service mode.
//
// Before the fix, the route called backend.claimNewsletterForSending(id), which
// the ServiceNewsletterClient throws NotSupportedViaServiceError for → an
// uncaught 500 on the PRIMARY admin "Send Now" action (and the T22 cutover
// smoke). The fix makes the route service-aware (via backend.kind === 'service'):
// it skips the local claim and calls dispatchNow (→ leaf POST /send), mapping a
// leaf 409 to the same 409 the SQLite path returns and a 404 to 404 — NEVER a 500.
//
// Strategy: stand up a real node:http stub leaf, point NEWSLETTER_SERVICE_URL at
// it, set NEWSLETTER_BACKEND=service, and drive the route handler directly. We
// mock audit-db and keycloak-admin (the service path never reaches SMTP/KC) and
// the tenant ALS (the route is called outside hooks.server.ts).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { __resetRateLimits } from '$lib/server/rate-limit'
import { Role } from '$lib/auth'

// Postgres audit dual-write — mocked so the test needs no live DB.
const writeAuditEntryMock = vi.fn().mockResolvedValue(undefined)
vi.mock('$lib/server/audit-db', () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntryMock(...args),
}))

// Keycloak admin — the service path builds a group fetcher but the leaf resolves
// groups itself, so getGroupMembers is never actually called. Stub it anyway.
const getGroupMembersSpy = vi.fn().mockResolvedValue([])
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getGroupMembers: getGroupMembersSpy }),
}))

// Tenant ALS — the service client reads getTenant() on each call to build the
// x-tenant-* headers. currentTenantId() feeds the rate-limit helper.
vi.mock('$lib/server/tenant/context', () => ({
  currentTenantId: () => 'tenant-uuid-test',
  getTenant: () => ({ id: 'tenant-uuid-test', slug: 'test-tenant' }),
}))

const { POST } = await import('./+server')

const ADMIN_USER = {
  id: 'admin-user-uuid',
  email: 'admin@example.org',
  name: 'Admin',
  roles: [Role.ITAdmin],
  groups: [],
}

function callPost(id: string, user = ADMIN_USER): Promise<Response> {
  return Promise.resolve(
    POST({
      params: { id },
      locals: { user, tenant: { id: 'tenant-uuid-test', slug: 'test-tenant' } },
    } as never) as unknown as Response | Promise<Response>
  ) as Promise<Response>
}

// ── Stub leaf server ──────────────────────────────────────────────────────────

interface LeafRoute {
  status: number
  body: unknown
}

let server: Server
let port: number
// Maps "METHOD url-prefix" → response. Matched by longest prefix.
let routes: Map<string, LeafRoute>
const requests: Array<{ method: string; url: string }> = []

function setRoute(method: string, urlPrefix: string, status: number, body: unknown) {
  routes.set(`${method} ${urlPrefix}`, { status, body })
}

function matchRoute(method: string, url: string): LeafRoute | undefined {
  let best: LeafRoute | undefined
  let bestLen = -1
  for (const [key, route] of routes) {
    const [m, prefix] = key.split(' ')
    if (m === method && url.startsWith(prefix!) && prefix!.length > bestLen) {
      best = route
      bestLen = prefix!.length
    }
  }
  return best
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Drain the body (the route POSTs JSON).
    req.on('data', () => {})
    req.on('end', () => {
      const method = req.method ?? 'GET'
      const url = req.url ?? '/'
      requests.push({ method, url })
      const route = matchRoute(method, url) ?? { status: 404, body: { success: false, error: 'no stub route' } }
      res.writeHead(route.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(route.body))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

const NL = { id: 5, title: 'T', subject: 'S', status: 'draft', odt_path: '/t.odt', created_by: 'creator' }

beforeEach(() => {
  __resetRateLimits()
  process.env.NEWSLETTER_BACKEND = 'service'
  process.env.NEWSLETTER_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.INTERNAL_NEWSLETTER_SECRET = 'test-secret-1234'
  routes = new Map()
  requests.length = 0
  writeAuditEntryMock.mockClear()
  writeAuditEntryMock.mockResolvedValue(undefined)
  getGroupMembersSpy.mockClear()
  // Default stub wiring: getNewsletter, audit, recipients all succeed.
  setRoute('GET', '/api/v1/newsletters/5', 200, { success: true, data: NL })
  setRoute('POST', '/api/v1/newsletters/5/audit', 200, { success: true })
  setRoute('GET', '/api/v1/newsletters/5/recipients', 200, { success: true, data: [] })
})

afterAll(() => {
  delete process.env.NEWSLETTER_BACKEND
})

describe('POST /api/newsletter/[id]/send-now — NEWSLETTER_BACKEND=service (F-CRIT)', () => {
  it('happy path: leaf accepts (POST /send → 202) → route returns 202, NO 500/throw', async () => {
    setRoute('POST', '/api/v1/newsletters/5/send', 202, {
      success: true,
      data: { newsletterId: 5, status: 'sending' },
    })

    const res = await callPost('5')
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: { queued: true } })

    // It went through the leaf POST /send (did NOT throw on a local claim).
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/newsletters/5/send')).toBe(true)
    // Audit recorded on the accepted send (leaf audit endpoint + postgres dual-write).
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/newsletters/5/audit')).toBe(true)
    expect(writeAuditEntryMock).toHaveBeenCalledTimes(1)
  })

  it('already-sending: leaf POST /send → 409 → route returns 409 (same body as sqlite), NO 500/throw', async () => {
    setRoute('POST', '/api/v1/newsletters/5/send', 409, {
      success: false,
      error: 'newsletter already sending or sent',
    })

    const res = await callPost('5')
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toEqual({
      success: false,
      error: `Cannot send newsletter with status 'draft'`,
    })

    // No audit on a rejected (409) send — matches the sqlite lost-claim path.
    expect(requests.some((r) => r.url === '/api/v1/newsletters/5/audit')).toBe(false)
    expect(writeAuditEntryMock).not.toHaveBeenCalled()
  })

  it('newsletter missing: getNewsletter → 404 → route returns 404 (before any send)', async () => {
    setRoute('GET', '/api/v1/newsletters/5', 404, { success: false, error: 'not found' })

    const res = await callPost('5')
    expect(res.status).toBe(404)
    expect(requests.some((r) => r.url === '/api/v1/newsletters/5/send')).toBe(false)
  })

  it('leaf 5xx on send → route returns 503 (graceful), NOT an uncaught 500', async () => {
    setRoute('POST', '/api/v1/newsletters/5/send', 500, { success: false, error: 'boom' })

    const res = await callPost('5')
    expect(res.status).toBe(503)
  })

  it('does NOT throw NotSupportedViaServiceError (the F-CRIT regression)', async () => {
    setRoute('POST', '/api/v1/newsletters/5/send', 202, {
      success: true,
      data: { newsletterId: 5, status: 'sending' },
    })
    // If the route still called claimNewsletterForSending, the service client
    // would throw NotSupportedViaServiceError and this would reject / 500.
    const res = await callPost('5')
    expect(res.status).not.toBe(500)
    expect(res.status).toBe(202)
  })
})
