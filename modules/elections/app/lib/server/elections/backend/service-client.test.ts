// service-client.test.ts — votes leaf HTTP ACL contract.
// Pins the request/response ENVELOPE the ServiceVotesClient sends to the leaf
// against contracts/votes/openapi.votes-internal.json: URL path, POST method,
// required internal/tenant headers, JSON body shape, read-retry policy, and
// non-2xx → VotesServiceError. Flag OFF this client is never used at runtime;
// this test is the only thing pinning it to the leaf contract.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// getTenant() is fail-closed (throws without an AsyncLocalStorage context).
// Mock it so buildHeaders() can emit x-tenant-id / x-tenant-slug.
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

import { ServiceVotesClient, VotesServiceError } from './service-client'

// Load the committed contract — every path the client POSTs must be declared.
const CONTRACT = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../../../contracts/votes/openapi.votes-internal.json'),
    'utf8',
  ),
) as { paths: Record<string, unknown> }

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Strip the base URL → the contract-relative path (drops any query string). */
function contractPath(url: string): string {
  return new URL(url).pathname
}

beforeEach(() => {
  process.env.VOTES_SERVICE_URL = 'http://votes-service:8080'
  process.env.INTERNAL_VOTES_SECRET = 's3cr3t'
})

describe('ServiceVotesClient — leaf ACL contract', () => {
  it('kind is service', () => {
    expect(new ServiceVotesClient().kind).toBe('service')
  })

  it('listVotes: POST /api/v1/votes with secret+tenant+correlation headers and {electionUuids} body', async () => {
    const result = { votes: [{ id: 'helios:u1', kind: 'helios' }], degradedUuids: ['u2'], pollError: null }
    const fetchImpl = vi.fn(async () => jsonRes(result))
    const c = new ServiceVotesClient({ correlationId: 'corr-1', fetchImpl })
    const out = await c.listVotes(['u1', 'u2'])

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const path = contractPath(url)
    expect(path).toBe('/api/v1/votes')
    expect(CONTRACT.paths[path]).toBeDefined() // declared in the contract
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-internal-auth']).toBe('s3cr3t')
    expect(headers['x-tenant-id']).toBe('tenant-1')
    expect(headers['x-tenant-slug']).toBe('default')
    expect(headers['x-correlation-id']).toBe('corr-1')
    expect(JSON.parse(init.body as string)).toEqual({ electionUuids: ['u1', 'u2'] })
    expect(out).toEqual({ votes: [{ id: 'helios:u1', kind: 'helios' }], degradedUuids: ['u2'], pollError: null })
  })

  it('createPoll: POST /api/v1/polls with the {title,type,options,anonymous} body', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ success: true }))
    const c = new ServiceVotesClient({ fetchImpl })
    await c.createPoll({ title: 'T', type: 'textPoll', options: ['a', 'b'], anonymous: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(contractPath(url)).toBe('/api/v1/polls')
    expect(CONTRACT.paths['/api/v1/polls']).toBeDefined()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'T',
      type: 'textPoll',
      options: ['a', 'b'],
      anonymous: true,
    })
  })

  it('every op POSTs a path declared in the votes-internal contract', async () => {
    const declared = new Set(Object.keys(CONTRACT.paths))
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(contractPath(String(url)))
      return jsonRes({ votes: [], degradedUuids: [], pollError: null, success: true })
    })
    const c = new ServiceVotesClient({ fetchImpl })
    await c.listVotes(['u1'])
    await c.createPoll({ title: 'T', type: 'textPoll', options: ['a', 'b'], anonymous: false })
    for (const p of seen) expect(declared.has(p), `contract missing ${p}`).toBe(true)
    expect(seen).toHaveLength(2)
  })

  it('retries listVotes once on a 503, then succeeds (idempotent read)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonRes({ votes: [], degradedUuids: [], pollError: null }))
    const c = new ServiceVotesClient({ fetchImpl })
    expect(await c.listVotes(['u1'])).toEqual({ votes: [], degradedUuids: [], pollError: null })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry createPoll (write) and throws VotesServiceError on 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream boom', { status: 502 }))
    const c = new ServiceVotesClient({ fetchImpl })
    await expect(
      c.createPoll({ title: 'T', type: 'textPoll', options: ['a', 'b'], anonymous: false }),
    ).rejects.toBeInstanceOf(VotesServiceError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed when INTERNAL_VOTES_SECRET is unset', async () => {
    delete process.env.INTERNAL_VOTES_SECRET
    const fetchImpl = vi.fn(async () => jsonRes({ votes: [], degradedUuids: [], pollError: null }))
    const c = new ServiceVotesClient({ fetchImpl })
    await expect(c.listVotes(['u1'])).rejects.toThrow(/INTERNAL_VOTES_SECRET/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
