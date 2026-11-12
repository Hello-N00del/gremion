import { describe, expect, it } from 'vitest'
import { fallbackSenderName, senderInitials, senderLabel } from './sender-label'

// The Keycloak username of an invited user is the address with every other character encoded as
// _hh; Synapse takes it as the Matrix localpart. So a raw sender id can carry an address.
const RAW = '@max.mustermann_40example.org:matrix.example.org'

describe('fallbackSenderName', () => {
  it('turns an encoded address into a readable name without the domain', () => {
    expect(fallbackSenderName(RAW)).toBe('Max Mustermann')
  })

  it('never leaves an address or a Matrix id in the label', () => {
    for (const id of [RAW, '@user_40example.org:platform.example.org', '@a_2bb_40example.org:x', '@plain:x']) {
      const label = fallbackSenderName(id)
      expect(label).not.toMatch(/@/)
      expect(label).not.toMatch(/:/)
    }
  })

  it('keeps a plain localpart readable', () => {
    expect(fallbackSenderName('@gremion-bot:matrix.example.org')).toBe('Gremion Bot')
  })

  it('has a label for an empty or malformed id', () => {
    expect(fallbackSenderName('')).toBe('Unbekannt')
    expect(fallbackSenderName('@:matrix.example.org')).toBe('Unbekannt')
  })
})

describe('fallbackSenderName with plain underscores', () => {
  it('keeps a localpart whose underscore is not an encoded byte', () => {
    expect(fallbackSenderName('@hans_dampf:matrix.example.org')).toBe('Hans Dampf')
    expect(fallbackSenderName('@test_dead:matrix.example.org')).toBe('Test Dead')
  })
})

describe('senderLabel', () => {
  it('uses the display name when there is a real one', () => {
    expect(senderLabel(RAW, 'Erika Muster')).toBe('Erika Muster')
  })

  it('falls back when the display name is empty or the raw id itself', () => {
    expect(senderLabel(RAW, '')).toBe('Max Mustermann')
    expect(senderLabel(RAW, undefined)).toBe('Max Mustermann')
    expect(senderLabel(RAW, RAW)).toBe('Max Mustermann')
  })

  it('does not show a display name that is an address', () => {
    expect(senderLabel(RAW, 'max.mustermann@example.org')).toBe('Max Mustermann')
  })
})

describe('senderInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(senderInitials('Erika Muster')).toBe('EM')
  })
  it('takes two letters of a single word', () => {
    expect(senderInitials('Unbekannt')).toBe('UN')
  })
})
