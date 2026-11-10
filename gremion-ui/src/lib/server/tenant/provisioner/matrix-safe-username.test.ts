import { describe, expect, it } from 'vitest'
import { matrixSafeUsername } from './kc-admin-api'

// Synapse takes the Matrix localpart from preferred_username, so the Keycloak username must be a
// valid localpart. An email address is not: the @ makes every login fail.
describe('matrixSafeUsername', () => {
  it('encodes the @ the way Matrix maps foreign identifiers', () => {
    expect(matrixSafeUsername('Security@Gremion.de')).toBe('security=40gremion.de')
  })

  it('encodes every character a localpart may not carry', () => {
    expect(matrixSafeUsername("o'neil+x@a.de")).toBe('o=27neil=2bx=40a.de')
  })

  it('produces only characters a Matrix localpart allows', () => {
    expect(matrixSafeUsername('Ä b/c@x.de')).toMatch(/^[a-z0-9._=-]+$/)
  })
})
