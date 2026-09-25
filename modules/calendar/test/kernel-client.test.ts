/**
 * Unit tests for the calendar leaf's MINIMAL kernel-client (Task 16).
 *
 * Unlike newsletter's kernel-client (which carries a fat callback surface:
 * render/resolveGroup/sendMail), the calendar leaf needs NO kernel callback —
 * CalDAV is direct (the leaf talks to Nextcloud itself). This client exists
 * only to carry the SP-3 header plumbing (x-tenant-id/x-tenant-slug,
 * x-correlation-id, x-proxy-trust, x-forwarded-host) for a FUTURE kernel
 * callback, should one ever be needed.
 *
 * Tenancy D1 (§1.5): the forwarded host is no longer `<slug>.<apexDomain>`. The
 * kernel resolver looks the WHOLE host up in `tenant_domain`, so the client now
 * takes the tenant's REGISTERED PRIMARY host verbatim (`tenantHost`) and never
 * composes one. This leaf is not wired to LEARN a host (no callback exists), so
 * `tenantHost` is undefined in production and the client emits no proxy-trust
 * headers at all — asserted below so the day someone adds a real callback, the
 * "where does the host come from?" question cannot be skipped.
 *
 * Dependency-free: a FAKE fetch records headers a caller could send via the
 * exported header-builder; no live kernel/network is required.
 */
import { describe, it, expect } from 'vitest'
import { createKernelClient, type FetchLike } from '../src/kernel-client.ts'
import type { TenantRef } from '../src/tenant-store.ts'

const TENANT: TenantRef = { id: 'tid-1', slug: 'alpha' }

describe('createKernelClient — minimal surface (no callback methods)', () => {
  it('does NOT expose render/resolveGroup/sendMail/portalPublish (calendar has no kernel callback — CalDAV is direct)', () => {
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's3cr3t',
      tenant: TENANT,
      correlationId: '1',
    })
    expect((client as unknown as Record<string, unknown>)['render']).toBeUndefined()
    expect((client as unknown as Record<string, unknown>)['resolveGroup']).toBeUndefined()
    expect((client as unknown as Record<string, unknown>)['sendMail']).toBeUndefined()
    expect((client as unknown as Record<string, unknown>)['portalPublish']).toBeUndefined()
  })

  it('exposes buildHeaders() carrying the SP-3 header plumbing (secret + tenant + correlation id)', () => {
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's3cr3t',
      tenant: TENANT,
      correlationId: '42',
    })
    const headers = client.buildHeaders()
    expect(headers['x-internal-auth']).toBe('s3cr3t')
    expect(headers['x-tenant-id']).toBe('tid-1')
    expect(headers['x-tenant-slug']).toBe('alpha')
    expect(headers['x-correlation-id']).toBe('42')
    // No proxy-trust config → NEITHER proxy-trust header (dev path / byte-identical no-op).
    expect(headers['x-proxy-trust']).toBeUndefined()
    expect(headers['x-forwarded-host']).toBeUndefined()
  })

  it('buildHeaders() is CLOSED over the five callback headers — no host, no proxy-trust', () => {
    // Tenancy D1 HARDENING-3. This leaf makes no kernel callback today, so this
    // file is really a contract for whoever adds the first one: identity plus a
    // secret is the whole set. A kernel callback selects its tenant from
    // `x-tenant-id`, so there is no hostname to obtain, thread down or cache.
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's',
      tenant: TENANT,
      correlationId: '1',
    })
    expect(Object.keys(client.buildHeaders()).sort()).toEqual([
      'content-type',
      'x-correlation-id',
      'x-internal-auth',
      'x-tenant-id',
      'x-tenant-slug',
    ])
  })

  it('no header value carries a hostname, and the deleted options cannot smuggle one in', () => {
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's',
      tenant: TENANT,
      correlationId: '1',
      // TypeScript rejects these; pinned at RUNTIME so a JS caller cannot
      // reintroduce the header set the hardening removed.
      ...({ tenantHost: 'rat-musterstadt.de', proxyTrustSecret: 'pt-secret' } as object),
    })
    const headers = client.buildHeaders()
    expect(headers['x-forwarded-host']).toBeUndefined()
    expect(headers['x-proxy-trust']).toBeUndefined()
    const values = Object.values(headers).join(' | ')
    for (const host of ['rat-musterstadt.de', 'sturaos.com', `${TENANT.slug}.sturaos.com`]) {
      expect(values).not.toContain(host)
    }
  })

  it('accepts an injectable fetchImpl option (unused by the minimal surface, reserved for a future callback)', () => {
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      return { ok: true, status: 200, async text() { return '' }, async json() { return {} } }
    }
    // Constructing with a fetchImpl must not throw — it's accepted for parity
    // with the future-callback seam even though no method uses it yet.
    expect(() =>
      createKernelClient({
        baseUrl: 'http://kernel.internal',
        secret: 's',
        tenant: TENANT,
        correlationId: '1',
        fetchImpl,
      }),
    ).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})
