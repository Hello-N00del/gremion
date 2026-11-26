// @vitest-environment node
//
// The freeze action of the manage page acts only on an election this customer tracks (committee_elections):
// the Helios service is shared by the whole install, so a uuid this customer has no row for is answered with
// "not found" and never reaches the Helios client, exactly as the page loads of the same route do.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

const findByHeliosUuid = vi.fn()
const freeze = vi.fn()

vi.mock('$lib/server/elections/election-db', () => ({
  ElectionDb: { findByHeliosUuid: (uuid: string) => findByHeliosUuid(uuid) },
}))
vi.mock('$lib/server/elections/helios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/elections/helios-client')>()
  return { ...actual, HeliosClient: { freeze: (uuid: string) => freeze(uuid) } }
})

const { actions } = await import('./+page.server')

const call = (id: string, who: unknown) =>
  (actions.freeze as unknown as (e: unknown) => Promise<unknown>)({ params: { id }, locals: { auth: async () => who } })
const admin = { user: { id: 'u1', roles: [Role.CouncilAdmin] } }

beforeEach(() => {
  findByHeliosUuid.mockReset()
  freeze.mockReset()
})

describe('manage page: freeze action', () => {
  it('an election this customer does not track is a 404 and Helios is never asked to freeze it', async () => {
    findByHeliosUuid.mockResolvedValue(null)
    await expect(call('other-customers-uuid', admin)).rejects.toMatchObject({ status: 404 })
    expect(findByHeliosUuid).toHaveBeenCalledWith('other-customers-uuid')
    expect(freeze).not.toHaveBeenCalled()
  })

  it('a tracked election is frozen and the admin is sent on to its page', async () => {
    findByHeliosUuid.mockResolvedValue({ helios_uuid: 'e-own', org_unit_id: 'ou1' })
    freeze.mockResolvedValue(undefined)
    await expect(call('e-own', admin)).rejects.toMatchObject({ status: 302, location: '/elections/e-own' })
    expect(freeze).toHaveBeenCalledWith('e-own')
  })

  it('a caller without an admin role is refused before the lookup', async () => {
    await expect(call('e-own', { user: { id: 'u2', roles: [Role.Member] } })).rejects.toMatchObject({ status: 403 })
    expect(findByHeliosUuid).not.toHaveBeenCalled()
    expect(freeze).not.toHaveBeenCalled()
  })
})
