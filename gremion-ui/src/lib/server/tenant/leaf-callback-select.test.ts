// Tenancy D1 HARDENING-3 — what the REAL element-0 resolver selects for a leaf
// callback, with the proxy-trust gate ENFORCED (the live staging/prod posture).
//
// The claim under test is the one the hardening exists for:
//
//   a leaf callback selects its tenant from the id the leaf already holds, so it
//   works with NO host at all — and a host it may still be carrying, correct or
//   stale, is not an input.
//
// The fixture is built so "by id" and "by host" give DIFFERENT answers wherever
// they can: a THIRD tenant has registered `<slug>.<apex>` for the custom-domain
// tenant, which is exactly the string a pre-D1 leaf synthesises. If anything ever
// reintroduces host-driven selection on this path, these tests land on that
// tenant and fail loudly rather than passing for the wrong reason.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const PROXY_SECRET = 'proxy-trust-secret-32-bytes-padxx'
const NL_SECRET = 'newsletter-secret-32-bytes-of-padxx'
const CONTENT_SECRET = 'content-secret-32-bytes-of-padxxxx'

vi.mock('$env/dynamic/private', () => ({
  env: {
    TENANT_PROXY_SHARED_SECRET: PROXY_SECRET,
    PUBLIC_BASE_URL: 'https://gremion.example',
  },
}))

// ── the fixture control plane ────────────────────────────────────────────────
interface Ctx {
  id: string
  slug: string
  primaryHost: string | null
}

/** A tenant that brought its OWN 2-label apex — the D1 case. */
const MUSTERSTADT: Ctx = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  slug: 'rat-musterstadt',
  primaryHost: 'rat-musterstadt.de',
}
/** The operator's own tenant, on the deployment apex. */
const DEFAULT: Ctx = {
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  slug: 'default',
  primaryHost: 'gremion.example',
}
/**
 * The trap: this tenant registered `rat-musterstadt.gremion.example`, precisely the
 * string a pre-D1 leaf synthesises as `<slug>.<apex>` for MUSTERSTADT.
 */
const SQUATTER: Ctx = {
  id: 'cccccccc-3333-4333-8333-cccccccccccc',
  slug: 'squatter',
  primaryHost: 'rat-musterstadt.gremion.example',
}
/** Known to the control plane but not active (suspended / tombstoned). */
const INACTIVE_ID = 'dddddddd-4444-4444-8444-dddddddddddd'

/**
 * The host path selects on the WHOLE forwarded host (TASK-041,
 * B10-resolver-fullhost): the fixture is the `tenant_domain` table itself.
 * `rat-musterstadt.gremion.example` — the string a pre-D1 leaf synthesises as
 * `<slug>.<apex>` for MUSTERSTADT — is registered to SQUATTER, so any
 * reintroduced host-driven selection on the callback path lands on SQUATTER.
 */
const BY_HOST: Record<string, Ctx> = {
  'rat-musterstadt.de': MUSTERSTADT,
  'gremion.example': DEFAULT,
  'rat-musterstadt.gremion.example': SQUATTER,
}
const BY_ID: Record<string, Ctx> = {
  [MUSTERSTADT.id]: MUSTERSTADT,
  [DEFAULT.id]: DEFAULT,
  [SQUATTER.id]: SQUATTER,
}

/** The host entry point, spied so "the host path was never consulted" is
 *  asserted against the code that actually runs. */
const resolveTenantByHost = vi.fn(async (host: string) => BY_HOST[host] ?? null)
const getTenantStatusByHost = vi.fn(async (host: string) => (BY_HOST[host] ? 'active' : null))
const resolveTenantById = vi.fn(async (id: string) => BY_ID[id] ?? null)
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantByHost: (host: string) => resolveTenantByHost(host),
  getTenantStatusByHost: (host: string) => getTenantStatusByHost(host),
  resolveTenantById: (id: string) => resolveTenantById(id),
}))

// Readiness + rate limit steered to pass: these tests are about SELECTION only.
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => true,
  getTenantReadiness: () => 'ready',
  triggerTenantMigrationRetry: vi.fn(),
}))
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: () => ({ allowed: true }),
}))

const { tenantResolveHandle } = await import('./resolve')

const RENDER = '/api/internal/newsletter/render'
const PUBLISH = '/api/internal/content/portal-publish'

/** Drive the REAL element-0 handle and report what it selected. */
async function receive(
  path: string,
  h: Record<string, string>,
): Promise<{ status: number; tenant: Ctx | undefined; inner: boolean }> {
  const url = new URL(`http://gremion-ui:3000${path}`)
  const request = new Request(url, { method: 'POST', headers: new Headers(h) })
  const locals: Record<string, unknown> = {}
  let inner = false
  const res = (await tenantResolveHandle({
    event: { url, request, locals, params: {} } as never,
    resolve: async () => {
      inner = true
      return new Response('handler-ran', { status: 200 })
    },
  } as never)) as Response
  return { status: res.status, tenant: locals['tenant'] as Ctx | undefined, inner }
}

/**
 * The header set a leaf sends AFTER hardening-3: identity + its own secret, and
 * nothing host-shaped. This is also byte-for-byte what a stage-D leaf sends for a
 * tenant whose host it has not learned — i.e. every tenant, immediately after a
 * deploy, on every scheduler-driven callback.
 */
function newLeaf(tenant: Ctx, secret = NL_SECRET): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-internal-auth': secret,
    'x-tenant-id': tenant.id,
    'x-tenant-slug': tenant.slug,
    'x-correlation-id': 'corr-1',
  }
}

const saved = { nl: process.env.INTERNAL_NEWSLETTER_SECRET, ct: process.env.INTERNAL_CONTENT_SECRET }
beforeEach(() => {
  resolveTenantByHost.mockClear()
  resolveTenantById.mockClear()
  process.env.INTERNAL_NEWSLETTER_SECRET = NL_SECRET
  process.env.INTERNAL_CONTENT_SECRET = CONTENT_SECRET
})
afterEach(() => {
  if (saved.nl === undefined) delete process.env.INTERNAL_NEWSLETTER_SECRET
  else process.env.INTERNAL_NEWSLETTER_SECRET = saved.nl
  if (saved.ct === undefined) delete process.env.INTERNAL_CONTENT_SECRET
  else process.env.INTERNAL_CONTENT_SECRET = saved.ct
})

describe('a leaf callback needs no host', () => {
  it('a tenant on its OWN domain resolves from the id alone — no x-forwarded-host anywhere', async () => {
    const h = newLeaf(MUSTERSTADT)
    expect(h['x-forwarded-host']).toBeUndefined()
    expect(h['x-proxy-trust']).toBeUndefined()

    const got = await receive(RENDER, h)
    expect(got.status).toBe(200)
    expect(got.inner).toBe(true) // the callback handler actually ran
    expect(got.tenant?.id).toBe(MUSTERSTADT.id)
    // …and it got there without consulting the host table at all.
    expect(resolveTenantById).toHaveBeenCalledWith(MUSTERSTADT.id)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  it('THE FIXED BUG: this is exactly the request a stage-D leaf makes with an empty catalog', async () => {
    // Stage D taught the leaf its tenants' hosts on kernel-driven requests and
    // persisted them. Before the first such request — i.e. right after a deploy,
    // and on EVERY scheduler-driven callback until one lands — it had none, and
    // sent neither trust header. Under host selection that is a 403 at the gate.
    const got = await receive(RENDER, newLeaf(MUSTERSTADT))
    expect(got.status).not.toBe(403)
    expect(got.status).not.toBe(404)
    expect(got.tenant?.id).toBe(MUSTERSTADT.id)
  })

  it('the content leaf’s portal-publish works the same way, on its own secret', async () => {
    const got = await receive(PUBLISH, newLeaf(MUSTERSTADT, CONTENT_SECRET))
    expect(got.status).toBe(200)
    expect(got.tenant?.id).toBe(MUSTERSTADT.id)
  })

  it('two tenants’ callbacks never cross — the id is doing the work', async () => {
    expect((await receive(RENDER, newLeaf(MUSTERSTADT))).tenant?.id).toBe(MUSTERSTADT.id)
    expect((await receive(RENDER, newLeaf(DEFAULT))).tenant?.id).toBe(DEFAULT.id)
  })
})

describe('a host the leaf may still be carrying is NOT an input', () => {
  it('a PRE-D1 leaf’s synthesised <slug>.<apex> does not select the tenant that registered it', async () => {
    // A leaf that has not been redeployed still sends the old pair. That host is
    // SQUATTER's registered row — under host selection this callback would run
    // against SQUATTER's data plane. The id path ignores it.
    const oldLeaf = {
      ...newLeaf(MUSTERSTADT),
      'x-proxy-trust': PROXY_SECRET,
      'x-forwarded-host': `${MUSTERSTADT.slug}.gremion.example`,
    }
    // The trap is live: the synthesised host is SQUATTER's registered row.
    expect(BY_HOST[`${MUSTERSTADT.slug}.gremion.example`].id).toBe(SQUATTER.id)

    const got = await receive(RENDER, oldLeaf)
    expect(got.status).toBe(200)
    expect(got.tenant?.id).toBe(MUSTERSTADT.id)
    expect(got.tenant?.id).not.toBe(SQUATTER.id)
    expect(resolveTenantByHost).not.toHaveBeenCalled()
  })

  it('a STALE host (the tenant moved domains) cannot aim the callback at the new owner', async () => {
    // The §7.8 identifier-reuse shape: operator removes H from A and adds it to
    // B. A leaf holding the pre-move value used to send it and hit B.
    const stale = {
      ...newLeaf(MUSTERSTADT),
      'x-proxy-trust': PROXY_SECRET,
      'x-forwarded-host': SQUATTER.primaryHost!,
    }
    expect((await receive(RENDER, stale)).tenant?.id).toBe(MUSTERSTADT.id)
  })

  it('a leaf naming ANOTHER tenant’s id gets that tenant — the id is the whole assertion', async () => {
    // Stated plainly rather than left implicit: a holder of the leaf secret is
    // already trusted for every tenant (it holds every tenant's database and,
    // under stage D, every tenant's host). The id path does not widen that; it
    // removes the DNS fact it needed to express the choice.
    const got = await receive(RENDER, newLeaf(SQUATTER))
    expect(got.tenant?.id).toBe(SQUATTER.id)
  })
})

describe('fail closed', () => {
  it('an UNKNOWN or INACTIVE tenant id is a 404 and the handler never runs', async () => {
    for (const id of [INACTIVE_ID, '99999999-9999-4999-8999-999999999999']) {
      const got = await receive(RENDER, { ...newLeaf(MUSTERSTADT), 'x-tenant-id': id })
      expect(got.status).toBe(404)
      expect(got.inner).toBe(false)
      expect(got.tenant).toBeUndefined()
    }
  })

  it('a registry outage is a 503, not a fallback tenant', async () => {
    resolveTenantById.mockRejectedValueOnce(new Error('control-db down'))
    const got = await receive(RENDER, newLeaf(MUSTERSTADT))
    expect(got.status).toBe(503)
    expect(got.tenant).toBeUndefined()
  })

  it('a FORGED x-tenant-id without the leaf secret falls back to the host path and 403s', async () => {
    // No x-internal-auth ⇒ not a leaf claim ⇒ ordinary request ⇒ the enforced
    // proxy-trust gate refuses it before any lookup. The header is inert.
    const forged = { 'x-tenant-id': MUSTERSTADT.id, 'x-tenant-slug': MUSTERSTADT.slug }
    const got = await receive(RENDER, forged)
    expect(got.status).toBe(403)
    expect(resolveTenantById).not.toHaveBeenCalled()
  })

  it('an edge client with a VALID proxy-trust still cannot select by id', async () => {
    // Traefik stamps x-proxy-trust on every request that matched a router, so
    // this is a request an ordinary internet client can actually produce. It
    // must fall through to the host path and be judged on its host alone.
    const got = await receive(RENDER, {
      'x-proxy-trust': PROXY_SECRET,
      'x-tenant-id': MUSTERSTADT.id,
      host: SQUATTER.primaryHost!, // the Host the edge router matched (Q2)
      'x-forwarded-host': SQUATTER.primaryHost!,
    })
    expect(resolveTenantById).not.toHaveBeenCalled()
    expect(got.tenant?.id).toBe(SQUATTER.id) // selected by HOST, as an edge request must be
  })

  it('a kernel with no leaf secret configured trusts no id at all', async () => {
    delete process.env.INTERNAL_NEWSLETTER_SECRET
    const got = await receive(RENDER, newLeaf(MUSTERSTADT))
    expect(got.status).toBe(403) // no claim, no host, enforced gate
    expect(resolveTenantById).not.toHaveBeenCalled()
  })

  it('the id path is confined to the callback routes — the same secret elsewhere is inert', async () => {
    for (const path of ['/', '/api/news/abc', '/api/internal/push']) {
      const got = await receive(path, newLeaf(MUSTERSTADT))
      expect(got.status).toBe(403)
      expect(got.tenant).toBeUndefined()
    }
    expect(resolveTenantById).not.toHaveBeenCalled()
  })
})

// Ported from the extraction source (f276af59, leaf-callback-select.test.ts:277-295) with the
// Host header the edge forwards: under the enforced gate an edge request is
// also held to the TASK-041 Q2 cross-check (Host == X-Forwarded-Host).
describe('the host path is untouched', () => {
  it('an ordinary edge request on a custom domain still resolves by whole host', async () => {
    const got = await receive('/', {
      'x-proxy-trust': PROXY_SECRET,
      host: 'rat-musterstadt.de',
      'x-forwarded-host': 'rat-musterstadt.de',
    })
    expect(got.status).toBe(200)
    expect(got.tenant?.id).toBe(MUSTERSTADT.id)
    expect(resolveTenantByHost).toHaveBeenCalledWith('rat-musterstadt.de')
    expect(resolveTenantById).not.toHaveBeenCalled()
  })

  it('an unregistered host is still a 404 with no fallback tenant', async () => {
    const got = await receive('/', {
      'x-proxy-trust': PROXY_SECRET,
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
    })
    expect(got.status).toBe(404)
    expect(got.tenant).toBeUndefined()
    expect(resolveTenantById).not.toHaveBeenCalled()
  })
})
