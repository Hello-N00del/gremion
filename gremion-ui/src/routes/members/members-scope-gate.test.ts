// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'

// WI-4B: /members is the unified Mitglieder surface. The loader no longer 403s
// non-admins; instead it returns the friendly Member list and an `isAdmin`
// flag that selects the basic vs admin view. listMembers is mocked so the
// loader path never touches Keycloak or a real DB connection.
const { mockListMembers } = vi.hoisted(() => ({ mockListMembers: vi.fn() }))

vi.mock('$lib/server/members/member-view', () => ({
  listMembers: mockListMembers,
}))

const SAMPLE = [
  {
    id: 'anna.berger',
    name: 'Anna Berger',
    email: 'a@x',
    enabled: true,
    roles: ['Mitglied'],
    scopes: [],
    memberships: [],
    placed: true,
  },
]

function makeLocals(roles: string[]) {
  return { auth: async () => ({ user: { id: 'u1', email: 'a@b.de', name: 'A B', roles, groups: [] } }) }
}

async function runLoad(roles: string[]) {
  const { load } = await import('./+page.server')
  // @ts-expect-error partial event mock — load only reads locals.auth
  return load({ locals: makeLocals(roles) })
}

describe('GET /members (unified loader)', () => {
  beforeEach(() => {
    mockListMembers.mockReset()
    mockListMembers.mockResolvedValue(SAMPLE)
  })

  it('a plain member gets the basic view (isAdmin=false), no 403', async () => {
    const result = (await runLoad(['member'])) as { isAdmin: boolean; members: unknown[] }
    expect(result.isAdmin).toBe(false)
    expect(mockListMembers).toHaveBeenCalledWith({ adminView: false })
    expect(result.members).toEqual(SAMPLE)
  })

  it('council-admin (Vorstand) gets the admin view', async () => {
    const result = (await runLoad(['council-admin'])) as { isAdmin: boolean }
    expect(result.isAdmin).toBe(true)
    expect(mockListMembers).toHaveBeenCalledWith({ adminView: true })
  })

  it('it-admin gets the admin view', async () => {
    const result = (await runLoad(['it-admin'])) as { isAdmin: boolean }
    expect(result.isAdmin).toBe(true)
    expect(mockListMembers).toHaveBeenCalledWith({ adminView: true })
  })
})
