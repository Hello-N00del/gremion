// @vitest-environment node
//
// R33f HIGH: the subject of an erasure is resolved against THIS tenant before any
// hook runs. The Nextcloud behind the files/votes hooks is one instance for every
// tenant, and its account ids are the Keycloak ids of every realm, so an id that
// merely looks plausible must never reach it.
import { describe, expect, it, vi } from 'vitest'
import { createSubjectResolver, ErasureSubjectUnknownError } from './subject'

const ID = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7caa'
const notFound = () => new Error('User not found')

describe('createSubjectResolver', () => {
  it('a user of the current realm: the verified identity comes from the realm', async () => {
    const r = createSubjectResolver({
      getUser: async () => ({ id: ID, username: 'anna', email: 'anna@example.org' }),
      hasTenantEvidence: vi.fn(async () => false),
    })
    expect(await r(ID)).toEqual({ id: ID, username: 'anna', email: 'anna@example.org' })
  })

  it('an account without an e-mail address keeps email as the empty string, not null', async () => {
    const r = createSubjectResolver({ getUser: async () => ({ id: ID, username: 'anna' }), hasTenantEvidence: async () => false })
    expect(await r(ID)).toEqual({ id: ID, username: 'anna', email: '' })
  })

  it('not in the realm and no data of it in the tenant (a user of ANOTHER tenant): unknown', async () => {
    const evidence = vi.fn(async () => false)
    const r = createSubjectResolver({
      getUser: async () => {
        throw notFound()
      },
      hasTenantEvidence: evidence,
    })
    expect(await r(ID)).toBeNull()
    expect(evidence).toHaveBeenCalledWith(ID)
  })

  it('account already removed from the realm but the tenant holds data of it: known, identity unresolvable', async () => {
    const r = createSubjectResolver({
      getUser: async () => {
        throw notFound()
      },
      hasTenantEvidence: async () => true,
    })
    expect(await r(ID)).toEqual({ id: ID, username: null, email: null })
  })

  it('any other realm error is not an answer: it propagates (fail closed)', async () => {
    const evidence = vi.fn(async () => true)
    const r = createSubjectResolver({
      getUser: async () => {
        throw new Error('Keycloak 503')
      },
      hasTenantEvidence: evidence,
    })
    await expect(r(ID)).rejects.toThrow('Keycloak 503')
    expect(evidence).not.toHaveBeenCalled()
  })

  it('the unknown-subject error carries no identifier', () => {
    expect(new ErasureSubjectUnknownError().message).not.toContain(ID)
  })
})
