import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * GET /readyz on gremion-ui.
 *
 * Public answer, readable by anyone through any customer host: exactly
 * {"ready":true} (200) or {"ready":false} (503). `ready` = boot complete AND the
 * control database answers (a ping memoised for 5 s). A failed tenant is NOT part
 * of `ready`. With the bearer INTERNAL_PUSH_SECRET the body
 * also carries colour, release, tenant counts and the reasons: counts only,
 * never a slug, a host, an address or an error message.
 */

const SECRET = 'internal-push-secret-0123456789abcdef'

const boot = { complete: true }
vi.mock('../../hooks.server', () => ({ getBootStatus: () => ({ complete: boot.complete, error: null }) }))

const ping = vi.fn<() => Promise<unknown>>()
vi.mock('$lib/server/tenant/control-db', () => ({
  // The route may only ever touch the control pool through a tagged template.
  getControlDb: () => () => ping(),
}))

// A handler that reached out to a tenant database, a module service or Matrix would import one of these.
const outbound = vi.fn()
vi.mock('$lib/server/db', () => ({ getDb: outbound }))
vi.mock('$lib/server/tenant/registry', () => ({
  RESOLUTION_CACHE_TTL_MS: 30_000,
  resolveTenantByHost: outbound,
  listActiveTenants: outbound,
}))
vi.mock('$lib/server/tenant/fleet', () => ({ migrateTenant: vi.fn() }))

const privateEnv = vi.hoisted(() => ({ INTERNAL_PUSH_SECRET: undefined as string | undefined }))
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }))

const saved = {
  colour: process.env.COLOUR,
  release: process.env.GREMION_RELEASE_REF,
  secret: process.env.INTERNAL_PUSH_SECRET,
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  boot.complete = true
  ping.mockReset()
  ping.mockResolvedValue([{ '?column?': 1 }])
  outbound.mockReset()
  privateEnv.INTERNAL_PUSH_SECRET = SECRET
  delete process.env.INTERNAL_PUSH_SECRET
  process.env.COLOUR = 'blue'
  process.env.GREMION_RELEASE_REF = 'rel-abc123'
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const [key, value] of [
    ['COLOUR', saved.colour],
    ['GREMION_RELEASE_REF', saved.release],
    ['INTERNAL_PUSH_SECRET', saved.secret],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function load() {
  const route = await import('./+server')
  const readiness = await import('$lib/server/tenant/readiness')
  return { route, readiness }
}

async function get(route: typeof import('./+server'), headers: Record<string, string> = {}): Promise<Response> {
  return (await route.GET({
    request: new Request('http://127.0.0.1:3000/readyz', { headers }),
  } as never)) as Response
}

const bearer = (s: string) => ({ authorization: `Bearer ${s}` })

describe('GET /readyz anonymous answer (public: anyone can reach it)', () => {
  it('ready: exactly {"ready":true} with 200, nothing else', async () => {
    const { route } = await load()
    const res = await get(route)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('{"ready":true}')
  })

  it('not ready: exactly {"ready":false} with 503, no colour, release, counts or reasons', async () => {
    boot.complete = false
    const { route } = await load()
    const res = await get(route)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ready":false}')
  })

  it('a control database failure is the same bare 503 body', async () => {
    ping.mockRejectedValue(new Error('connect ECONNREFUSED 203.0.113.9:5432 as user gremion'))
    const { route } = await load()
    const res = await get(route)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ready":false}')
  })
})

describe('GET /readyz readiness rule', () => {
  it('boot not complete is 503 and does not ping the control database', async () => {
    boot.complete = false
    const { route } = await load()
    expect((await get(route)).status).toBe(503)
    expect(ping).not.toHaveBeenCalled()
  })

  it('boot complete with a failing control database is 503', async () => {
    ping.mockRejectedValue(new Error('down'))
    const { route } = await load()
    expect((await get(route)).status).toBe(503)
  })

  it('a control ping that never answers is 503 within the timeout, not a hung probe', async () => {
    ping.mockReturnValue(new Promise(() => {}))
    const { route } = await load()
    const pending = get(route)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).status).toBe(503)
  })

  it('an unconfigured control database (the pool throws) is 503', async () => {
    ping.mockImplementation(() => {
      throw new Error('CONTROL_DATABASE_URL not configured')
    })
    const { route } = await load()
    const res = await get(route)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ready":false}')
  })

  it('one active tenant failed still gives ready=true; the internal answer counts it', async () => {
    const { route, readiness } = await load()
    readiness.setTenantReadinessFromFleet(
      new Map([
        ['00000000-0000-4000-8000-000000000001', { ok: true }],
        ['00000000-0000-4000-8000-000000000002', { ok: false, error: 'migration: boom', kind: 'migration' }],
      ] as never),
    )
    const anon = await get(route)
    expect(anon.status).toBe(200)
    expect(await anon.text()).toBe('{"ready":true}')
    const internal = await get(route, bearer(SECRET))
    expect(internal.status).toBe(200)
    expect((await internal.json()).tenants).toEqual({ total: 2, notReady: 1 })
  })

  it('the counts summary covers every non-ready entry of the readiness map, whatever the failure kind', async () => {
    const { route, readiness } = await load()
    readiness.setTenantReadinessFromFleet(new Map([['00000000-0000-4000-8000-000000000001', { ok: true }]] as never))
    expect(readiness.getTenantReadinessCounts()).toEqual({ total: 1, notReady: 0 })
    readiness.setTenantReadinessFromFleet(
      new Map([['00000000-0000-4000-8000-000000000003', { ok: false, error: 'control-plane: x', kind: 'control-plane' }]] as never),
    )
    expect(readiness.getTenantReadinessCounts()).toEqual({ total: 2, notReady: 1 })
    const res = await get(route)
    expect(res.status).toBe(200)
  })

  it('a pending tenant (never seen by the fleet) is absent from the map and so in neither count', async () => {
    const { readiness } = await load()
    readiness.setTenantReadinessFromFleet(new Map([['00000000-0000-4000-8000-000000000001', { ok: true }]] as never))
    expect(readiness.getTenantReadiness('00000000-0000-4000-8000-0000000000aa')).toBe('pending')
    expect(readiness.getTenantReadinessCounts()).toEqual({ total: 1, notReady: 0 })
  })
})

describe('GET /readyz internal answer', () => {
  it('carries colour, release, counts and reasons in that shape', async () => {
    const { route, readiness } = await load()
    readiness.setTenantReadinessFromFleet(new Map([['00000000-0000-4000-8000-000000000001', { ok: true }]] as never))
    const res = await get(route, bearer(SECRET))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      '{"ready":true,"colour":"blue","release":"rel-abc123","tenants":{"total":1,"notReady":0},"reasons":[]}',
    )
  })

  it('names boot as the reason before boot completes (503)', async () => {
    boot.complete = false
    const { route } = await load()
    const res = await get(route, bearer(SECRET))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ready).toBe(false)
    expect(body.reasons).toEqual(['boot'])
  })

  it('names control_db as the reason when the ping fails (503)', async () => {
    ping.mockRejectedValue(new Error('down'))
    const { route } = await load()
    const res = await get(route, bearer(SECRET))
    expect(res.status).toBe(503)
    expect((await res.json()).reasons).toEqual(['control_db'])
  })

  it('never carries a slug, a host, an address or an error message', async () => {
    ping.mockRejectedValue(new Error('connect ECONNREFUSED db.internal.example.org:5432'))
    const { route, readiness } = await load()
    readiness.setTenantReadinessFromFleet(
      new Map([
        [
          'chair@musterstadt.example.org',
          { ok: false, error: 'migration: relation of chair@musterstadt.example.org', kind: 'migration' },
        ],
      ] as never),
    )
    for (const headers of [{}, bearer(SECRET)]) {
      const text = await (await get(route, headers)).text()
      expect(text).not.toContain('musterstadt')
      expect(text).not.toContain('chair@')
      expect(text).not.toContain('example.org')
      expect(text).not.toContain('ECONNREFUSED')
      expect(text).not.toContain('5432')
    }
  })

  it('a wrong bearer, an empty bearer, a bearer of another length and no secret configured all get the anonymous answer', async () => {
    const { route } = await load()
    const anonymous = '{"ready":true}'
    for (const headers of [
      bearer(SECRET.slice(0, -1) + 'X'),
      { authorization: 'Bearer ' },
      { authorization: 'Bearer' },
      bearer('short'),
      bearer(SECRET + 'extra'),
      { authorization: `Basic ${SECRET}` },
      { authorization: SECRET },
    ]) {
      const res = await get(route, headers)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(anonymous)
    }
    privateEnv.INTERNAL_PUSH_SECRET = undefined
    expect(await (await get(route, bearer(SECRET))).text()).toBe(anonymous)
    privateEnv.INTERNAL_PUSH_SECRET = ''
    expect(await (await get(route, bearer(''))).text()).toBe(anonymous)
  })

  it('a configured secret shorter than 16 characters is never accepted (fail closed, as the evict route)', async () => {
    privateEnv.INTERNAL_PUSH_SECRET = 'short'
    const { route } = await load()
    expect(await (await get(route, bearer('short'))).text()).toBe('{"ready":true}')
  })

  it('compares the bearer with constantTimeEqual', async () => {
    const compare = vi.fn((a: string, b: string) => a === b)
    vi.doMock('$lib/server/internal-fetch', async () => {
      const actual = await vi.importActual<typeof import('$lib/server/internal-fetch')>('$lib/server/internal-fetch')
      return { ...actual, constantTimeEqual: compare }
    })
    const { route } = await load()
    await get(route, bearer(SECRET))
    expect(compare).toHaveBeenCalledWith(SECRET, SECRET)
    vi.doUnmock('$lib/server/internal-fetch')
  })
})

describe('GET /readyz cost', () => {
  it('a burst of 100 anonymous requests causes one control ping; a new one after 5 s', async () => {
    const { route } = await load()
    const answers = await Promise.all(Array.from({ length: 100 }, () => get(route)))
    expect(answers.every((r) => r.status === 200)).toBe(true)
    expect(ping).toHaveBeenCalledTimes(1)
    await get(route, bearer(SECRET))
    expect(ping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_001)
    await get(route)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('a failed ping is memoised too (an outage is not a flood of pings)', async () => {
    ping.mockRejectedValue(new Error('down'))
    const { route } = await load()
    for (let i = 0; i < 20; i++) await get(route)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('makes no outbound call: no tenant database, no registry, no module service, no Matrix', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { route } = await load()
    await get(route)
    await get(route, bearer(SECRET))
    expect(outbound).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers with no host header, no proxy-trust header and no tenant', async () => {
    const { route } = await load()
    const res = await get(route)
    expect(res.status).toBe(200)
  })

  it('an unexpected throw inside the handler still answers the bare 503, never an error page', async () => {
    const { route, readiness } = await load()
    vi.spyOn(readiness, 'getTenantReadinessCounts').mockImplementation(() => {
      throw new Error('boom at musterstadt.example.org')
    })
    const res = await get(route, bearer(SECRET))
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('{"ready":false}')
  })
})

describe('docker-compose.app.yml (gremion-ui)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const compose = readFileSync(join(root, 'docker-compose.app.yml'), 'utf8').replace(/\r\n/g, '\n')
  const start = compose.indexOf('\n  gremion-ui:\n')
  const end = compose.indexOf('\n  gremion-public:\n')
  const block = compose.slice(start, end)

  it('finds the gremion-ui service block', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  it('passes the release ref from IMAGE_TAG, required', () => {
    expect(block).toMatch(/^ {6}GREMION_RELEASE_REF: +\$\{IMAGE_TAG:\?IMAGE_TAG required\}$/m)
  })

  it('bind-mounts the worker gate directory read-only, no named volume', () => {
    // The default follows GREMION_ROOT like every other host bind of this file: on a
    // host with a non-default root the colour must mount the directory the host writes.
    expect(block).toContain(
      '- ${GREMION_WORKERS_DIR:-${GREMION_ROOT:-/opt/gremion}/runtime/workers}:/run/gremion/workers:ro',
    )
    const topVolumes = compose.slice(compose.search(/^volumes:/m))
    expect(topVolumes).not.toMatch(/workers/)
  })
})
