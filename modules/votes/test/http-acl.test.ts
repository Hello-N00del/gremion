// services/votes/test/http-acl.test.ts
// The votes leaf is internal-only: every /api/v1/* route requires a constant-time
// x-internal-auth secret (timingSafeEqual) + tenant headers; /healthz is exempt.
// Mirrors services/files/test/http-acl.test.ts and adds end-to-end assertions for
// the two leaf endpoints — the /votes aggregation (settle per election, degrade
// the unreachable, merge via the aggregator) and the quick-poll create.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { checkGuard, isHealthzPath } from '../src/http/auth.ts'
import { createServer, type HeliosPort, type PollsPort } from '../src/http/server.ts'
import type { HeliosElection } from '../src/helios/helios-client.ts'
import type { CreatePollDto, NcPoll } from '../src/polls/polls-client.ts'

const SECRET = 'topsecret-shared-value'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    'x-tenant-slug': 'alpha',
    ...over,
  }
}

function election(uuid: string, over: Partial<HeliosElection> = {}): HeliosElection {
  return {
    uuid,
    short_name: uuid,
    name: `Election ${uuid}`,
    description: 'desc',
    voting_starts_at: '2026-01-01T00:00:00Z',
    voting_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
    frozen_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    num_cast_votes: 5,
    result: null,
    result_proof: null,
    ...over,
  }
}

function poll(id: number): NcPoll {
  return {
    id,
    type: 'textPoll',
    configuration: { title: `Poll ${id}`, description: '', allowComment: false, anonymous: true, expire: 0 },
    status: { expired: false, countOptions: 2 },
    currentUserStatus: { userRole: 'owner', isLocked: false, countVotes: 0 },
  }
}

// ── Unit: the guard (mirrors services/files guard tests) ───────────────────────

describe('isHealthzPath — guard exemption', () => {
  it('treats /healthz and /healthz/<sub> as exempt but not /healthzzz', () => {
    expect(isHealthzPath('/healthz')).toBe(true)
    expect(isHealthzPath('/healthz/ready')).toBe(true)
    expect(isHealthzPath('/api/v1/votes')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/votes', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/votes', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/votes', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/votes', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' })
  })
})

describe('checkGuard — tenant headers', () => {
  it('rejects a missing x-tenant-id with 400', () => {
    const r = checkGuard({ path: '/x', headers: headers({ 'x-tenant-id': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })
  it('rejects an invalid slug grammar (uppercase / underscore) with 400', () => {
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'Alpha' }), secret: SECRET }).ok).toBe(false)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'a_b' }), secret: SECRET }).ok).toBe(false)
  })
})

describe('checkGuard — evaluation order (no header oracle)', () => {
  it('checks the secret BEFORE tenant headers', () => {
    const r = checkGuard({ path: '/api/v1/votes', headers: { 'x-internal-auth': 'wrong' }, secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})

// ── End-to-end: the node:http server enforces the guard + composes the list ─────

describe('votes leaf HTTP server — ACL sits in front of the router + aggregation works', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  const heliosCalls: string[] = []
  const createdPolls: CreatePollDto[] = []

  // Fakes: OK_UUID resolves; anything else rejects (unreachable → degraded).
  // Election ids must be canonical UUIDs now (K5#41), so the fixtures are too.
  const OK_UUID = '00000000-0000-4000-8000-000000000001'
  const BAD_UUID = 'ffffffff-0000-4000-8000-000000000002'
  const helios: HeliosPort = {
    async getElection(uuid: string): Promise<HeliosElection> {
      heliosCalls.push(uuid)
      if (uuid === OK_UUID) return election(uuid)
      throw new TypeError('fetch failed')
    },
  }
  const polls: PollsPort = {
    async listPolls(): Promise<NcPoll[]> {
      return [poll(7)]
    },
    async createPoll(_tenantId: string, dto: CreatePollDto): Promise<NcPoll> {
      createdPolls.push(dto)
      return poll(99)
    },
  }

  beforeAll(async () => {
    server = createServer({ secret: SECRET, helios, polls })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('GET /healthz → 200 {status:ok} without any auth', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('POST /api/v1/votes without x-internal-auth → 403 (before the router/Helios)', async () => {
    const res = await fetch(`${base}/api/v1/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      body: JSON.stringify({ electionUuids: [OK_UUID] }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/votes with a valid secret but MISSING x-tenant-id → 400', async () => {
    const res = await fetch(`${base}/api/v1/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-auth': SECRET, 'x-tenant-slug': 'alpha' },
      body: JSON.stringify({ electionUuids: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/v1/votes settles per election: reachable hydrate, unreachable degrade, polls merge in', async () => {
    const res = await fetch(`${base}/api/v1/votes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: JSON.stringify({ electionUuids: [OK_UUID, BAD_UUID] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { votes: { id: string }[]; degradedUuids: string[]; pollError: string | null }
    // Reachable election + the poll are merged; the unreachable one degrades.
    expect(body.degradedUuids).toEqual([BAD_UUID])
    expect(body.pollError).toBeNull()
    expect(body.votes.map((v) => v.id).sort()).toEqual([`helios:${OK_UUID}`, 'poll:7'])
  })

  it('POST /api/v1/polls creates the quick-poll and returns {success:true}', async () => {
    const res = await fetch(`${base}/api/v1/polls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: JSON.stringify({ title: 'Mensa?', type: 'textPoll', options: ['A', 'B'], anonymous: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(createdPolls.at(-1)).toEqual({ title: 'Mensa?', type: 'textPoll', options: ['A', 'B'], anonymous: true })
  })

  it('a fully-authorized request to an UNKNOWN path → 404 (guard passed, router not-found)', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() } as Record<string, string>,
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})
