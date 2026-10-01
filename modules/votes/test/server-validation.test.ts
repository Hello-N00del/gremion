// modules/votes/test/server-validation.test.ts
//
// F1-FIX-08-K: request validation + boot config for the votes leaf.
//   * K5#41 / S4#25: Helios election uuids are interpolated into a request path;
//     they must be validated (400) and encoded, never trusted.
//   * H16: POST /api/v1/polls must forward description + expire (anonymous was
//     already forwarded; the client dropped the rest).
//   * K5#29 / S4#18: the leaf refuses to boot without a Nextcloud admin password.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer, type HeliosPort, type PollsPort } from '../src/http/server.ts'
import { HeliosClient, type HeliosElection } from '../src/helios/helios-client.ts'
import type { CreatePollDto, NcPoll } from '../src/polls/polls-client.ts'
import { bootConfigProblems } from '../src/boot-config.ts'

const SECRET = 'topsecret-shared-value'
const GOOD_UUID = '3f2a9c1e-7b4d-4e5a-9d3c-1a2b3c4d5e6f'
const hdrs = {
  'content-type': 'application/json',
  'x-internal-auth': SECRET,
  'x-tenant-id': '11111111-1111-1111-1111-111111111111',
  'x-tenant-slug': 'alpha',
}

function election(uuid: string): HeliosElection {
  return {
    uuid,
    short_name: uuid,
    name: uuid,
    description: '',
    voting_starts_at: null,
    voting_ends_at: null,
    frozen_at: null,
    archived_at: null,
    num_cast_votes: 0,
    result: null,
    result_proof: null,
  }
}

describe('votes leaf HTTP validation', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  const heliosCalls: string[] = []
  const created: CreatePollDto[] = []

  const helios: HeliosPort = {
    async getElection(uuid: string) {
      heliosCalls.push(uuid)
      return election(uuid)
    },
  }
  const polls: PollsPort = {
    async listPolls(): Promise<NcPoll[]> {
      return []
    },
    async createPoll(dto: CreatePollDto): Promise<NcPoll> {
      created.push(dto)
      return {} as NcPoll
    },
  }

  beforeAll(async () => {
    server = createServer({ secret: SECRET, helios, polls })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  beforeEach(() => {
    heliosCalls.length = 0
    created.length = 0
  })

  const post = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', headers: hdrs, body })

  it('/api/v1/votes accepts well-formed uuids', async () => {
    const res = await post('/api/v1/votes', JSON.stringify({ electionUuids: [GOOD_UUID] }))
    expect(res.status).toBe(200)
    expect(heliosCalls).toEqual([GOOD_UUID])
  })

  it('/api/v1/votes rejects a path-shaped election uuid with 400 and never calls Helios', async () => {
    for (const bad of ['../admin', 'abc/../def', '%2e%2e%2fadmin', `${GOOD_UUID}/../x`, 'ok-1', '']) {
      const res = await post('/api/v1/votes', JSON.stringify({ electionUuids: [GOOD_UUID, bad] }))
      expect(res.status, `uuid ${JSON.stringify(bad)}`).toBe(400)
    }
    expect(heliosCalls).toEqual([])
  })

  it('/api/v1/votes rejects a non-array electionUuids, an oversized list and malformed JSON with 400', async () => {
    expect((await post('/api/v1/votes', JSON.stringify({ electionUuids: GOOD_UUID }))).status).toBe(400)
    const many = Array.from({ length: 101 }, () => GOOD_UUID)
    expect((await post('/api/v1/votes', JSON.stringify({ electionUuids: many }))).status).toBe(400)
    expect((await post('/api/v1/votes', '{not json')).status).toBe(400)
    expect(heliosCalls).toEqual([])
  })

  it('/api/v1/polls forwards description and expire alongside anonymous (H16)', async () => {
    const res = await post(
      '/api/v1/polls',
      JSON.stringify({
        title: 'Mensa?',
        type: 'textPoll',
        options: ['A', 'B'],
        anonymous: true,
        description: 'Wohin?',
        expire: 1_900_000_000,
      }),
    )
    expect(res.status).toBe(200)
    expect(created.at(-1)).toEqual({
      title: 'Mensa?',
      type: 'textPoll',
      options: ['A', 'B'],
      anonymous: true,
      description: 'Wohin?',
      expire: 1_900_000_000,
    })
  })

  it('/api/v1/polls rejects malformed optional fields and an unknown type with 400', async () => {
    const base_ = { title: 'T', type: 'textPoll', options: ['A'], anonymous: false }
    for (const bad of [
      { ...base_, description: 42 },
      { ...base_, expire: 'tomorrow' },
      { ...base_, expire: -1 },
      { ...base_, type: 'weirdPoll' },
    ]) {
      expect((await post('/api/v1/polls', JSON.stringify(bad))).status).toBe(400)
    }
    expect(created).toEqual([])
  })
})

describe('HeliosClient.getElection path safety (K5#41)', () => {
  const realFetch = globalThis.fetch
  let urls: string[]
  beforeEach(() => {
    urls = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(election(GOOD_UUID)), { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('requests /helios/elections/<uuid> for a valid uuid', async () => {
    await HeliosClient.getElection(GOOD_UUID)
    expect(urls[0]).toMatch(new RegExp(`/helios/elections/${GOOD_UUID}$`))
  })

  it('refuses a path-shaped uuid before any network call', async () => {
    await expect(HeliosClient.getElection('../admin')).rejects.toThrow(/invalid helios election uuid/i)
    expect(urls).toEqual([])
  })
})

describe('bootConfigProblems (K5#29 / S4#18)', () => {
  it('flags an empty or missing Nextcloud admin password as fatal', () => {
    expect(bootConfigProblems({ NEXTCLOUD_ADMIN_PASSWORD: '' }).join(' ')).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
    expect(bootConfigProblems({}).join(' ')).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
    expect(bootConfigProblems({ NEXTCLOUD_ADMIN_PASSWORD: '   ' }).join(' ')).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
  })
  it('reports nothing for a configured password', () => {
    expect(bootConfigProblems({ NEXTCLOUD_ADMIN_PASSWORD: 'pw' })).toEqual([])
  })
})
