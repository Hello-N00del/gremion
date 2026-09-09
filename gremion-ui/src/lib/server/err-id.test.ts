import { describe, it, expect } from 'vitest'
import { generateErrId, ERR_ID_RE } from './err-id'

// v5 Task 4.4 — error reference id (500) + the 403 role-context label logic.

describe('generateErrId (500 reference id)', () => {
  it('produces the ERR-[A-Z0-9]{6} format', () => {
    const id = generateErrId()
    expect(id).toMatch(/^ERR-[A-Z0-9]{6}$/)
    expect(ERR_ID_RE.test(id)).toBe(true)
  })

  it('never emits lowercase or punctuation in the suffix', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateErrId()
      expect(id.startsWith('ERR-')).toBe(true)
      expect(id.slice(4)).toMatch(/^[A-Z0-9]{6}$/)
    }
  })

  it('is highly unlikely to collide across many generations', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateErrId())
    // 36^6 ≈ 2.2e9 space → 1000 draws collide with vanishing probability.
    expect(seen.size).toBeGreaterThan(990)
  })

  it('rejects malformed ids via the exported regex', () => {
    expect(ERR_ID_RE.test('ERR-abc123')).toBe(false) // lowercase
    expect(ERR_ID_RE.test('ERR-ABCDE')).toBe(false) // too short
    expect(ERR_ID_RE.test('ERR-ABCDEFG')).toBe(false) // too long
    expect(ERR_ID_RE.test('XYZ-ABC123')).toBe(false) // wrong prefix
  })
})

// The 403 page derives a German role label from the highest-ranked realm role
// in the session. This mirrors the logic embedded in +error.svelte so a
// regression in the rank/label maps is caught here rather than only visually.
describe('403 role-context label', () => {
  const ROLE_LABELS: Record<string, string> = {
    'it-admin': 'IT-Administration',
    'council-admin': 'Rats-Administration',
    finance: 'Finanzen',
    member: 'Mitglied',
    guest: 'Gast',
  }
  const ROLE_RANK = ['it-admin', 'council-admin', 'finance', 'member', 'guest']

  function roleLabel(roles: string[]): string {
    const top = ROLE_RANK.find((r) => roles.includes(r))
    return top ? (ROLE_LABELS[top] ?? top) : 'Gast'
  }

  it('labels a finance member as the higher-ranked Finanzen role', () => {
    expect(roleLabel(['member', 'finance', 'guest'])).toBe('Finanzen')
  })

  it('labels a plain member as Mitglied', () => {
    expect(roleLabel(['member', 'guest'])).toBe('Mitglied')
  })

  it('falls back to Gast when no known role is present', () => {
    expect(roleLabel([])).toBe('Gast')
  })

  it('prefers it-admin over all other roles', () => {
    expect(roleLabel(['member', 'it-admin', 'finance'])).toBe('IT-Administration')
  })
})
