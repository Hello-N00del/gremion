// The whole path of one link-base call: the REAL element-0 resolver selects the tenant from the
// x-tenant-id the leaf sends, and the REAL handler answers with THAT tenant's primary host. A handler
// test with a hand-set `locals.tenant` cannot show that two customers' calls do not cross.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROXY_SECRET = 'proxy-trust-secret-32-bytes-padxx'
const NL_SECRET = 'newsletter-secret-32-bytes-of-padxx'

vi.mock('$env/dynamic/private', () => ({
  env: { TENANT_PROXY_SHARED_SECRET: PROXY_SECRET },
}))

interface Ctx {
  id: string
  slug: string
  primaryHost: string | null
}
const TENANT_A: Ctx = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', slug: 'rat-a', primaryHost: 'a.example.org' }
const TENANT_B: Ctx = { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', slug: 'rat-b', primaryHost: 'b.example.org' }
const NO_HOST: Ctx = { id: 'cccccccc-3333-4333-8333-cccccccccccc', slug: 'rat-c', primaryHost: null }
const BY_ID: Record<string, Ctx> = { [TENANT_A.id]: TENANT_A, [TENANT_B.id]: TENANT_B, [NO_HOST.id]: NO_HOST }

vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantByHost: async () => null,
  getTenantStatusByHost: async () => null,
  resolveTenantById: async (id: string) => BY_ID[id] ?? null,
}))
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => true,
  getTenantReadiness: () => 'ready',
  triggerTenantMigrationRetry: vi.fn(),
}))
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: () => ({ allowed: true }),
}))

const { tenantResolveHandle } = await import('$lib/server/tenant/resolve')
const { GET } = await import('./+server')

/** What a leaf sends: its identity and its own secret, nothing host-shaped. */
async function leafAsks(tenant: Ctx, secret = NL_SECRET): Promise<Response> {
  const url = new URL('http://gremion-ui:3000/api/internal/newsletter/link-base')
  const request = new Request(url, {
    method: 'GET',
    headers: { 'x-internal-auth': secret, 'x-tenant-id': tenant.id, 'x-tenant-slug': tenant.slug },
  })
  const locals: Record<string, unknown> = {}
  return (await tenantResolveHandle({
    event: { url, request, locals, params: {} } as never,
    resolve: async (event: { locals: unknown }) => GET({ request, locals: event.locals } as never),
  } as never)) as Response
}

beforeEach(() => {
  process.env.INTERNAL_NEWSLETTER_SECRET = NL_SECRET
})

describe('newsletter link-base through the element-0 resolver', () => {
  it('two customers on one leaf each get their own host, back to back', async () => {
    const a = await leafAsks(TENANT_A)
    expect(a.status).toBe(200)
    expect(await a.json()).toEqual({ origin: 'https://a.example.org' })

    const b = await leafAsks(TENANT_B)
    expect(b.status).toBe(200)
    expect(await b.json()).toEqual({ origin: 'https://b.example.org' })

    const again = await leafAsks(TENANT_A)
    expect(await again.json()).toEqual({ origin: 'https://a.example.org' })
  })

  it('a customer without a primary host gets a 404, not the host of another customer', async () => {
    const res = await leafAsks(NO_HOST)
    expect(res.status).toBe(404)
  })

  it('a wrong secret never reaches the handler: the resolver refuses it first', async () => {
    const res = await leafAsks(TENANT_A, 'not-the-secret')
    expect(res.status).toBe(403)
  })
})
