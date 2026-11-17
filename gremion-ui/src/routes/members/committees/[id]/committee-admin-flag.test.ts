// @vitest-environment node
// committee-admin-flag.test.ts -- IT-admin finding 2. The committee page offers "Amt zuweisen" to
// `isAdmin`, and the assign endpoint answers 403 below council-admin. Both read the same role ladder,
// in which it-admin contains council-admin, so an IT admin with no council-admin role of its own
// is an admin on the page and may assign. This pins the page side; the endpoint side is pinned in
// assign.admin-only.test.ts.
import { describe, it, expect, vi } from 'vitest'

vi.mock('$lib/server/governance/org-units-db', () => ({
  listOrgUnitMembers: async () => [],
  isMemberOf: async () => false,
}))
vi.mock('$lib/server/governance/governance-db', () => ({
  listRoles: async () => [],
  listHistory: async () => [],
  getActiveAssignment: async () => null,
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResources: async () => [] }))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => ({ getUser: async () => ({}) }) }))

const { load } = await import('./+page.server')

async function isAdminFor(roles: string[]) {
  const event = {
    params: { id: 'ou-1' },
    parent: async () => ({ committee: { id: 'ou-1', name: 'Vorstand' } }),
    locals: { tenant: undefined, auth: async () => ({ user: { id: 'u1', roles, groups: [] } }) },
  }
  const data = (await load(event as never)) as { isAdmin: boolean }
  return data.isAdmin
}

describe('committee page loader: who counts as admin', () => {
  it('an IT admin without a council-admin role is an admin', async () => {
    expect(await isAdminFor(['it-admin'])).toBe(true)
  })
  it('a council admin is an admin', async () => {
    expect(await isAdminFor(['council-admin'])).toBe(true)
  })
  it('a plain member is not', async () => {
    expect(await isAdminFor(['member'])).toBe(false)
  })
})
