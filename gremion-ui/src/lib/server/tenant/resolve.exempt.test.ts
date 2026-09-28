import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * TASK-023 (B-05 option 1): the paths on BOOT_AND_RESOLVE_EXEMPT_PATHS reach
 * their handler WITHOUT a tenant host and WITHOUT the proxy-trust header — the
 * exemption is the first statement of tenantResolveHandle, ahead of the
 * proxy-trust gate and every registry read. Everything else keeps the
 * fail-closed resolver: /api/health (the boot probe) is NOT exempt.
 */

const registryCalls: string[] = []
vi.mock('$lib/server/tenant/registry', () => ({
  // TASK-041: the host path looks up the WHOLE host.
  resolveTenantByHost: async (host: string) => {
    registryCalls.push(`host:${host}`)
    return null
  },
  getTenantStatusByHost: async (host: string) => {
    registryCalls.push(`status:${host}`)
    return null
  },
  resolveTenantById: async (id: string) => {
    registryCalls.push(`id:${id}`)
    return null
  },
}))
const runWithTenant = vi.fn(async (_ctx: unknown, fn: () => unknown) => fn())
vi.mock('$lib/server/tenant/context', () => ({
  runWithTenant: (ctx: unknown, fn: () => unknown) => runWithTenant(ctx, fn),
  getTenantOrNull: () => null,
}))
vi.mock('$lib/server/tenant/readiness', () => ({
  isFleetPopulated: () => true,
  getTenantReadiness: () => 'ready',
  triggerTenantMigrationRetry: vi.fn(),
}))
vi.mock('$lib/server/tenant/host-mismatch-log', () => ({ logHostRejection: vi.fn() }))
vi.mock('$lib/server/tenant/rate-limit', () => ({
  checkTenantRateLimit: () => ({ allowed: true }),
}))
// The proxy-trust secret is steered per test: SET is the production posture,
// where a request without x-proxy-trust is 403'd before any lookup.
const proxySecret = { value: 'proxy-secret-for-tests' as string | null }
vi.mock('$lib/server/internal-fetch', async () => {
  const actual = await vi.importActual<typeof import('../internal-fetch')>('$lib/server/internal-fetch')
  return {
    constantTimeEqual: actual.constantTimeEqual,
    readInternalPushSecret: () => 'push-secret-for-tests',
    readProxyTrustSecret: () => proxySecret.value,
  }
})

const { tenantResolveHandle } = await import('./resolve')

function bareEvent(path: string) {
  // No x-forwarded-host, no x-proxy-trust, no x-internal-host-trust.
  return {
    url: new URL(`http://gremion-ui:3000${path}`),
    request: new Request(`http://gremion-ui:3000${path}`),
    locals: {} as Record<string, unknown>,
  }
}

async function run(path: string) {
  const event = bareEvent(path)
  let reached = false
  const res = (await tenantResolveHandle({
    event: event as never,
    resolve: async () => {
      reached = true
      return new Response('handler', { status: 200 })
    },
  } as never)) as Response
  return { res, reached, event }
}

beforeEach(() => {
  registryCalls.length = 0
  runWithTenant.mockClear()
  proxySecret.value = 'proxy-secret-for-tests'
})

describe('tenantResolveHandle — boot-and-resolve exemption', () => {
  for (const path of ['/healthz', '/api/internal/x', '/api/internal/evict']) {
    it(`${path} with no host and no trust header reaches resolve (proxy-trust secret SET)`, async () => {
      const { res, reached, event } = await run(path)
      expect(reached).toBe(true)
      expect(res.status).toBe(200)
      // No lookup, no tenant scope, no tenant on locals.
      expect(registryCalls).toEqual([])
      expect(runWithTenant).not.toHaveBeenCalled()
      expect(event.locals.tenant).toBeUndefined()
    })
  }

  it('/healthz also reaches resolve when the proxy-trust secret is unset', async () => {
    proxySecret.value = null
    const { reached } = await run('/healthz')
    expect(reached).toBe(true)
  })

  it('/api/health is NOT exempt: 403 without x-proxy-trust when the secret is set', async () => {
    const { res, reached } = await run('/api/health')
    expect(reached).toBe(false)
    expect(res.status).toBe(403)
  })

  it('/api/health is NOT exempt: 404 without a tenant host when the secret is unset', async () => {
    proxySecret.value = null
    const { res, reached } = await run('/api/health')
    expect(reached).toBe(false)
    expect(res.status).toBe(404)
  })

  it('/healthz with a forwarded host is still exempt (it answers for unknown hosts too)', async () => {
    const event = bareEvent('/healthz')
    event.request.headers.set('x-forwarded-host', 'unknown.example.org')
    let reached = false
    await tenantResolveHandle({
      event: event as never,
      resolve: async () => {
        reached = true
        return new Response('handler')
      },
    } as never)
    expect(reached).toBe(true)
    expect(registryCalls).toEqual([])
  })

  it('an /api/internal/ request that NAMES a tenant is resolved and gated as before (403 without proxy-trust)', async () => {
    const event = bareEvent('/api/internal/x')
    event.request.headers.set('x-forwarded-host', 'tenant.example.org')
    let reached = false
    const res = (await tenantResolveHandle({
      event: event as never,
      resolve: async () => {
        reached = true
        return new Response('handler')
      },
    } as never)) as Response
    expect(reached).toBe(false)
    expect(res.status).toBe(403)
  })

  for (const path of ['/healthzx', '/api/internalx', '/healthz/x', '/']) {
    it(`${path} (a near miss) is NOT exempt`, async () => {
      proxySecret.value = null
      const { res, reached } = await run(path)
      expect(reached).toBe(false)
      expect(res.status).toBe(404)
    })
  }
})

/**
 * The closed list only stays closed if nothing ELSE in the resolver lets a
 * request through un-resolved. tenantResolveHandle may hand a request to the
 * downstream chain in exactly two places: the exemption (its first statement)
 * and inside runWithTenant. A third `resolve(event)` — e.g. a new
 * `if (path === '/x') return resolve(event)` — is an exemption that bypassed
 * the list, and turns this RED.
 */
describe('tenantResolveHandle — no exemption outside the list (static)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'resolve.ts'), 'utf8')
  const start = src.indexOf('export const tenantResolveHandle')
  const body = src.slice(start)

  it('finds the handler (guards against a vacuous scan)', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('opens with the exemption as its first statement', () => {
    const firstStatement = body
      .slice(body.indexOf('=> {') + 4)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('//'))
    expect(firstStatement).toBe('if (isResolveExemptRequest(event.url.pathname, event.request.headers)) return resolve(event)')
  })

  it('hands the request on in exactly two places: the exemption and runWithTenant', () => {
    const calls = [...body.matchAll(/\bresolve\(event\)/g)].map((m) => {
      const line = body.slice(0, m.index).split('\n').length - 1
      return body.split('\n')[line].trim()
    })
    expect(calls).toEqual([
      'if (isResolveExemptRequest(event.url.pathname, event.request.headers)) return resolve(event)',
      'return runWithTenant(ctx, () => resolve(event))',
    ])
  })
})
