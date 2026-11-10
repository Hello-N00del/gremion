import { describe, expect, it } from 'vitest'
import { matrixSafeUsername } from './kc-admin-api'

// Synapse takes the Matrix localpart from preferred_username, so the Keycloak username must be a
// valid localpart. An email address is not: the @ makes every login fail.
describe('matrixSafeUsername', () => {
  it('encodes the @ with characters both Keycloak and Matrix accept', () => {
    expect(matrixSafeUsername('Security@Gremion.de')).toBe('security_40gremion.de')
  })

  it('encodes every character a localpart may not carry', () => {
    expect(matrixSafeUsername("o'neil+x@a.de")).toBe('o_27neil_2bx_40a.de')
  })

  it('produces only characters a Matrix localpart allows', () => {
    expect(matrixSafeUsername('Ä b/c@x.de')).toMatch(/^[a-z0-9._-]+$/)
  })
})

describe('matrixSafeUsername encoding', () => {
  it('uses no character the Keycloak username policy refuses, and stays unambiguous', () => {
    expect(matrixSafeUsername('a_b@x.de')).toBe('a_5fb_40x.de')
    expect(matrixSafeUsername('a@x.de')).not.toContain('=')
  })
})
