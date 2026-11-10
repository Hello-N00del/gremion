import { describe, expect, it } from 'vitest'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { requireContentAuthor, requireContentPublish } from './route-auth'

// A customer's first administrators hold a realm role and no group yet. They must be able to write
// and publish content without first granting themselves a body role.
const user = (roles: string[], groups: string[] = []) => ({ id: 'u', name: 'n', roles, groups }) as unknown as SessionUser

describe('content capability for customer administrators', () => {
  it.each([Role.CouncilAdmin, Role.ITAdmin])('%s may author and publish without a group', (role) => {
    expect(requireContentAuthor(user([role]))).toBeTruthy()
    expect(requireContentPublish(user([role]))).toBeTruthy()
  })

  it('a plain member without a granting group is still refused', () => {
    expect(() => requireContentAuthor(user([Role.Member]))).toThrow()
    expect(() => requireContentPublish(user([Role.Member]))).toThrow()
  })
})
