import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'
import { registerDataProvider, _resetRuntimeRegistryForTests } from '$lib/server/modules/runtime-registry'

// gremion#22 finding 2 — the kernel dashboard used to hardcode
// fetch('/api/finance/summary'), which 404s once finance is carved out of the
// kernel (no such route exists here). This pins the fix: the budget-summary KPI
// now goes through the 'finance:dashboard-summary' data-provider seam
// (Session-A inversion A3a), degrading to null (no finance panel, no
// error) when no finance module registers the provider — exactly like the
// pre-existing calendar:upcoming-events seam above it in loadCommon.
const getOrgUnitIdsForUser = vi.fn<(id: string) => Promise<readonly string[]>>()
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnitIdsForUser: (id: string) => getOrgUnitIdsForUser(id),
}))

import { load } from './+page.server'

type LoadResult = {
  budgetSummary: { totalCents: number; freeCents: number; spentCents: number } | null
}

function eventStub(opts: { roles: Role[]; groups?: string[] }): Parameters<typeof load>[0] {
  return {
    locals: {
      auth: async () => ({
        user: { id: 'u-1', name: 'Test', email: 't@example.com', roles: opts.roles, groups: opts.groups ?? [] },
        expires: '2099-01-01T00:00:00.000Z',
      }),
      user: { id: 'u-1', roles: opts.roles },
    },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    parent: async () => ({}),
  } as unknown as Parameters<typeof load>[0]
}

beforeEach(() => {
  getOrgUnitIdsForUser.mockReset()
  getOrgUnitIdsForUser.mockResolvedValue(['ou-x'])
  _resetRuntimeRegistryForTests()
})

describe('dashboard load — finance:dashboard-summary seam (gremion#22 finding 2)', () => {
  test('no finance module registered (kernel, finance carved out) → budgetSummary is null, load does NOT throw/404', async () => {
    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult
    expect(result.budgetSummary).toBeNull()
  })

  test('provider registered → its result is threaded through as budgetSummary', async () => {
    const summary = { totalCents: 10_000, freeCents: 4_000, spentCents: 6_000 }
    const provider = vi.fn(async () => summary)
    registerDataProvider('finance:dashboard-summary', provider)

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.budgetSummary).toEqual(summary)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  test('provider throws → degrades to null instead of propagating the error (never a 500)', async () => {
    registerDataProvider('finance:dashboard-summary', async () => {
      throw new Error('finance leaf unreachable')
    })

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.budgetSummary).toBeNull()
  })

  test('provider resolving to null (e.g. non-finance session, 403 upstream) → budgetSummary is null', async () => {
    registerDataProvider('finance:dashboard-summary', async () => null)

    const result = (await load(eventStub({ roles: [Role.Member], groups: ['mitglied'] }))) as LoadResult

    expect(result.budgetSummary).toBeNull()
  })
})
