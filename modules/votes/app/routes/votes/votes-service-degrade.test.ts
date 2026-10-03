import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { Role } from '$lib/auth'
import type { VoteListItem, DegradedVoteItem } from './+page.server'

// R29-VOTES-DEGRADE-S: the /votes loader running against the REAL ServiceVotesClient
// (VOTES_BACKEND=service) with a stubbed votes leaf. Seed fixtures carry non-UUID
// helios_uuid values (`hel-vorstand-26`); the leaf now answers 200 with those in
// `degradedUuids` instead of 400, and the page must render a degraded card from the
// local row rather than throw. Only the leaf (global fetch) and the kernel-owned
// DB reads are stubbed.

const findAll = vi.fn()
const getOrgUnit = vi.fn()

vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', slug: 'default' }),
}))

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: {
    findAll: () => findAll(),
    findVisibleToUser: async () => [],
  },
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: (id: string) => getOrgUnit(id),
}))

const { load } = await import('./+page.server')

function row(uuid: string) {
  return {
    id: `row-${uuid}`,
    helios_uuid: uuid,
    org_unit_id: 'ou-1',
    created_by: 'seed',
    calendar_linked: false,
    created_at: new Date('2026-09-15T10:00:00.000Z'),
    archived_at: null,
  }
}

const adminEvent = {
  locals: {
    auth: async () => ({
      user: { id: 'admin-1', name: 'Admin', email: 'a@x.de', roles: [Role.ITAdmin], groups: [] },
      expires: '2099-01-01T00:00:00.000Z',
    }),
  },
} as unknown as Parameters<typeof load>[0]

const realFetch = globalThis.fetch

beforeEach(() => {
  process.env.VOTES_BACKEND = 'service'
  process.env.VOTES_SERVICE_URL = 'http://votes-service:8080'
  process.env.INTERNAL_VOTES_SECRET = 's3cr3t'
  getOrgUnit.mockReset()
  getOrgUnit.mockResolvedValue({ id: 'ou-1', name: 'Vorstand' })
  findAll.mockReset()
})

afterEach(() => {
  delete process.env.VOTES_BACKEND
  delete process.env.VOTES_SERVICE_URL
  delete process.env.INTERNAL_VOTES_SECRET
  globalThis.fetch = realFetch
})

describe('/votes loader — service backend, leaf degrades non-UUID tracked elections', () => {
  test('non-UUID helios_uuid rows come back degraded from the leaf and render as degraded cards (no throw)', async () => {
    findAll.mockResolvedValue([row('hel-vorstand-26'), row('hel-fs-inf-2025')])
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ votes: [], degradedUuids: ['hel-vorstand-26', 'hel-fs-inf-2025'], pollError: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch

    const result = (await load(adminEvent)) as { votes: VoteListItem[] }

    // The leaf was asked with the raw tracked uuids (it, not the client, degrades them).
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ electionUuids: ['hel-vorstand-26', 'hel-fs-inf-2025'] })

    expect(result.votes).toHaveLength(2)
    expect(result.votes.every((v) => v.degraded)).toBe(true)
    expect((result.votes as DegradedVoteItem[]).map((d) => d.heliosUuid)).toEqual(['hel-vorstand-26', 'hel-fs-inf-2025'])
    expect((result.votes as DegradedVoteItem[]).map((d) => d.committeeName)).toEqual(['Vorstand', 'Vorstand'])
  })
})
