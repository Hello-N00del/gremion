/**
 * KernelClient.linkBase(): the origin of THIS tenant, asked of the kernel on every call.
 *
 * The leaf holds no host for any tenant (see the header of src/kernel-client.ts), so the base of the
 * links in a mail cannot be a value fixed at boot. The client asks, the dispatch checks the answer.
 */
import { describe, it, expect } from 'vitest'
import { createKernelClient, type FetchLike } from '../src/kernel-client.ts'
import type { TenantRef } from '../src/tenant-store.ts'

const TENANT: TenantRef = { id: 'tid-1', slug: 'alpha' }

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function clientFor(respond: (url: string) => { ok: boolean; status: number; body: unknown }): {
  client: ReturnType<typeof createKernelClient>
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const r = respond(url)
    return {
      ok: r.ok,
      status: r.status,
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      },
      async json() {
        return r.body
      },
    }
  }
  const client = createKernelClient({
    baseUrl: 'http://kernel.internal/',
    secret: 's3cr3t',
    tenant: TENANT,
    correlationId: '9',
    fetchImpl,
  })
  return { client, calls }
}

describe('createKernelClient.linkBase', () => {
  it('GETs /api/internal/newsletter/link-base with the closed callback header set and returns the origin', async () => {
    const { client, calls } = clientFor(() => ({ ok: true, status: 200, body: { origin: 'https://a.example.org' } }))
    expect(await client.linkBase()).toBe('https://a.example.org')
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/link-base')
    expect(c.method).toBe('GET')
    expect(c.body).toBeUndefined()
    expect(Object.keys(c.headers).sort()).toEqual(
      ['content-type', 'x-correlation-id', 'x-internal-auth', 'x-tenant-id', 'x-tenant-slug'],
    )
    expect(c.headers['x-internal-auth']).toBe('s3cr3t')
    expect(c.headers['x-tenant-id']).toBe('tid-1')
  })

  it('answers null when the kernel has no host for the tenant (404), so the caller can refuse the send', async () => {
    const { client } = clientFor(() => ({ ok: false, status: 404, body: { success: false, error: 'No public host' } }))
    expect(await client.linkBase()).toBeNull()
  })

  it('throws, not null, on any other failure: a kernel that is down is not a tenant without a host', async () => {
    const down = clientFor(() => ({ ok: false, status: 503, body: 'down' }))
    await expect(down.client.linkBase()).rejects.toThrow(/kernel link-base failed: 503/)
    const refused = clientFor(() => ({ ok: false, status: 401, body: 'no' }))
    await expect(refused.client.linkBase()).rejects.toThrow(/kernel link-base failed: 401/)
  })

  it('throws when the answer carries no origin string', async () => {
    const { client } = clientFor(() => ({ ok: true, status: 200, body: { origin: 42 } }))
    await expect(client.linkBase()).rejects.toThrow(/no origin/)
  })

  it('throws when the transport fails', async () => {
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's',
      tenant: TENANT,
      correlationId: '1',
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    await expect(client.linkBase()).rejects.toThrow(/ECONNREFUSED/)
  })

  it('is asked again on every call: nothing is kept between sends', async () => {
    let n = 0
    const { client, calls } = clientFor(() => {
      n += 1
      return { ok: true, status: 200, body: { origin: n === 1 ? 'https://a.example.org' : 'https://b.example.org' } }
    })
    expect(await client.linkBase()).toBe('https://a.example.org')
    expect(await client.linkBase()).toBe('https://b.example.org')
    expect(calls).toHaveLength(2)
  })
})
