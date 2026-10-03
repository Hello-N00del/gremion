import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'http://helios-test:8000'

// Mutable mock env — individual tests tweak HELIOS_URL and restore it.
// helios-client reads env.* per call, so mutating this object is enough.
const { heliosEnv } = vi.hoisted(() => ({
  heliosEnv: {
    HELIOS_URL: 'http://helios-test:8000',
    HELIOS_SERVICE_EMAIL: 'bot@test.de',
    HELIOS_SERVICE_PASSWORD: 'secret',
  } as Record<string, string>,
}))

// TASK-205b: the service endpoints (Matrix, Helios, LiveKit, Nextcloud) come through the serviceEnv seam, the
// successor of the deleted default-tenant env reader. This suite feeds the seam the same values it already
// feeds its `$env/dynamic/private` mock, so every case keeps its own env fixture.
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({ env: heliosEnv }))

// P2.1b T7 — heliosBase()/the session cache are tenant-keyed (fail-closed).
// These tests exercise single-tenant client behaviour, so pin a default-tenant
// scope (env-based base URL, byte-identical). Per-tenant behaviour is covered
// by helios-client.tenant.test.ts.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'default', slug: 'default' }),
  currentTenantId: () => 'default',
}))

// Minimal Response-like object for the fetch mock — only the fields
// helios-client actually reads (status / ok / headers.get / json / text).
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

// A fetch mock that answers ensureSession()'s 4-step Django form-login dance
// (GET login → POST login → GET /auth/after → GET elections/new for the CSRF
// token), plus any operation-specific responses passed in `routes`, keyed
// "METHOD /path".
function heliosFetchMock(routes: Record<string, () => unknown> = {}) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${input.replace(BASE, '')}`
    if (routes[key]) return routes[key]()
    switch (key) {
      case 'GET /auth/password/login':
        return res({ cookies: 'csrftoken=csrf-dj' })
      case 'POST /auth/password/login':
        return res({ status: 302, cookies: 'sessionid=sess-1', location: '/auth/after' })
      case 'GET /auth/after':
        return res({})
      case 'GET /helios/elections/new':
        return res({ text: '<input type="hidden" name="csrf_token" value="csrf-tok">' })
      default:
        throw new Error(`unmocked Helios call: ${key}`)
    }
  })
}

describe('HeliosClient — read methods', () => {
  afterEach(() => {
    heliosEnv.HELIOS_URL = BASE
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('getElection fetches the election endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' }) })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    const result = await HeliosClient.getElection('0f8fad5b-d9cb-469f-a165-70867728950e')

    expect(mockFetch).toHaveBeenCalledWith(`${BASE}/helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e`, {
      redirect: 'manual',
    })
    expect(result.uuid).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
  })

  it('getElection throws on a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    const { HeliosClient } = await import('./helios-client')
    await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000014')).rejects.toThrow('Helios')
  })

  it('getResult fetches the result endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ questions: [] }) })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    await HeliosClient.getResult('0f8fad5b-d9cb-469f-a165-70867728950e')

    expect(mockFetch).toHaveBeenCalledWith(`${BASE}/helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/result`, {
      redirect: 'manual',
    })
  })

  it('strips a trailing slash from HELIOS_URL', async () => {
    heliosEnv.HELIOS_URL = `${BASE}/`
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    await HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000001')

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toBe(`${BASE}/helios/elections/aaaaaaaa-0000-4000-8000-000000000001`)
    expect(url.split('://')[1]).not.toContain('//')
  })
})

describe('HeliosClient — service account session', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('logs in via the Django form flow before an admin action', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/new': () =>
        res({ status: 302, location: `${BASE}/helios/elections/aaaaaaaa-0000-4000-8000-000000000002/view` }),
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000002': () =>
        res({ ok: true, json: { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Test Wahl', num_cast_votes: 0 } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await HeliosClient.createElection({
      short_name: 'test-wahl',
      name: 'Test Wahl',
      description: '',
      voting_starts_at: '2026-05-01T10:00:00Z',
      voting_ends_at: '2026-05-08T10:00:00Z',
    })

    const loginCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === `${BASE}/auth/password/login` && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(loginCall).toBeDefined()
    const body = (loginCall![1] as RequestInit).body as string
    expect(body).toContain('username=bot%40test.de')
    expect(body).toContain('password=secret')
  })

  it('throws HeliosServiceAuthError when the login form does not return 302', async () => {
    // A failed service-account login re-renders the login page with HTTP 200
    // (this is exactly what happens when the Helios DB has no service account,
    // e.g. after a clean-slate reseed). The client must surface a *typed* auth
    // error so the route can return a specific "service account" diagnostic
    // rather than a generic "Helios unreachable".
    const mockFetch = heliosFetchMock({
      'POST /auth/password/login': () => res({ status: 200, text: 'login form re-rendered' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, HeliosServiceAuthError, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await expect(
      HeliosClient.createElection({
        short_name: 'w',
        name: 'W',
        description: '',
        voting_starts_at: '2026-05-01T10:00:00Z',
        voting_ends_at: '2026-05-08T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(HeliosServiceAuthError)
  })

  it('reuses the cached session instead of re-authenticating', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/new': () =>
        res({ status: 302, location: `${BASE}/helios/elections/aaaaaaaa-0000-4000-8000-000000000013/view` }),
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000013': () =>
        res({ ok: true, json: { uuid: 'aaaaaaaa-0000-4000-8000-000000000013', name: 'X', num_cast_votes: 0 } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    const input = {
      name: 'N',
      description: '',
      voting_starts_at: '2026-05-01T10:00:00Z',
      voting_ends_at: '2026-05-08T10:00:00Z',
    }
    await HeliosClient.createElection({ ...input, short_name: 'w1' })
    await HeliosClient.createElection({ ...input, short_name: 'w2' })

    const logins = mockFetch.mock.calls.filter(
      ([url, init]) =>
        url === `${BASE}/auth/password/login` && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(logins).toHaveLength(1)
  })
})

describe('HeliosClient — admin methods', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('setQuestions posts to the save_questions endpoint', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/save_questions': () => res({ status: 200, text: 'SUCCESS' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await HeliosClient.setQuestions('0f8fad5b-d9cb-469f-a165-70867728950e', [
      {
        question: 'Ja oder Nein?',
        short_name: 'q1',
        answer_type: 'approval',
        answers: ['Ja', 'Nein', 'Enthaltung'],
        min: 1,
        max: 1,
      },
    ])

    const call = mockFetch.mock.calls.find(
      ([url]) => url === `${BASE}/helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/save_questions`,
    )
    expect(call).toBeDefined()
    expect((call![1] as RequestInit).method).toBe('POST')
  })

  it('freeze posts to the freeze endpoint', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/freeze': () => res({ status: 302 }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await HeliosClient.freeze('0f8fad5b-d9cb-469f-a165-70867728950e')

    const call = mockFetch.mock.calls.find(([url]) => url === `${BASE}/helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/freeze`)
    expect(call).toBeDefined()
    expect((call![1] as RequestInit).method).toBe('POST')
  })

  it('bulkUploadVoters uploads, confirms, and polls until voters appear', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/voters/upload': () => res({ status: 200 }),
      'GET /helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/voters/': () =>
        res({ ok: true, json: [{ uuid: 'v1' }, { uuid: 'v2' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    const result = await HeliosClient.bulkUploadVoters('0f8fad5b-d9cb-469f-a165-70867728950e', [
      { email: 'a@uni.de', name: 'Anna' },
      { email: 'b@uni.de', name: 'Ben' },
    ])

    expect(result.num_voters).toBe(2)
    const uploadCall = mockFetch.mock.calls.find(
      ([url]) => url === `${BASE}/helios/elections/0f8fad5b-d9cb-469f-a165-70867728950e/voters/upload`,
    )
    expect(uploadCall).toBeDefined()
  })
})

describe('deriveLifecycle', () => {
  it('returns draft when frozen_at is null', async () => {
    const { deriveLifecycle } = await import('./helios-client')
    expect(
      deriveLifecycle({
        uuid: 'x',
        short_name: 'x',
        name: 'x',
        description: '',
        frozen_at: null,
        voting_starts_at: null,
        voting_ends_at: null,
        archived_at: null,
        num_cast_votes: 0,
        result: null,
        result_proof: null,
      })
    ).toBe('draft')
  })

  it('returns open when frozen and voting_ends_at is in the future', async () => {
    const { deriveLifecycle } = await import('./helios-client')
    const future = new Date(Date.now() + 86400_000).toISOString()
    expect(
      deriveLifecycle({
        uuid: 'x',
        short_name: 'x',
        name: 'x',
        description: '',
        frozen_at: '2026-04-01T00:00:00Z',
        voting_starts_at: '2026-04-01T00:00:00Z',
        voting_ends_at: future,
        archived_at: null,
        num_cast_votes: 5,
        result: null,
        result_proof: null,
      })
    ).toBe('open')
  })

  it('returns closed when voting_ends_at is in the past', async () => {
    const { deriveLifecycle } = await import('./helios-client')
    expect(
      deriveLifecycle({
        uuid: 'x',
        short_name: 'x',
        name: 'x',
        description: '',
        frozen_at: '2026-04-01T00:00:00Z',
        voting_starts_at: '2026-04-01T00:00:00Z',
        voting_ends_at: '2026-04-10T00:00:00Z',
        archived_at: null,
        num_cast_votes: 41,
        result: { questions: [] },
        result_proof: null,
      })
    ).toBe('closed')
  })
})

// netcup T03 review round 2 — the login POST is answered with `redirect:
// 'manual'` and then step 3 fetches whatever Location came back, carrying the
// freshly-minted service-account `sessionid` cookie. A Helios that has been
// compromised, misconfigured or MITM'd can therefore point that Location at any
// host and harvest an admin session. Only a SAME-ORIGIN Location may be followed.
describe('HeliosClient — service login redirect is origin-pinned', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    heliosEnv.HELIOS_URL = BASE
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const offOrigin: Array<[label: string, location: string]> = [
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['an attacker-controlled host', 'https://evil.example/auth/after'],
    ['a protocol-relative authority', '//evil.example/auth/after'],
  ]

  for (const [label, location] of offOrigin) {
    it(`refuses to follow a login redirect to ${label}`, async () => {
      const mockFetch = heliosFetchMock({
        'POST /auth/password/login': () =>
          res({ status: 302, cookies: 'sessionid=sess-1', location }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const { HeliosClient, HeliosServiceAuthError, _resetSessionForTest } =
        await import('./helios-client')
      _resetSessionForTest()

      await expect(
        HeliosClient.createElection({
          short_name: 'w',
          name: 'W',
          description: '',
          voting_starts_at: '2026-05-01T10:00:00Z',
          voting_ends_at: '2026-05-08T10:00:00Z',
        }),
      ).rejects.toBeInstanceOf(HeliosServiceAuthError)

      // The session cookie must never have left the pinned Helios origin.
      for (const [url, init] of mockFetch.mock.calls) {
        const target = new URL(String(url), BASE)
        expect(target.origin).toBe(new URL(BASE).origin)
        void init
      }
    })
  }

  it('still follows a same-origin login redirect', async () => {
    const mockFetch = heliosFetchMock({
      'POST /auth/password/login': () =>
        res({ status: 302, cookies: 'sessionid=sess-1', location: `${BASE}/auth/after` }),
      'POST /helios/elections/new': () =>
        res({ status: 302, location: `${BASE}/helios/elections/aaaaaaaa-0000-4000-8000-000000000003/view` }),
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000003': () =>
        res({ ok: true, json: { uuid: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'OK', num_cast_votes: 0 } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await HeliosClient.createElection({
      short_name: 'ok',
      name: 'OK',
      description: '',
      voting_starts_at: '2026-05-01T10:00:00Z',
      voting_ends_at: '2026-05-08T10:00:00Z',
    })

    const afterCall = mockFetch.mock.calls.find(([url]) => String(url) === `${BASE}/auth/after`)
    expect(afterCall).toBeDefined()
  })
})

// netcup T03 round 3 — the login redirect was pinned in round 2, but
// `heliosAdminFetch` (and its 401/403 retry) still defaulted to
// `redirect: 'follow'` while attaching the service-account `sessionid`. A
// response-controlled Location therefore drove a server-side fetch to an
// arbitrary origin. Every cookie-carrying fetch in this file must be manual.
describe('HeliosClient — no cookie-carrying fetch follows a redirect', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    heliosEnv.HELIOS_URL = BASE
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** Assert the invariant over every call the client actually made. */
  function assertNoFollowedCookieFetch(mockFetch: ReturnType<typeof heliosFetchMock>) {
    let cookieCalls = 0
    for (const [url, init] of mockFetch.mock.calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers.Cookie) {
        cookieCalls += 1
        expect(init?.redirect, `redirect for ${String(url)}`).toBe('manual')
      }
      expect(new URL(String(url), BASE).origin).toBe(new URL(BASE).origin)
    }
    expect(cookieCalls).toBeGreaterThan(0)
  }

  it('does not follow an admin-API redirect off-origin with the service cookie', async () => {
    const mockFetch = heliosFetchMock({
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000004/voters/': () =>
        res({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await expect(HeliosClient.listVoters('aaaaaaaa-0000-4000-8000-000000000004')).rejects.toThrow(/Helios admin/)
    assertNoFollowedCookieFetch(mockFetch)
  })

  it('does not follow a redirect on the 401 re-auth retry either', async () => {
    let seen = 0
    const mockFetch = heliosFetchMock({
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000005/voters/': () => {
        seen += 1
        return seen === 1
          ? res({ status: 401 })
          : res({ status: 302, location: 'https://evil.example/voters' })
      },
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await expect(HeliosClient.listVoters('aaaaaaaa-0000-4000-8000-000000000005')).rejects.toThrow(/Helios admin/)
    expect(seen).toBe(2)
    assertNoFollowedCookieFetch(mockFetch)
  })

  // T03 round 4 — `heliosFetch` (the unauthenticated read path: getElection,
  // getElectionFull, getResult) was the LAST fetch in this file still on the
  // default `redirect: 'follow'`. Round 3's own comment claimed the admin pair
  // were "the last cookie-carrying fetches that defaulted to follow", which is
  // true only of the cookie-carrying ones — this one was left behind. A
  // Helios-controlled 302 therefore drove a server-side request to an arbitrary
  // origin, and undici replays the request there: a same-site Location keeps
  // request headers, so any cookie the runtime attaches to a Helios call rides
  // along. Manual redirects make the 302 a plain non-ok status instead.
  it('does not follow a read-path redirect off-origin', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      res({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000007')).rejects.toThrow(/Helios/)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(new URL(String(url), BASE).origin).toBe(new URL(BASE).origin)
    expect((init as RequestInit | undefined)?.redirect).toBe('manual')
  })

  it('still returns the body of a normal admin response', async () => {
    const mockFetch = heliosFetchMock({
      'GET /helios/elections/aaaaaaaa-0000-4000-8000-000000000006/voters/': () => res({ json: [{ uuid: 'v1' }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await expect(HeliosClient.listVoters('aaaaaaaa-0000-4000-8000-000000000006')).resolves.toEqual([{ uuid: 'v1' }])
    assertNoFollowedCookieFetch(mockFetch)
  })
})

// netcup T03 round 5 — round 4 removed follow-redirect from the read path
// WHOLESALE, without asking what following did besides obeying an attacker's
// 302. Django's APPEND_SLASH answers `/helios/elections/<uuid>` (the exact path
// helios-client.ts:393/:397 requests) with a 301 to the slashed form. Under
// round 4 that 301 landed in heliosFetch's non-degradable `throw new Error`
// branch, so a perfectly healthy Helios made the elections page DROP the row
// instead of rendering the degraded card. The fix is not "follow again" — it is
// to follow only what is provably still Helios: at most two hops, same-origin
// only, with an off-origin Location becoming a degradable HeliosUnavailableError
// that is never dialled.
describe('HeliosClient — read path follows bounded same-origin redirects', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    heliosEnv.HELIOS_URL = BASE
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** No request left the Helios origin, and none of them carried a cookie. */
  function assertNothingLeftTheOrigin(mockFetch: ReturnType<typeof vi.fn>) {
    for (const [url, init] of mockFetch.mock.calls) {
      expect(new URL(String(url), BASE).origin, `origin of ${String(url)}`).toBe(new URL(BASE).origin)
      const headers = ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>
      expect(headers.Cookie, `cookie on ${String(url)}`).toBeUndefined()
      expect((init as RequestInit | undefined)?.redirect).toBe('manual')
    }
  }

  it('follows a same-origin 301 (Django APPEND_SLASH) and returns the target body', async () => {
    const mockFetch = vi.fn(async (input: string) => {
      const path = String(input).replace(BASE, '')
      if (path === '/helios/elections/aaaaaaaa-0000-4000-8000-000000000008')
        return res({ status: 301, location: '/helios/elections/aaaaaaaa-0000-4000-8000-000000000008/' })
      if (path === '/helios/elections/aaaaaaaa-0000-4000-8000-000000000008/') return res({ json: { uuid: 'aaaaaaaa-0000-4000-8000-000000000008' } })
      throw new Error(`unmocked Helios call: ${path}`)
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000008')).resolves.toEqual({ uuid: 'aaaaaaaa-0000-4000-8000-000000000008' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    assertNothingLeftTheOrigin(mockFetch)
  })

  it('follows an absolute same-origin 302 as well', async () => {
    const mockFetch = vi.fn(async (input: string) => {
      const path = String(input).replace(BASE, '')
      if (path === '/helios/elections/aaaaaaaa-0000-4000-8000-000000000009')
        return res({ status: 302, location: `${BASE}/helios/elections/aaaaaaaa-0000-4000-8000-000000000009/view` })
      if (path === '/helios/elections/aaaaaaaa-0000-4000-8000-000000000009/view') return res({ json: { uuid: 'aaaaaaaa-0000-4000-8000-000000000009' } })
      throw new Error(`unmocked Helios call: ${path}`)
    })
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient } = await import('./helios-client')
    await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000009')).resolves.toEqual({ uuid: 'aaaaaaaa-0000-4000-8000-000000000009' })
    assertNothingLeftTheOrigin(mockFetch)
  })

  const offOrigin: Array<[label: string, location: string]> = [
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['an attacker-controlled host', 'https://evil.example/helios/elections/x'],
    ['the same host on another port', 'http://helios-test:9000/helios/elections/x'],
    ['the same host over another scheme', 'https://helios-test:8000/helios/elections/x'],
  ]

  for (const [label, location] of offOrigin) {
    it(`turns a redirect to ${label} into a degradable HeliosUnavailableError and never dials it`, async () => {
      const mockFetch = vi.fn(async () => res({ status: 302, location }))
      vi.stubGlobal('fetch', mockFetch)

      const { HeliosClient, HeliosUnavailableError } = await import('./helios-client')
      await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000010')).rejects.toBeInstanceOf(HeliosUnavailableError)
      // Exactly one call: the redirect target was never requested, so neither
      // the service cookie nor any other header could reach it.
      expect(mockFetch).toHaveBeenCalledTimes(1)
      assertNothingLeftTheOrigin(mockFetch)
    })
  }

  it('bounds a same-origin redirect loop at two follows and degrades', async () => {
    const mockFetch = vi.fn(async () => res({ status: 302, location: '/helios/elections/aaaaaaaa-0000-4000-8000-000000000011' }))
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, HeliosUnavailableError } = await import('./helios-client')
    await expect(HeliosClient.getElection('aaaaaaaa-0000-4000-8000-000000000011')).rejects.toBeInstanceOf(HeliosUnavailableError)
    expect(mockFetch).toHaveBeenCalledTimes(3) // initial + at most two follows
    assertNothingLeftTheOrigin(mockFetch)
  })

  it('degrades when a 3xx carries no Location at all', async () => {
    const mockFetch = vi.fn(async () => res({ status: 302 }))
    vi.stubGlobal('fetch', mockFetch)

    const { HeliosClient, HeliosUnavailableError } = await import('./helios-client')
    await expect(HeliosClient.getResult('aaaaaaaa-0000-4000-8000-000000000012')).rejects.toBeInstanceOf(HeliosUnavailableError)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// R30-FOLLOWUPS-S item 8a — the in-process client interpolated `helios_uuid`
// into the Helios path unvalidated and unencoded: `../admin` or `%2e%2e/..`
// reached an arbitrary Helios path. Mirrors the votes leaf's guard
// (services/votes/src/helios/helios-client.ts, K5#41): only a UUID is ever
// interpolated, and it is encodeURIComponent'd. A malformed id is a caller bug,
// so it is a plain Error, NOT the degradable HeliosUnavailableError.
describe('HeliosClient — a non-UUID election id is refused with no request (8a)', () => {
  const GOOD = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const hostile = ['../admin', '%2e%2e', 'a/b', 'hel-vorstand-26', '', `${GOOD}/../x`, `${GOOD}?x=1`]

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const reads = ['getElection', 'getElectionFull', 'getResult', 'listVoters'] as const
  for (const method of reads) {
    it.each(hostile)(`${method} rejects %j and never calls fetch`, async (id) => {
      const mockFetch = heliosFetchMock()
      vi.stubGlobal('fetch', mockFetch)
      const { HeliosClient, HeliosUnavailableError } = await import('./helios-client')

      const result = HeliosClient[method](id)
      // Rejects (never throws synchronously) so `await ... catch` behaves as for the leaf.
      await expect(result).rejects.toThrow(/invalid helios election uuid/i)
      await expect(HeliosClient[method](id)).rejects.not.toBeInstanceOf(HeliosUnavailableError)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  const writes: Array<[string, (c: typeof import('./helios-client').HeliosClient, id: string) => Promise<unknown>]> = [
    ['setQuestions', (c, id) => c.setQuestions(id, [])],
    ['bulkUploadVoters', (c, id) => c.bulkUploadVoters(id, [{ email: 'a@uni.de', name: 'Anna' }])],
    ['freeze', (c, id) => c.freeze(id)],
  ]
  for (const [name, call] of writes) {
    it.each(hostile)(`${name} rejects %j and never calls fetch`, async (id) => {
      const mockFetch = heliosFetchMock()
      vi.stubGlobal('fetch', mockFetch)
      const { HeliosClient } = await import('./helios-client')
      await expect(call(HeliosClient, id)).rejects.toThrow(/invalid helios election uuid/i)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it('createElection rejects a Location whose id is not a UUID (it is validated by getElection)', async () => {
    const mockFetch = heliosFetchMock({
      'POST /helios/elections/new': () =>
        res({ status: 302, location: `${BASE}/helios/elections/not-a-uuid/view` }),
    })
    vi.stubGlobal('fetch', mockFetch)
    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()
    await expect(
      HeliosClient.createElection({
        short_name: 'w',
        name: 'W',
        description: '',
        voting_starts_at: '2026-05-01T10:00:00Z',
        voting_ends_at: '2026-05-08T10:00:00Z',
      }),
    ).rejects.toThrow(/invalid helios election uuid/i)
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('not-a-uuid'))).toBe(false)
  })

  it('a valid uuid is fetched at exactly the plain Helios paths', async () => {
    const mockFetch = heliosFetchMock({
      [`GET /helios/elections/${GOOD}`]: () => res({ json: { uuid: GOOD } }),
      [`GET /helios/elections/${GOOD}/result`]: () => res({ json: { questions: [] } }),
      [`GET /helios/elections/${GOOD}/voters/`]: () => res({ json: [] }),
    })
    vi.stubGlobal('fetch', mockFetch)
    const { HeliosClient, _resetSessionForTest } = await import('./helios-client')
    _resetSessionForTest()

    await HeliosClient.getElection(GOOD)
    await HeliosClient.getElectionFull(GOOD)
    await HeliosClient.getResult(GOOD)
    await HeliosClient.listVoters(GOOD)

    const urls = mockFetch.mock.calls.map(([u]) => String(u))
    expect(urls).toContain(`${BASE}/helios/elections/${GOOD}`)
    expect(urls).toContain(`${BASE}/helios/elections/${GOOD}/result`)
    expect(urls).toContain(`${BASE}/helios/elections/${GOOD}/voters/`)
  })

  it('isHeliosUuid accepts a real uuid and rejects slugs and non-strings', async () => {
    const { isHeliosUuid } = await import('./helios-client')
    expect(isHeliosUuid(GOOD)).toBe(true)
    expect(isHeliosUuid('hel-vorstand-26')).toBe(false)
    expect(isHeliosUuid(7)).toBe(false)
  })
})
