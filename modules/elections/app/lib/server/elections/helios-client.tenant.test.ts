import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// P2.1b T7 — the Helios service-account session cache (_sessionCookie/_csrfToken)
// is keyed by tenant id, and the Helios base URL resolves per tenant
// (default = env.HELIOS_URL byte-identically). Tenant context module is REAL;
// every per-tenant case uses an EXPLICIT runWithTenant scope (standing rule 5).

vi.mock('$env/dynamic/private', () => ({
  env: {
    HELIOS_URL: 'http://helios-default:8000',
    HELIOS_SERVICE_EMAIL: 'bot@test.de',
    HELIOS_SERVICE_PASSWORD: 'secret',
  },
}))

import { HeliosClient, _resetSessionForTest, evictHeliosSession } from './helios-client'

const DEFAULT_CTX = {
  id: 'tid-default',
  slug: 'default',
  // Byte-identical pin: the default tenant ignores service overrides — env wins.
  services: { heliosUrl: 'http://never-used:1' },
} as unknown as TenantContext

const BETA_CTX = {
  id: 'tid-beta',
  slug: 'beta',
  services: { heliosUrl: 'http://helios-beta:8000' },
} as unknown as TenantContext

function res(opts: {
  status?: number
  ok?: boolean
  cookies?: string
  location?: string
  json?: unknown
  text?: string
}) {
  const status = opts.status ?? 200
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    headers: {
      get(h: string): string | null {
        const k = h.toLowerCase()
        if (k === 'set-cookie') return opts.cookies ?? null
        if (k === 'location') return opts.location ?? null
        return null
      },
    },
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ''),
  }
}

/** Base-agnostic mock for the 4-step Django login dance + admin/read endpoints.
 *  Records the ORIGIN of every login POST so per-tenant base resolution and
 *  per-tenant re-login behaviour are observable. */
function danceMock(loginOrigins: string[]) {
  let session = 0
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const u = new URL(input)
    const key = `${method} ${u.pathname}`
    if (key === 'GET /auth/password/login') return res({ cookies: 'csrftoken=dj' })
    if (key === 'POST /auth/password/login') {
      loginOrigins.push(u.origin)
      return res({ status: 302, cookies: `sessionid=sess-${++session}`, location: '/auth/after' })
    }
    if (key === 'GET /auth/after') return res({})
    if (key === 'GET /helios/elections/new')
      return res({ text: '<input type="hidden" name="csrf_token" value="csrf-tok">' })
    if (method === 'GET' && /\/voters\/$/.test(u.pathname)) return res({ json: [] })
    if (method === 'GET' && /^\/helios\/elections\//.test(u.pathname)) return res({ json: { uuid: 'x' } })
    throw new Error(`unmocked Helios call: ${key} @ ${u.origin}`)
  })
}

describe('HeliosClient — per-tenant session cache + base URL (T7)', () => {
  let loginOrigins: string[]
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetSessionForTest()
    loginOrigins = []
    fetchMock = danceMock(loginOrigins)
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fail-closed: a read outside any tenant scope throws (NOT a degraded unavailable error)', async () => {
    await expect(HeliosClient.getElection('u1')).rejects.toThrow(/No tenant context/)
  })

  it('default tenant base stays env.HELIOS_URL (byte-identical; services ignored)', async () => {
    await runWithTenant(DEFAULT_CTX, () => HeliosClient.getElection('u1'))
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe('http://helios-default:8000/helios/elections/u1')
  })

  it('non-default tenant reads resolve against its services.heliosUrl', async () => {
    await runWithTenant(BETA_CTX, () => HeliosClient.getElection('u1'))
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe('http://helios-beta:8000/helios/elections/u1')
  })

  it('session cache is keyed by tenant: tenant B logs in on ITS base; tenant A session is not reused', async () => {
    await runWithTenant(DEFAULT_CTX, () => HeliosClient.listVoters('u1'))
    expect(loginOrigins).toEqual(['http://helios-default:8000'])

    await runWithTenant(BETA_CTX, () => HeliosClient.listVoters('u1'))
    expect(loginOrigins).toEqual(['http://helios-default:8000', 'http://helios-beta:8000'])

    // Back to the default tenant — its session is still cached, no third login.
    await runWithTenant(DEFAULT_CTX, () => HeliosClient.listVoters('u1'))
    expect(loginOrigins).toHaveLength(2)
  })

  it('evictHeliosSession(tenantId) forces a re-login for that tenant only', async () => {
    await runWithTenant(DEFAULT_CTX, () => HeliosClient.listVoters('u1'))
    await runWithTenant(BETA_CTX, () => HeliosClient.listVoters('u1'))
    expect(loginOrigins).toHaveLength(2)

    evictHeliosSession('tid-default')

    await runWithTenant(BETA_CTX, () => HeliosClient.listVoters('u1')) // still cached
    expect(loginOrigins).toHaveLength(2)
    await runWithTenant(DEFAULT_CTX, () => HeliosClient.listVoters('u1')) // re-login
    expect(loginOrigins).toHaveLength(3)
    expect(loginOrigins[2]).toBe('http://helios-default:8000')
  })
})
