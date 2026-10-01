// modules/votes/test/polls-client.test.ts
//
// F1-FIX-08-K / H16: createPoll used to drop `anonymous`, `description` and
// `expire`, so an "Anonym" poll was created NON-anonymous. Nextcloud Polls v9
// POST /poll consumes only { type, title }; the rest has to be applied with a
// follow-up PUT /poll/{id} { pollConfiguration }. These tests drive the real
// client against a stubbed fetch and assert what goes over the wire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextcloudPollsClient, type NcPoll } from '../src/polls/polls-client.ts'

interface Call {
  method: string
  path: string
  body: unknown
}

function ocs(data: unknown): Response {
  return new Response(JSON.stringify({ ocs: { meta: { status: 'ok' }, data } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function poll(over: Partial<NcPoll['configuration']> = {}): NcPoll {
  return {
    id: 42,
    type: 'textPoll',
    configuration: {
      title: 'Mensa?',
      description: '',
      allowComment: false,
      anonymous: false,
      expire: 0,
      ...over,
    },
    status: { expired: false, countOptions: 0 },
    currentUserStatus: { userRole: 'owner', isLocked: false, countVotes: 0 },
  }
}

describe('NextcloudPollsClient.createPoll (H16)', () => {
  let calls: Call[]
  let failOn: string | null
  const realFetch = globalThis.fetch

  beforeEach(() => {
    calls = []
    failOn = null
    process.env.NEXTCLOUD_URL = 'http://nc.test'
    process.env.NEXTCLOUD_ADMIN_USER = 'admin'
    process.env.NEXTCLOUD_ADMIN_PASSWORD = 'pw'
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = url.pathname.replace('/ocs/v2.php/apps/polls/api/v1.0', '')
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      if (failOn === `${method} ${path}`) return new Response('nope', { status: 500 })
      if (method === 'POST' && path === '/poll') return ocs({ poll: poll() })
      if (method === 'POST' && path === '/poll/42/options') return ocs({ options: [] })
      if (method === 'PUT' && path === '/poll/42') {
        const cfg = (body as { pollConfiguration: Partial<NcPoll['configuration']> }).pollConfiguration
        return ocs({ poll: poll(cfg) })
      }
      if (method === 'DELETE' && path === '/poll/42') return ocs({})
      return new Response('unexpected', { status: 404 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('PUTs a pollConfiguration carrying anonymous:true, description and expire, and the result reflects them', async () => {
    const created = await NextcloudPollsClient.createPoll({
      title: 'Mensa?',
      type: 'textPoll',
      options: ['A', 'B'],
      anonymous: true,
      description: 'Wohin gehen wir?',
      expire: 1_900_000_000,
    })

    const put = calls.find((c) => c.method === 'PUT' && c.path === '/poll/42')
    expect(put, 'a PUT /poll/42 pollConfiguration call must be made').toBeDefined()
    expect(put!.body).toEqual({
      pollConfiguration: { anonymous: true, description: 'Wohin gehen wir?', expire: 1_900_000_000 },
    })
    expect(created.configuration.anonymous).toBe(true)
    expect(created.configuration.description).toBe('Wohin gehen wir?')
    expect(created.configuration.expire).toBe(1_900_000_000)
  })

  it('applies the configuration AFTER the options are in place', async () => {
    await NextcloudPollsClient.createPoll({ title: 'T', type: 'textPoll', options: ['A'], anonymous: true })
    const order = calls.map((c) => `${c.method} ${c.path}`)
    expect(order).toEqual(['POST /poll', 'POST /poll/42/options', 'PUT /poll/42'])
  })

  it('makes no configuration call for a plain named poll (nothing to apply)', async () => {
    await NextcloudPollsClient.createPoll({ title: 'T', type: 'textPoll', options: ['A'], anonymous: false })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('rolls the poll back when the configuration write fails: never leave a non-anonymous "Anonym" poll behind', async () => {
    failOn = 'PUT /poll/42'
    await expect(
      NextcloudPollsClient.createPoll({ title: 'T', type: 'textPoll', options: ['A'], anonymous: true }),
    ).rejects.toThrow(/500/)
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/poll/42' })
  })
})
