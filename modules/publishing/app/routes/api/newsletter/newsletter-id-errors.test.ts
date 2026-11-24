// @vitest-environment node
// A newsletter id that names nothing answers 404, never 500. Two holes let one
// through: `parseInt` reads the leading digits of any string (an id like "0abc"
// became 0, "1abc" became newsletter 1), and the leaf answers 400 "invalid
// newsletter id" for an id it refuses, which the client only mapped for 404, so
// the plain error reached SvelteKit as a 500. These cases run the REAL service
// client against a stubbed leaf with the leaf's own id rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isHttpError } from '@sveltejs/kit'

vi.mock('$lib/auth', () => ({
  hasRole: () => true,
  Role: { Finance: 'finance', ITAdmin: 'it-admin', CouncilAdmin: 'council-admin' },
}))
vi.mock('$lib/server/tenant/context', () => ({ getTenant: () => ({ id: 'tenant-a', slug: 'tenant-a' }) }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: vi.fn() }))
vi.mock('$lib/server/rate-limit', () => ({ requireNewsletterSendNowRateLimit: () => null }))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => ({}) }))
vi.mock('$lib/server/files/nextcloud-client', () => ({ createNextcloudClient: () => ({}) }))
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: () => undefined }))

const NEWSLETTER = { id: 1, title: 'T', subject: 'S', status: 'draft', odt_path: '/p.odt', created_by: 'u' }

/** The leaf as it behaves: 400 for an id that is not a positive integer, 404 for an unknown one. */
function leaf() {
  return vi.fn(async (url: string) => {
    const m = /\/api\/v1\/newsletters\/([^/]+)(\/recipients)?$/.exec(String(url))
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (!m) return json(404, { error: 'not found' })
    const n = Number(m[1])
    if (!Number.isInteger(n) || n <= 0) return json(400, { error: 'invalid newsletter id' })
    if (n !== 1) return json(404, { error: 'not found' })
    return json(200, { data: m[2] ? [] : NEWSLETTER })
  })
}

const locals = { user: { id: 'u', roles: ['finance'] }, tenant: undefined }
const event = (id: string, method = 'GET', body?: unknown) =>
  ({
    params: { id },
    locals,
    url: new URL('http://localhost/x'),
    request: new Request('http://localhost/x', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  }) as never

beforeEach(() => {
  process.env.NEWSLETTER_SERVICE_URL = 'http://leaf.test'
  process.env.INTERNAL_NEWSLETTER_SECRET = 'secret'
  vi.stubGlobal('fetch', leaf())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.NEWSLETTER_SERVICE_URL
  delete process.env.INTERNAL_NEWSLETTER_SECRET
})

// "0" and "0abc": the leaf refuses them (400). "1abc": parseInt used to turn it into newsletter 1.
// "99999": a well-formed id nobody owns (leaf 404). "abc": not a number at all.
const NAMES_NOTHING = ['0', '0abc', '1abc', '-3', '99999', 'abc', '3f0c9c1e-6a53-4f6e-9a3b-2f4a1c7d8e90']

type Handler = (e: never) => Promise<Response> | Response
async function status(h: Handler, id: string, method = 'GET', body?: unknown): Promise<number> {
  try {
    return (await h(event(id, method, body))).status
  } catch (e) {
    // Only a SvelteKit HttpError keeps its status; any other throw is a 500 to the caller.
    return isHttpError(e) ? e.status : 500
  }
}

describe('single-newsletter API routes answer 404 for an id that names nothing', () => {
  it.each(NAMES_NOTHING)('GET /api/newsletter/%s', async (id) => {
    const { GET } = await import('./[id]/+server')
    expect(await status(GET as Handler, id)).toBe(404)
  })
  it.each(NAMES_NOTHING)('PATCH /api/newsletter/%s', async (id) => {
    const { PATCH } = await import('./[id]/+server')
    expect(await status(PATCH as Handler, id, 'PATCH', { subject: 'neu' })).toBe(404)
  })
  it.each(NAMES_NOTHING)('GET /api/newsletter/%s/preview', async (id) => {
    const { GET } = await import('./[id]/preview/+server')
    expect(await status(GET as Handler, id)).toBe(404)
  })
  it.each(NAMES_NOTHING)('GET /api/newsletter/%s/wopi-token', async (id) => {
    const { GET } = await import('./[id]/wopi-token/+server')
    expect(await status(GET as Handler, id)).toBe(404)
  })
  it.each(NAMES_NOTHING)('POST /api/newsletter/%s/schedule', async (id) => {
    const { POST } = await import('./[id]/schedule/+server')
    const at = new Date(Date.now() + 3600_000).toISOString()
    expect(await status(POST as Handler, id, 'POST', { scheduled_at: at })).toBe(404)
  })
  it.each(NAMES_NOTHING)('POST /api/newsletter/%s/send-now', async (id) => {
    const { POST } = await import('./[id]/send-now/+server')
    expect(await status(POST as Handler, id, 'POST')).toBe(404)
  })
})

describe('list routes refuse an id the leaf would refuse, as a client error', () => {
  it.each(['0', '1abc', '-2'])('DELETE /api/newsletter/lists/%s is 4xx', async (id) => {
    const { DELETE } = await import('./lists/[id]/+server')
    const s = await status(DELETE as Handler, id, 'DELETE')
    expect(s).toBeGreaterThanOrEqual(400)
    expect(s).toBeLessThan(500)
  })
  it.each(['0', '1abc'])('GET /api/newsletter/lists/%s/members is 4xx', async (id) => {
    const { GET } = await import('./lists/[id]/members/+server')
    const s = await status(GET as Handler, id)
    expect(s).toBeGreaterThanOrEqual(400)
    expect(s).toBeLessThan(500)
  })
})

describe('a valid id behaves as before', () => {
  it('GET /api/newsletter/1 answers 200 with the newsletter', async () => {
    const { GET } = await import('./[id]/+server')
    const res = await (GET as Handler)(event('1'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { id: number } }).data.id).toBe(1)
  })
})
