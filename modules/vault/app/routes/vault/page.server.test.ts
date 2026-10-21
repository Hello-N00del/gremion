import { describe, it, expect, vi, beforeEach } from 'vitest'

// /vault page-load tests (#405 design v11) — vault-authz.test.ts mock idiom:
// mock the scope resolver + the resolved leaf backend (+ the load's read-side
// collaborators), then drive the real load. The interesting seams:
//   - the access log is requested with the RESOLVED org-unit scope (never
//     caller input) — the Zugriffsprotokoll can only show in-scope reveals;
//   - raw Keycloak UUIDs (created_by / accessed_by) are resolved to display
//     names server-side (WI-4A: members never see a UUID);
//   - the lock inputs mirror the reveal route's step-up gate;
//   - handover cross-links are skipped entirely on a handover-OFF tenant.

const { vaultClient, mockEnv, mockModules, refsMock } = vi.hoisted(() => ({
  vaultClient: {
    listItemsForOrgUnits: vi.fn(),
    listAccessLog: vi.fn(),
  },
  mockEnv: {} as Record<string, string | undefined>,
  mockModules: {} as Record<string, boolean>,
  refsMock: vi.fn(),
}))

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }))
vi.mock('$lib/server/vault/scope', () => ({
  resolveVaultOrgUnitScope: vi.fn(async () => ['ou-1']),
}))
vi.mock('$lib/server/vault/backend/resolve', () => ({
  resolveVaultBackendOr503: () => vaultClient,
  resolveVaultBackendForPage: () => vaultClient,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnits: vi.fn(async () => [
    { id: 'ou-1', name: 'Referat Finanzen', kind: 'referat' },
    { id: 'ou-2', name: 'Referat Kultur', kind: 'referat' }, // out of scope
  ]),
}))
vi.mock('$lib/server/identity/display-names', () => ({
  getDisplayNameResolver: () => ({
    resolveMany: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, id === 'kc-uuid-ben' ? 'Ben Hoffmann' : id])),
  }),
}))
vi.mock('$lib/server/handover/handover-vault-links', () => ({
  handoverTracksReferencingVaultItems: refsMock,
}))
vi.mock('$lib/server/config', () => ({
  readConfig: () => ({ modules: mockModules }),
}))

import { load } from './+page.server'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'

// SvelteKit's generated PageServerLoad return union includes `void`; the load
// here always returns data (or throws), so narrow once for the assertions.
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>
const run = (event: unknown) => load(event as never) as Promise<LoadData>

const freshAuthTime = () => Math.floor(Date.now() / 1000)
const makeEvent = (user: Record<string, unknown> | undefined) =>
  ({ locals: { auth: async () => (user ? { user } : null) } }) as any
const member = () =>
  makeEvent({ id: 'u1', roles: ['member'], loa: 2, authTime: freshAuthTime() })

const ITEM = {
  id: 'v1',
  org_unit_id: 'ou-1',
  name: 'Sparkasse Online-Banking',
  username: 'stura.finanzen',
  url: null,
  notes: null,
  created_by: 'kc-uuid-ben',
  created_at: new Date(2026, 2, 12, 9, 0),
}
const LOG_ROW = {
  id: 'a1',
  item_id: 'v1',
  item_name: 'Sparkasse Online-Banking',
  org_unit_id: 'ou-1',
  accessed_by: 'kc-uuid-ben',
  accessed_at: new Date(2026, 6, 14, 11, 3),
}

beforeEach(() => {
  vi.clearAllMocks()
  delete mockEnv.VAULT_REVEAL_REQUIRE_STEPUP
  delete mockEnv.STEPUP_FRESHNESS_SECONDS
  for (const k of Object.keys(mockModules)) delete mockModules[k]
  ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1'])
  vaultClient.listItemsForOrgUnits.mockResolvedValue([ITEM])
  vaultClient.listAccessLog.mockResolvedValue([LOG_ROW])
  refsMock.mockResolvedValue(new Map([['v1', ['Finanzen']]]))
})

describe('/vault load — access-log scoping', () => {
  it('requests the log with the RESOLVED org-unit scope (never caller input)', async () => {
    ;(resolveVaultOrgUnitScope as any).mockResolvedValue(['ou-1', 'ou-9'])
    await run(member())
    expect(vaultClient.listAccessLog).toHaveBeenCalledWith(['ou-1', 'ou-9'], { limit: 32, offset: 0 })
    expect(vaultClient.listItemsForOrgUnits).toHaveBeenCalledWith(['ou-1', 'ou-9'])
  })

  it('ships formatted log rows with the actor UUID resolved to a display name', async () => {
    const { log } = await run(member())
    expect(log).toEqual([
      { id: 'a1', ts: '14.07.2026 · 11:03', actor: 'Ben Hoffmann', itemName: 'Sparkasse Online-Banking' },
    ])
  })
})

describe('/vault load — items + units DTO', () => {
  it('resolves created_by to a display name and formats the created date', async () => {
    const { items } = await run(member())
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'v1',
      name: 'Sparkasse Online-Banking',
      created: '12.03.2026',
      createdByName: 'Ben Hoffmann',
    })
    // no raw secret / notes fields on the page DTO
    expect(items[0]).not.toHaveProperty('secret')
  })

  it('ships only in-scope units, enriched with the committee-tree hue/abbr', async () => {
    const { units } = await run(member())
    expect(units.map((u: { id: string }) => u.id)).toEqual(['ou-1'])
    expect(units[0]).toMatchObject({ name: 'Referat Finanzen', abbr: 'RF' })
    expect(typeof units[0].hue).toBe('number')
  })

  it('403s a guest', async () => {
    await expect(load(makeEvent({ id: 'g1', roles: ['guest'], loa: 1, authTime: 0 }))).rejects.toMatchObject({
      status: 403,
    })
    expect(vaultClient.listAccessLog).not.toHaveBeenCalled()
  })
})

describe('/vault load — honest lock inputs (mirror of the reveal gate)', () => {
  it('fresh LoA 2 → enforced + ok (page unlocks directly)', async () => {
    const data = await run(member())
    expect(data.stepUpEnforced).toBe(true)
    expect(data.stepUpOk).toBe(true)
  })

  it('stale LoA 2 → enforced + NOT ok (page locks)', async () => {
    const stale = makeEvent({ id: 'u1', roles: ['member'], loa: 2, authTime: freshAuthTime() - 3600 })
    const data = await run(stale)
    expect(data.stepUpOk).toBe(false)
  })

  it('LoA 1 → NOT ok', async () => {
    const loa1 = makeEvent({ id: 'u1', roles: ['member'], loa: 1, authTime: freshAuthTime() })
    expect((await run(loa1)).stepUpOk).toBe(false)
  })

  it('flag opt-out → not enforced, ok (no fake lock)', async () => {
    mockEnv.VAULT_REVEAL_REQUIRE_STEPUP = 'false'
    const loa1 = makeEvent({ id: 'u1', roles: ['member'], loa: 1, authTime: 0 })
    const data = await run(loa1)
    expect(data.stepUpEnforced).toBe(false)
    expect(data.stepUpOk).toBe(true)
  })
})

describe('/vault load — handover cross-links', () => {
  it('ships the Übergabe references as a serializable record', async () => {
    const { handoverRefs } = await run(member())
    expect(handoverRefs).toEqual({ v1: ['Finanzen'] })
    expect(refsMock).toHaveBeenCalledWith(['v1'])
  })

  it('skips the cross-link query entirely on a handover-OFF tenant (no dead /handover chip)', async () => {
    mockModules['handover'] = false
    const { handoverRefs } = await run(member())
    expect(handoverRefs).toEqual({})
    expect(refsMock).not.toHaveBeenCalled()
  })

  it('degrades to no chips when the cross-link source errors', async () => {
    refsMock.mockRejectedValueOnce(new Error('db down'))
    const { handoverRefs } = await run(member())
    expect(handoverRefs).toEqual({})
  })
})
