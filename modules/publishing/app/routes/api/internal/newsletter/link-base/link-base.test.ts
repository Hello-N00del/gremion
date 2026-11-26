// The newsletter leaf asks the kernel, PER SEND, which origin its links to the
// recipient must be built from. The answer is the primary host of THE TENANT THE
// CALL IS FOR: the element-0 resolver selects it from the x-tenant-id the leaf
// sends (tenant/leaf-trust.ts), the handler reads it off `locals.tenant`.
import { describe, it, expect, beforeEach } from 'vitest'

const SECRET = 'newsletter-link-base-secret-0123'
const CONTENT_SECRET = 'content-link-base-secret-45678901'

const { GET } = await import('./+server')

interface Tenant {
  id: string
  slug: string
  primaryHost: string | null
}
const TENANT_A: Tenant = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', slug: 'rat-a', primaryHost: 'a.example.org' }
const TENANT_B: Tenant = { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', slug: 'rat-b', primaryHost: 'b.example.org' }
const NO_HOST: Tenant = { id: 'cccccccc-3333-4333-8333-cccccccccccc', slug: 'rat-c', primaryHost: null }

function call(tenant: Tenant, headers: Record<string, string>) {
  return GET({
    request: new Request('http://gremion-ui:3000/api/internal/newsletter/link-base', {
      method: 'GET',
      headers: { 'x-tenant-id': tenant.id, ...headers },
    }),
    locals: { tenant },
  } as never)
}

beforeEach(() => {
  process.env.INTERNAL_NEWSLETTER_SECRET = SECRET
})

describe('GET /api/internal/newsletter/link-base', () => {
  it('answers the origin of the tenant the call is for: tenant A gets host A, tenant B gets host B', async () => {
    const a = await call(TENANT_A, { 'x-internal-auth': SECRET })
    expect(a.status).toBe(200)
    expect(await a.json()).toEqual({ origin: 'https://a.example.org' })

    const b = await call(TENANT_B, { 'x-internal-auth': SECRET })
    expect(b.status).toBe(200)
    expect(await b.json()).toEqual({ origin: 'https://b.example.org' })
  })

  it('answers 404 when the tenant has no primary host, and never invents one from the slug', async () => {
    const res = await call(NO_HOST, { 'x-internal-auth': SECRET })
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).not.toContain('rat-c')
    expect(text).not.toContain('https://')
  })

  it('answers 401 without the shared secret', async () => {
    const res = await call(TENANT_A, {})
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('a.example.org')
  })

  it('answers 401 with a wrong secret, a prefix of the real one and one that extends it', async () => {
    expect((await call(TENANT_A, { 'x-internal-auth': 'nope' })).status).toBe(401)
    expect((await call(TENANT_A, { 'x-internal-auth': SECRET.slice(0, -1) })).status).toBe(401)
    expect((await call(TENANT_A, { 'x-internal-auth': `${SECRET}x` })).status).toBe(401)
  })

  it('answers 401 with the content leaf secret: the newsletter route checks the newsletter secret', async () => {
    const res = await call(TENANT_A, { 'x-internal-auth': CONTENT_SECRET })
    expect(res.status).toBe(401)
  })

  it('answers 401 when the server has no secret configured, even if the caller sends an empty one', async () => {
    delete process.env.INTERNAL_NEWSLETTER_SECRET
    expect((await call(TENANT_A, { 'x-internal-auth': '' })).status).toBe(401)
    expect((await call(TENANT_A, { 'x-internal-auth': SECRET })).status).toBe(401)
    process.env.INTERNAL_NEWSLETTER_SECRET = ''
    expect((await call(TENANT_A, { 'x-internal-auth': '' })).status).toBe(401)
  })

  it('is never cached by an intermediary: the answer is per tenant and per send', async () => {
    const res = await call(TENANT_A, { 'x-internal-auth': SECRET })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
