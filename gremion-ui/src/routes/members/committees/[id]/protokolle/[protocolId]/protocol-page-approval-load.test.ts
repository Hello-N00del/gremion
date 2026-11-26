// The load of the protocol page and the two-person publish: it hands the page whether THIS
// viewer may approve (the same function the publish route uses), whether anybody else could,
// and the names of who submitted and who approved, read live from Keycloak.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  listOrgUnitMembers: vi.fn(),
  getUser: vi.fn(),
  listRealmRoleMembers: vi.fn(),
}))
vi.mock('$lib/server/governance/org-units-db', () => ({ listOrgUnitMembers: h.listOrgUnitMembers }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: h.getUser, listRealmRoleMembers: h.listRealmRoleMembers }),
}))

import { load } from './+page.server'

const member = (id: string, voting = true) => ({ user_keycloak_id: id, voting })
const person = (id: string, first: string, enabled = true) => ({
  id, username: id, firstName: first, lastName: 'Beispiel', enabled,
})

let protocol: Record<string, unknown>

function run(userId: string, roles: string[]) {
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith('/api/protocols/p1')) {
      return new Response(JSON.stringify({ protocol, attendance: [], resolutions: [], actionItems: [] }))
    }
    return new Response(JSON.stringify({ protocols: [] }))
  })
  return load({
    params: { id: 'c1', protocolId: 'p1' },
    fetch,
    locals: { user: { id: userId, roles }, tenant: {} },
    parent: async () => ({}),
  } as never) as Promise<{
    approval: {
      canApprove: boolean
      refusal: string | null
      otherEligibleCount: number | null
      submitted: { name: string; at: string | null } | null
      approved: { name: string; at: string | null } | null
    }
  }>
}

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset())
  protocol = {
    id: 'p1', committee_id: 'c1', status: 'submitted', created_by: 'author',
    submitted_by: 'submitter', submitted_at: '2026-06-22T08:30:00.000Z', approved_by: null, approved_at: null,
  }
  h.listOrgUnitMembers.mockResolvedValue([member('submitter'), member('v2'), member('guest', false)])
  h.getUser.mockImplementation(async (id: string) => person(id, id === 'submitter' ? 'Anna' : 'Ben'))
  h.listRealmRoleMembers.mockImplementation(async (role: string) =>
    role === 'council-admin' ? [person('submitter', 'Anna'), person('admin2', 'Cora'), person('off', 'Dirk', false)] : [],
  )
})

describe('protocol page load: approval', () => {
  it('does not let the submitter approve, and names the submitter', async () => {
    const { approval } = await run('submitter', ['council-admin'])
    expect(approval.canApprove).toBe(false)
    expect(approval.refusal).toBe('submitter')
    expect(approval.submitted).toEqual({ name: 'Anna Beispiel', at: '2026-06-22T08:30:00.000Z' })
    expect(approval.approved).toBeNull()
  })

  it('lets a second admin approve', async () => {
    const { approval } = await run('admin2', ['council-admin'])
    expect(approval.canApprove).toBe(true)
    expect(approval.refusal).toBeNull()
  })

  it('lets a voting member who is not an admin approve, but not a non-voting member', async () => {
    expect((await run('v2', ['member'])).approval.canApprove).toBe(true)
    expect((await run('guest', ['member'])).approval).toMatchObject({ canApprove: false, refusal: 'not-eligible' })
  })

  it('counts the other people who could approve: admins and voting members, once each, enabled only, without the submitter and the creator', async () => {
    // admin2 (admin) + v2 (voting member); the submitter, the creator and the disabled admin do not count
    expect((await run('submitter', ['council-admin'])).approval.otherEligibleCount).toBe(2)
  })

  it('reports that nobody else could approve when the submitter is the only eligible person', async () => {
    h.listOrgUnitMembers.mockResolvedValue([member('submitter')])
    h.listRealmRoleMembers.mockResolvedValue([person('submitter', 'Anna')])
    expect((await run('submitter', ['council-admin'])).approval.otherEligibleCount).toBe(0)
  })

  it('makes no claim about other approvers when Keycloak cannot be asked', async () => {
    h.listRealmRoleMembers.mockRejectedValue(new Error('down'))
    expect((await run('submitter', ['council-admin'])).approval.otherEligibleCount).toBeNull()
  })

  it('names both people on a published protocol and offers no approval', async () => {
    protocol = { ...protocol, status: 'published', approved_by: 'admin2', approved_at: '2026-06-23T10:15:00.000Z' }
    const { approval } = await run('admin2', ['council-admin'])
    expect(approval.canApprove).toBe(false)
    expect(approval.submitted?.name).toBe('Anna Beispiel')
    expect(approval.approved).toEqual({ name: 'Ben Beispiel', at: '2026-06-23T10:15:00.000Z' })
  })

  it('has no record for a protocol from before the two people were recorded', async () => {
    protocol = { id: 'p1', committee_id: 'c1', status: 'published', created_by: 'author' }
    const { approval } = await run('admin2', ['council-admin'])
    expect(approval.submitted).toBeNull()
    expect(approval.approved).toBeNull()
  })
})
