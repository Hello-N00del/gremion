// R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, D-3): the committee layout
// at /members/committees/[id] gated only on Role.Member, so a Member outside a
// committee_only unit opened /members/committees/<closed-unit-id> (or its
// __data.json) and got the unit's roster names, role holders, history and
// provisioning state -- the data GET /api/governance/committees/[id]/members
// hides with a 404.
//
// The gate sits in the LAYOUT, and a nested loader inherits it ONLY by calling
// `await parent()` before it reads anything: on a __data.json request whose
// x-sveltekit-invalidated mask skips the layout, a child load that never calls
// parent() runs alone. parent() runs the layout load even when the layout
// itself was not invalidated, so its 404 then aborts the child. So:
//   - the roster page (+page.server.ts) and the protocol detail
//     (protokolle/[protocolId]) await parent() before their listOrgUnitMembers
//     read; both orders are pinned below;
//   - protokolle and beschluesse read only through the gated /api endpoints.
//
// The role helper ($lib/auth) is REAL here on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UNITS: Record<string, { id: string; name: string; visibility: 'all_members' | 'committee_only' }> = {
  'u-closed': { id: 'u-closed', name: 'Closed', visibility: 'committee_only' },
  'u-open': { id: 'u-open', name: 'Open', visibility: 'all_members' },
}
const MEMBERSHIPS: Record<string, string[]> = { 'unit-member': ['u-closed'] }

const h = vi.hoisted(() => ({
  listOrgUnitMembers: vi.fn(),
  isMemberOf: vi.fn(),
}))

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => UNITS[id] ?? null),
  isMemberOf: h.isMemberOf,
  getOrgUnitIdsForUser: vi.fn(async (userId: string) => MEMBERSHIPS[userId] ?? []),
  listOrgUnitMembers: h.listOrgUnitMembers,
}))
vi.mock('$lib/server/governance/governance-db', () => ({
  listRoles: vi.fn(async () => []),
  listHistory: vi.fn(async () => []),
  getActiveAssignment: vi.fn(async () => null),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResources: vi.fn(async () => []) }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: vi.fn(async (id: string) => ({ username: id })) }),
}))

const { load: layoutLoad } = await import('./+layout.server')
const { load: pageLoad } = await import('./+page.server')
const { load: protocolDetailLoad } = await import('./protokolle/[protocolId]/+page.server')

const GUEST = { id: 'guest', roles: [Role.Guest] }
const STRANGER = { id: 'stranger', roles: [Role.Member] }
const UNIT_MEMBER = { id: 'unit-member', roles: [Role.Member] }
const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

function layoutEvent(user: unknown, id: string) {
  return {
    params: { id },
    locals: { auth: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof layoutLoad>[0]
}

async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run()
    return 200
  } catch (e) {
    return (e as { status?: number })?.status ?? -1
  }
}

const layoutStatus = (user: unknown, id: string) => statusOf(() => layoutLoad(layoutEvent(user, id)))

/** The roster page as SvelteKit runs it: its parent() is the layout load. */
function pageStatus(user: unknown, id: string): Promise<number> {
  const ev = {
    params: { id },
    locals: { auth: async () => (user ? { user } : null), tenant: undefined },
    parent: () => layoutLoad(layoutEvent(user, id)),
  } as unknown as Parameters<typeof pageLoad>[0]
  return statusOf(() => pageLoad(ev))
}

function protocolEvent(user: unknown, urlId: string, protocolCommitteeId: string, parent: () => Promise<unknown>) {
  const body = {
    protocol: { id: 'p1', committee_id: protocolCommitteeId, status: 'published', title: 'Sitzung', meeting_date: '2026-01-01' },
    attendance: [],
    resolutions: [],
    actionItems: [],
  }
  return {
    params: { id: urlId, protocolId: 'p1' },
    locals: { user, tenant: undefined },
    fetch: async (url: string) =>
      url.startsWith('/api/protocols?')
        ? new Response(JSON.stringify({ protocols: [] }), { status: 200 })
        : new Response(JSON.stringify(body), { status: 200 }),
    parent,
  } as unknown as Parameters<typeof protocolDetailLoad>[0]
}

beforeEach(() => {
  h.listOrgUnitMembers.mockReset().mockResolvedValue([{ id: 'm1', user_keycloak_id: 'kc-1', voting: true }])
  h.isMemberOf.mockReset().mockImplementation(async (unitId: string, userId: string) =>
    (MEMBERSHIPS[userId] ?? []).includes(unitId),
  )
})

describe('/members/committees/[id] layout follows D-3', () => {
  it('a Member outside a committee_only unit gets 404 and the roster is never read', async () => {
    expect(await layoutStatus(STRANGER, 'u-closed')).toBe(404)
    expect(await pageStatus(STRANGER, 'u-closed')).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it('a Member outside an all_members unit still reaches it', async () => {
    expect(await layoutStatus(STRANGER, 'u-open')).toBe(200)
    expect(await pageStatus(STRANGER, 'u-open')).toBe(200)
  })

  it('a member of the committee_only unit and a CouncilAdmin reach it', async () => {
    expect(await layoutStatus(UNIT_MEMBER, 'u-closed')).toBe(200)
    expect(await pageStatus(UNIT_MEMBER, 'u-closed')).toBe(200)
    expect(await layoutStatus(ADMIN, 'u-closed')).toBe(200)
  })

  it('a Guest is still sent to login, an unknown unit is still 404', async () => {
    expect(await layoutStatus(GUEST, 'u-open')).toBe(303)
    expect(await layoutStatus(ADMIN, 'u-missing')).toBe(404)
  })

  it('the CouncilAdmin needs no membership query', async () => {
    await layoutLoad(layoutEvent(ADMIN, 'u-closed'))
    expect(h.isMemberOf).not.toHaveBeenCalled()
  })
})

describe('protocol detail: gated by the layout and bound to the URL committee', () => {
  it('a Member outside the committee_only URL unit gets 404 and no roster is read', async () => {
    const ev = protocolEvent(STRANGER, 'u-closed', 'u-closed', () => layoutLoad(layoutEvent(STRANGER, 'u-closed')))
    expect(await statusOf(() => protocolDetailLoad(ev))).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it('reads no roster when parent() throws (the order the layout gate depends on)', async () => {
    const throws404 = async () => {
      throw Object.assign(new Error('Not found'), { status: 404 })
    }
    expect(await statusOf(() => protocolDetailLoad(protocolEvent(ADMIN, 'u-open', 'u-open', throws404)))).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it('a protocol of another committee is a 404 and no roster is read', async () => {
    // A readable protocol of u-open paired with the URL unit u-closed would
    // otherwise serve u-closed's roster next to it.
    const ev = protocolEvent(UNIT_MEMBER, 'u-closed', 'u-open', () => layoutLoad(layoutEvent(UNIT_MEMBER, 'u-closed')))
    expect(await statusOf(() => protocolDetailLoad(ev))).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })

  it('the matching committee still loads its roster', async () => {
    const ev = protocolEvent(UNIT_MEMBER, 'u-closed', 'u-closed', () => layoutLoad(layoutEvent(UNIT_MEMBER, 'u-closed')))
    expect(await statusOf(() => protocolDetailLoad(ev))).toBe(200)
    expect(h.listOrgUnitMembers).toHaveBeenCalledWith('u-closed')
  })
})

describe('the roster page awaits parent() before any read', () => {
  it('reads nothing when parent() throws', async () => {
    const ev = {
      params: { id: 'u-open' },
      locals: { auth: async () => ({ user: ADMIN }), tenant: undefined },
      parent: async () => {
        throw Object.assign(new Error('Not found'), { status: 404 })
      },
    } as unknown as Parameters<typeof pageLoad>[0]
    expect(await statusOf(() => pageLoad(ev))).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })
})
