/**
 * Unit tests for the kernel callback client (Task 8).
 *
 * Dependency-free: a FAKE fetch records the request URL/headers/body and returns
 * canned responses. Asserts that EVERY request forwards the internal secret +
 * tenant headers + correlation id (the kernel guard rejects requests missing
 * any of them).
 */
import { describe, it, expect } from 'vitest'
import { createKernelClient, MailUnconfiguredError, type FetchLike } from '../src/kernel-client.ts'
import type { TenantRef } from '../src/tenant-store.ts'

const TENANT: TenantRef = { id: 'tid-1', slug: 'alpha' }

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeFetch(
  respond: (url: string) => { ok: boolean; status: number; body: unknown },
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const r = respond(url)
    return {
      ok: r.ok,
      status: r.status,
      async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body) },
      async json() { return r.body },
    }
  }
  return { fetchImpl, calls }
}

describe('createKernelClient — header forwarding', () => {
  it('forwards secret + tenant headers + correlation id on render', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { html: '<p>ok</p>' } }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal/',
      secret: 's3cr3t',
      tenant: TENANT,
      correlationId: '42',
      fetchImpl,
    })
    const html = await client.render('/path/to.odt')
    expect(html).toBe('<p>ok</p>')

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/render')
    expect(c.method).toBe('POST')
    expect(c.headers['x-internal-auth']).toBe('s3cr3t')
    expect(c.headers['x-tenant-id']).toBe('tid-1')
    expect(c.headers['x-tenant-slug']).toBe('alpha')
    expect(c.headers['x-correlation-id']).toBe('42')
    expect(JSON.parse(c.body!)).toEqual({ odtPath: '/path/to.odt' })
    // No proxy-trust config → NEITHER proxy-trust header (dev path / byte-identical no-op).
    expect(c.headers['x-proxy-trust']).toBeUndefined()
    expect(c.headers['x-forwarded-host']).toBeUndefined()
  })

  it('forwards the same headers on resolveGroup and maps members', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200,
      body: { members: [
        { email: 'a@x.com', name: 'A' },
        { email: 'b@x.com' },         // missing name → null
        { name: 'no-email' },         // dropped (no email)
        { email: '' },                // dropped (empty email)
      ] },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal',
      secret: 's', tenant: TENANT, correlationId: '7', fetchImpl,
    })
    const members = await client.resolveGroup('grp-9')
    expect(members).toEqual([
      { email: 'a@x.com', name: 'A' },
      { email: 'b@x.com', name: null },
    ])
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/resolve-group')
    expect(c.headers['x-internal-auth']).toBe('s')
    expect(c.headers['x-correlation-id']).toBe('7')
    expect(JSON.parse(c.body!)).toEqual({ groupId: 'grp-9' })
  })

  it('throws on a non-ok render response', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.render('/x.odt')).rejects.toThrow(/502/)
  })

  it('throws when render returns no html', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, body: {} }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(client.render('/x.odt')).rejects.toThrow(/no html/)
  })
})

// ── sendMail (SP-3 INTEGRATION-DELTA §1 Option B2 — kernel mail seam) ──────────
describe('createKernelClient — sendMail (kernel mail seam)', () => {
  it('forwards secret + tenant headers + correlation id, posts {to,subject,html} WITHOUT a from, and returns messageId', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      ok: true, status: 200, body: { messageId: '<abc@kernel>' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal/',
      secret: 's3cr3t', tenant: TENANT, correlationId: '99', fetchImpl,
    })
    const res = await client.sendMail({ to: 'r@x.com', subject: 'Hi', html: '<p>body</p>' })
    expect(res).toEqual({ messageId: '<abc@kernel>' })

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.url).toBe('http://kernel.internal/api/internal/newsletter/send-mail')
    expect(c.method).toBe('POST')
    // the SAME guard headers as render/resolve-group
    expect(c.headers['x-internal-auth']).toBe('s3cr3t')
    expect(c.headers['x-tenant-id']).toBe('tid-1')
    expect(c.headers['x-tenant-slug']).toBe('alpha')
    expect(c.headers['x-correlation-id']).toBe('99')
    // Option B2: the kernel resolves per-tenant from-fields — the leaf sends NO from.
    const sent = JSON.parse(c.body!)
    expect(sent).toEqual({ to: 'r@x.com', subject: 'Hi', html: '<p>body</p>' })
    expect(sent).not.toHaveProperty('from')
    expect(sent).not.toHaveProperty('from_address')
    expect(sent).not.toHaveProperty('from_name')
  })

  it('tolerates a 200 with no messageId (returns empty string, not a throw)', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: true, status: 200, body: {} }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).resolves.toEqual({ messageId: '' })
  })

  it('maps a 503 smtp-unconfigured to MailUnconfiguredError (a SEND FAILURE, not a generic throw)', async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false, status: 503, body: { success: false, error: 'smtp-unconfigured' },
    }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).rejects.toBeInstanceOf(MailUnconfiguredError)
  })

  it('throws a generic (retryable) Error on a non-503 non-ok status', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    const p = client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' })
    await expect(p).rejects.toThrow(/502/)
    await expect(p).rejects.not.toBeInstanceOf(MailUnconfiguredError)
  })

  it('a 503 WITHOUT the smtp-unconfigured body is a generic (retryable) Error, not MailUnconfiguredError', async () => {
    const { fetchImpl } = makeFetch(() => ({ ok: false, status: 503, body: { error: 'overloaded' } }))
    const client = createKernelClient({
      baseUrl: 'http://k', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await expect(
      client.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' }),
    ).rejects.not.toBeInstanceOf(MailUnconfiguredError)
  })
})

// ── the callback header set is CLOSED (Tenancy D1 HARDENING-3) ───────────────
// A kernel callback carries identity and a secret, and nothing else. It used to
// have to carry a hostname too, because the kernel selected the tenant by
// looking `x-forwarded-host` up in `tenant_domain` — first a synthesised
// `<slug>.<apex>` (a cross-tenant selector once a tenant brought its own
// domain), then the tenant's REGISTERED host threaded down from the kernel and
// cached in `tenant_catalog.primary_host` (a replica the scheduler could not
// backfill). The kernel now selects from `x-tenant-id`, so there is no host.
//
// These tests assert the header set EXHAUSTIVELY rather than checking a few
// keys: that is what makes "no host, ever" a property this file can hold. A
// reintroduced `x-forwarded-host` or `x-proxy-trust` fails them by existing.
const CALLBACK_HEADERS = [
  'content-type',
  'x-internal-auth',
  'x-tenant-id',
  'x-tenant-slug',
  'x-correlation-id',
].sort()

describe('createKernelClient — the callback header set is closed', () => {
  const invoke: Record<string, [() => unknown, (c: ReturnType<typeof createKernelClient>) => Promise<unknown>]> = {
    render: [() => ({ html: '<p>ok</p>' }), (c) => c.render('/x.odt')],
    resolveGroup: [() => ({ members: [] }), (c) => c.resolveGroup('grp-1')],
    sendMail: [() => ({ messageId: '<m@k>' }), (c) => c.sendMail({ to: 'r@x.com', subject: 'S', html: 'h' })],
  }

  for (const [name, [body, call]] of Object.entries(invoke)) {
    it(`${name} sends EXACTLY the five callback headers — no host, no proxy-trust`, async () => {
      const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: body() }))
      const client = createKernelClient({
        baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
      })
      await call(client)
      const c = calls[0]!
      expect(Object.keys(c.headers).sort()).toEqual(CALLBACK_HEADERS)
      expect(c.headers['x-internal-auth']).toBe('s')
      expect(c.headers['x-tenant-id']).toBe('tid-1')
      expect(c.headers['x-tenant-slug']).toBe('alpha')
      expect(c.headers['x-correlation-id']).toBe('1')
    })
  }

  it('the TENANT ID is what identifies the tenant — it is always present and always sent', async () => {
    // The whole hardening rests on this: the leaf never has to be TOLD which
    // tenant it is acting for in some second encoding, because it holds the id.
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { html: 'h' } }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await client.render('/x.odt')
    expect(calls[0]!.headers['x-tenant-id']).toBe(TENANT.id)
  })

  it('NO header value contains a hostname — not the tenant’s, not the apex, not <slug>.<apex>', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { html: 'h' } }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
    })
    await client.render('/x.odt')
    const values = Object.values(calls[0]!.headers).join(' | ')
    for (const host of ['rat-musterstadt.de', 'example.org', `${TENANT.slug}.example.org`]) {
      expect(values).not.toContain(host)
    }
  })

  it('the options type carries no host or proxy-trust knob to set', async () => {
    // A caller that still passes the deleted options gets no header out of it.
    // (TypeScript rejects them at compile time; this pins the RUNTIME behaviour
    // so a JS caller — or a stale build — cannot smuggle one back in.)
    const { fetchImpl, calls } = makeFetch(() => ({ ok: true, status: 200, body: { html: 'h' } }))
    const client = createKernelClient({
      baseUrl: 'http://kernel.internal', secret: 's', tenant: TENANT, correlationId: '1', fetchImpl,
      ...({ tenantHost: 'rat-musterstadt.de', proxyTrustSecret: 'pt-secret' } as object),
    })
    await client.render('/x.odt')
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(CALLBACK_HEADERS)
  })
})
