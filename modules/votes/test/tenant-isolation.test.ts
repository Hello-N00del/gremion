// Tenant isolation on the votes LEAF: Nextcloud Polls is one shared instance
// (one admin credential), so the leaf must bind every poll to the calling tenant
// (server-controlled marker on create) and filter on read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { NextcloudPollsClient } from '../src/polls/polls-client.ts'
import { createServer } from '../src/http/server.ts'
import { makeFakeNc } from '../app/lib/server/polls/fake-nc.ts'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const dto = (title: string) => ({ title, type: 'textPoll' as const, options: ['ja', 'nein'], anonymous: false })

let nc: ReturnType<typeof makeFakeNc>
beforeEach(() => {
  nc = makeFakeNc()
  vi.stubGlobal('fetch', vi.fn((u: string, i?: RequestInit) => nc.handler(String(u), i)))
  delete process.env.VOTES_LEGACY_POLL_TENANT_ID
})
afterEach(() => vi.unstubAllGlobals())

describe('leaf client: per-tenant creation binding + list filtering', () => {
  it('binds the poll to the creating tenant (marker set server-side, never from the title)', async () => {
    const created = await NextcloudPollsClient.createPoll(A, dto(`[gt:${B}] Hijack`))
    const stored = [...nc.polls.values()][0]
    expect(stored.title.startsWith(`[gt:${A}] `)).toBe(true)
    expect(created.configuration.title).toBe(`[gt:${B}] Hijack`) // only OUR marker stripped
  })

  it('tenant A never lists tenant B polls (and titles carry no marker)', async () => {
    await NextcloudPollsClient.createPoll(A, dto('A-Poll'))
    await NextcloudPollsClient.createPoll(B, dto('B-Poll'))
    expect((await NextcloudPollsClient.listPolls(A)).map((p) => p.configuration.title)).toEqual(['A-Poll'])
    expect((await NextcloudPollsClient.listPolls(B)).map((p) => p.configuration.title)).toEqual(['B-Poll'])
  })

  it('a forged marker inside a title does not leak the poll to another tenant', async () => {
    await NextcloudPollsClient.createPoll(A, dto(`[gt:${B}] sneaky`))
    expect(await NextcloudPollsClient.listPolls(B)).toEqual([])
  })

  it('untagged (pre-isolation) polls are invisible unless explicitly claimed by one tenant', async () => {
    nc.polls.set(900, { id: 900, type: 'textPoll', title: 'Legacy', description: '', anonymous: false, expire: 0, options: [], voters: new Map() })
    expect(await NextcloudPollsClient.listPolls(A)).toEqual([])
    process.env.VOTES_LEGACY_POLL_TENANT_ID = A
    expect((await NextcloudPollsClient.listPolls(A)).map((p) => p.id)).toEqual([900])
    expect(await NextcloudPollsClient.listPolls(B)).toEqual([])
  })

  it('a poll with a forged tenant marker created by a non-admin NC user is not listed (provenance)', async () => {
    nc.polls.set(901, { id: 901, type: 'textPoll', title: `[gt:${A}] Urabstimmung`, description: '', anonymous: false, expire: 0, options: [], voters: new Map(), owner: 'mallory' })
    await NextcloudPollsClient.createPoll(A, dto('Echt'))
    expect((await NextcloudPollsClient.listPolls(A)).map((p) => p.configuration.title)).toEqual(['Echt'])
  })

  it('a legacy unmarked poll is claimed only when it is also admin-owned', async () => {
    process.env.VOTES_LEGACY_POLL_TENANT_ID = A
    nc.polls.set(902, { id: 902, type: 'textPoll', title: 'Legacy fremd', description: '', anonymous: false, expire: 0, options: [], voters: new Map(), owner: 'mallory' })
    nc.polls.set(903, { id: 903, type: 'textPoll', title: 'Legacy echt', description: '', anonymous: false, expire: 0, options: [], voters: new Map(), owner: 'admin' })
    expect((await NextcloudPollsClient.listPolls(A)).map((p) => p.id)).toEqual([903])
  })

  it('creates the poll with an NC-side vote limit of one per member', async () => {
    const created = await NextcloudPollsClient.createPoll(A, dto('Limit'))
    expect(nc.polls.get(created.id)!.maxVotesPerUser).toBe(1)
  })

  it('refuses a missing / malformed tenant id (fail closed)', async () => {
    await expect(NextcloudPollsClient.listPolls('')).rejects.toThrow(/tenant/i)
    await expect(NextcloudPollsClient.createPoll('a b', dto('x'))).rejects.toThrow(/tenant/i)
  })
})

describe('leaf HTTP: tenant headers drive the scope', () => {
  const SECRET = 's3cret'
  const nativeFetch = globalThis.fetch
  let base = ''
  let server: ReturnType<typeof createServer>
  beforeEach(async () => {
    server = createServer({ secret: SECRET, helios: { getElection: async () => { throw new Error('x') } } })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // loopback goes to the real socket, Nextcloud calls to the shared fake
    vi.stubGlobal('fetch', (u: string, i?: RequestInit) =>
      String(u).startsWith(base) ? nativeFetch(u, i) : nc.handler(String(u), i))
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  const post = (tenant: string, path: string, body: unknown) =>
    nativeFetch(base + path, {
      method: 'POST',
      headers: { 'x-internal-auth': SECRET, 'x-tenant-id': tenant, 'x-tenant-slug': tenant === A ? 'alpha' : 'beta', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('create as A then list as B shows nothing; list as A shows it', async () => {
    expect((await post(A, '/api/v1/polls', dto('Nur A'))).status).toBe(200)
    const asB = (await (await post(B, '/api/v1/votes', {})).json()) as { votes: unknown[] }
    expect(asB.votes).toEqual([])
    const asA = (await (await post(A, '/api/v1/votes', {})).json()) as { votes: unknown[] }
    expect(asA.votes).toHaveLength(1)
  })
})
