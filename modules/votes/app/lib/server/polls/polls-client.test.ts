import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TASK-205b: the service endpoints (Matrix, Helios, LiveKit, Nextcloud) come through the serviceEnv seam, the
// successor of the deleted default-tenant env reader. This suite feeds the seam the same values it already
// feeds its `$env/dynamic/private` mock, so every case keeps its own env fixture.
vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
// Polls are tenant-bound: the client reads the request's tenant (fail-closed without one).
vi.mock('$lib/server/tenant/context', () => ({ getTenant: () => ({ id: 'tenant-a', slug: 'tenant-a' }) }))
vi.mock('$env/dynamic/private', () => ({
  env: {
    NEXTCLOUD_URL: 'http://nextcloud-test',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'secret',
  },
}))

// Polls v9 serves its REST API on the OCS mount (ocs/v2.php), which wraps every
// payload in { ocs: { meta, data } }. The legacy index.php/apps/polls mount now
// only answers the OPTIONS preflight (GET → 405), so the client must target OCS
// and unwrap the envelope.
const OCS_BASE = 'http://nextcloud-test/ocs/v2.php/apps/polls/api/v1.0'
const ocs = (data: unknown, statuscode = 200) => ({
  ocs: { meta: { status: 'ok', statuscode, message: 'OK' }, data },
})

describe('NextcloudPollsClient', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    // vitest 4's vi.restoreAllMocks() (afterEach, below) only restores
    // vi.spyOn() spies — it no longer implicitly resets a plain vi.fn()'s
    // call history / queued once-implementations. Without this, mockFetch's
    // mock.calls accumulate across tests in this describe block and each
    // test's mockFetch.mock.calls[0] silently picks up a PRIOR test's call.
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const mockPoll = {
    id: 1,
    type: 'textPoll',
    owner: { userId: 'admin' },
    configuration: { title: '[gt:tenant-a] Test Poll', description: '', allowComment: false, anonymous: false, expire: 0 },
    status: { expired: false, countOptions: 0 },
    currentUserStatus: { userRole: 'owner', isLocked: false, countVotes: 0 },
  }

  it('listPolls targets the OCS mount and unwraps ocs.data.polls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ocs({ polls: [mockPoll] })),
    })

    const { NextcloudPollsClient } = await import('./polls-client')
    const polls = await NextcloudPollsClient.listPolls()

    expect(mockFetch).toHaveBeenCalledWith(
      `${OCS_BASE}/polls`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'OCS-APIRequest': 'true',
          Accept: 'application/json',
        }),
      }),
    )
    expect(polls).toHaveLength(1)
    expect(polls[0].id).toBe(1)
  })

  it('listPolls includes Basic auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ocs({ polls: [] })),
    })

    const { NextcloudPollsClient } = await import('./polls-client')
    await NextcloudPollsClient.listPolls()

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    )
  })

  it('createPollsClient({ oidcBearer }) sends the user Bearer token instead of admin Basic (#411)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ocs({ polls: [] })),
    })

    const { createPollsClient } = await import('./polls-client')
    await createPollsClient({ oidcBearer: 'kc-token' }).listPolls()

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer kc-token')
  })

  it('getPoll fetches single poll by id and unwraps the envelope', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) })

    const { NextcloudPollsClient } = await import('./polls-client')
    const poll = await NextcloudPollsClient.getPoll(1)

    expect(mockFetch).toHaveBeenCalledWith(`${OCS_BASE}/poll/1`, expect.anything())
    expect(poll.id).toBe(1)
  })

  it('createPoll sends POST with body to the OCS mount', async () => {
    // First call: create poll (returns ocs.data.poll)
    // Subsequent calls: add options (return an OCS-wrapped empty payload)
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(ocs({})) })

    const { NextcloudPollsClient } = await import('./polls-client')
    await NextcloudPollsClient.createPoll({
      title: 'New Poll',
      type: 'textPoll',
      options: ['Ja', 'Nein'],
      anonymous: false,
    })

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe(`${OCS_BASE}/poll`)
    expect(opts.method).toBe('POST')
    // the server binds the poll to the calling tenant
    expect(JSON.parse(opts.body as string).title).toBe('[gt:tenant-a] New Poll')
  })

  it('createPoll opens the poll NC-side after creation — private polls 400 per-user reads (#411)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) }) // create
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(ocs({})) }) // options + configure

    const { NextcloudPollsClient } = await import('./polls-client')
    await NextcloudPollsClient.createPoll({
      title: 'New Poll',
      type: 'textPoll',
      options: ['Ja', 'Nein'],
      anonymous: false,
    })

    const configCall = mockFetch.mock.calls.find(
      ([url, opts]) => url === `${OCS_BASE}/poll/${mockPoll.id}` && opts.method === 'PUT'
    )
    expect(configCall).toBeDefined()
    // anonymous is ALWAYS sent explicitly (F1-FIX-08 H16): the requested
    // privacy setting must never depend on Nextcloud's default.
    expect(JSON.parse(configCall![1].body as string)).toEqual({
      pollConfiguration: { access: 'open', anonymous: false },
    })
  })

  // F1-FIX-08 (H16 / S1c#3): an "Anonym" poll used to be created
  // non-anonymous because createPoll dropped anonymous/description/expire.
  describe('createPoll applies the requested configuration (H16)', () => {
    const requested = {
      title: 'Geheime Umfrage',
      type: 'textPoll' as const,
      options: ['Ja', 'Nein'],
      anonymous: true,
      description: 'Bitte bis Freitag abstimmen',
      expire: 1767225600,
    }

    function routeFetch(putPoll: unknown) {
      mockFetch.mockImplementation((url: string, opts: { method?: string }) => {
        const method = opts?.method ?? 'GET'
        if (url === `${OCS_BASE}/poll` && method === 'POST') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) })
        }
        if (url === `${OCS_BASE}/poll/1` && method === 'PUT') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(ocs({ poll: putPoll })) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(ocs({})) })
      })
    }

    it('the pollConfiguration PUT carries anonymous:true, description and expire', async () => {
      routeFetch({
        ...mockPoll,
        configuration: {
          ...mockPoll.configuration,
          anonymous: true,
          description: requested.description,
          expire: requested.expire,
        },
      })
      const { NextcloudPollsClient } = await import('./polls-client')
      const poll = await NextcloudPollsClient.createPoll(requested)

      const putCall = mockFetch.mock.calls.find(
        ([u, o]) => u === `${OCS_BASE}/poll/1` && o?.method === 'PUT',
      )
      expect(putCall).toBeDefined()
      expect(JSON.parse(putCall![1].body as string)).toEqual({
        pollConfiguration: {
          access: 'open',
          anonymous: true,
          description: 'Bitte bis Freitag abstimmen',
          expire: 1767225600,
        },
      })
      // The returned poll reflects what Nextcloud stored, not the stale POST echo.
      expect(poll.configuration.anonymous).toBe(true)
      expect(poll.configuration.description).toBe('Bitte bis Freitag abstimmen')
      expect(poll.configuration.expire).toBe(1767225600)
    })

    it('rolls back and rejects when Nextcloud does not confirm the anonymity (privacy fail-closed)', async () => {
      routeFetch({ ...mockPoll, configuration: { ...mockPoll.configuration, anonymous: false } })
      const { NextcloudPollsClient } = await import('./polls-client')
      await expect(NextcloudPollsClient.createPoll(requested)).rejects.toThrow(/anonym/i)

      const deleteCall = mockFetch.mock.calls.find(
        ([u, o]) => u === `${OCS_BASE}/poll/1` && o?.method === 'DELETE',
      )
      expect(deleteCall).toBeDefined()
    })
  })

  it('createPoll persists options via one bulk POST to /poll/{id}/options with newline-joined text (#156)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) }) // create
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(ocs({})) }) // addBulk + configure (#411)

    const { NextcloudPollsClient } = await import('./polls-client')
    await NextcloudPollsClient.createPoll({
      title: 'New Poll',
      type: 'textPoll',
      options: ['Ja', 'Nein'],
      anonymous: false,
    })

    // v9.1.4 OptionApiController::addBulk lives on the PLURAL /options route and
    // reads a newline-separated `text` blob — NOT the legacy per-option
    // `pollOptionText` field, which has no `option` param and is silently rejected.
    const [url, opts] = mockFetch.mock.calls[1]
    expect(url).toBe(`${OCS_BASE}/poll/1/options`)
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({ text: 'Ja\nNein' })
    expect(opts.body as string).not.toContain('pollOptionText')
  })

  it('createPoll deletes the orphan poll and rejects when the option write fails (#156)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ocs({ poll: mockPoll })) }) // create ok
      .mockResolvedValueOnce({ ok: false, status: 400 }) // addBulk fails
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ocs({})) }) // rollback delete

    const { NextcloudPollsClient } = await import('./polls-client')
    await expect(
      NextcloudPollsClient.createPoll({
        title: 'New Poll',
        type: 'textPoll',
        options: ['Ja', 'Nein'],
        anonymous: false,
      }),
    ).rejects.toThrow('Nextcloud Polls')

    // a compensating DELETE was issued for the just-created poll → no unvotable orphan
    const deleteCall = mockFetch.mock.calls.find(
      ([u, o]) => u === `${OCS_BASE}/poll/1` && o?.method === 'DELETE',
    )
    expect(deleteCall).toBeDefined()
  })

  it('vote sends PUT to correct OCS path (after verifying poll ownership + option membership)', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.endsWith('/poll/1')
              ? ocs({ poll: mockPoll })
              : url.endsWith('/poll/1/options')
                ? ocs({ options: [{ id: 42, text: 'Ja', votes: { count: 0, yes: 0, no: 0, maybe: 0, currentUser: null } }] })
                : ocs({}),
          ),
      }),
    )

    const { createPollsClient } = await import('./polls-client')
    await createPollsClient({ oidcBearer: 'kc-token' }).vote(1, 42)

    const [url, opts] = mockFetch.mock.calls.at(-1)!
    expect(url).toBe(`${OCS_BASE}/option/42/vote/yes`)
    expect(opts.method).toBe('PUT')
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 405 })

    const { NextcloudPollsClient } = await import('./polls-client')
    await expect(NextcloudPollsClient.listPolls()).rejects.toThrow('Nextcloud Polls')
  })
})
