import { describe, it, expect } from 'vitest'
import {
  VAULT_AUTO_LOCK_MS,
  SECRET_AUTO_HIDE_MS,
  initialVaultLock,
  visibleUnits,
  formatVaultDate,
  formatVaultLogTs,
  generatePassphrase,
} from './vault-view'

describe('initialVaultLock — the lock state mirrors the server step-up gate (#405)', () => {
  it('locks when enforcement is ON and the session has no fresh LoA 2', () => {
    expect(initialVaultLock(true, false)).toBe(true)
  })
  it('renders unlocked directly for a fresh-loa2 session', () => {
    expect(initialVaultLock(true, true)).toBe(false)
  })
  it('renders unlocked when enforcement is OFF (VAULT_REVEAL_REQUIRE_STEPUP=false) — no fake lock', () => {
    expect(initialVaultLock(false, false)).toBe(false)
    expect(initialVaultLock(false, true)).toBe(false)
  })
})

describe('timing constants (prototype: Auto-Sperre 5 min · Auto-Verbergen 20 s)', () => {
  it('locks after 5 minutes and hides a revealed secret after 20 seconds', () => {
    expect(VAULT_AUTO_LOCK_MS).toBe(300_000)
    expect(SECRET_AUTO_HIDE_MS).toBe(20_000)
  })
})

describe('visibleUnits — one Fach per in-scope unit, empty council hidden', () => {
  const units = [
    { id: 'ou-rat', kind: 'council' },
    { id: 'ou-fin', kind: 'referat' },
    { id: 'ou-oef', kind: 'referat' },
  ]
  it('keeps every non-council unit even when its Fach is empty', () => {
    const vis = visibleUnits(units, new Map())
    expect(vis.map((u) => u.id)).toEqual(['ou-fin', 'ou-oef'])
  })
  it('shows a council compartment once it actually holds items', () => {
    const vis = visibleUnits(units, new Map([['ou-rat', 2]]))
    expect(vis.map((u) => u.id)).toEqual(['ou-rat', 'ou-fin', 'ou-oef'])
  })
})

describe('timestamp formatting (deterministic, no ICU dependence)', () => {
  it('formats the meta-line date as dd.mm.yyyy', () => {
    expect(formatVaultDate(new Date(2026, 2, 12))).toBe('12.03.2026')
  })
  it('formats a log row as dd.mm.yyyy · hh:mm', () => {
    expect(formatVaultLogTs(new Date(2026, 6, 14, 11, 3))).toBe('14.07.2026 · 11:03')
  })
})

describe('generatePassphrase — word-based client-side generator (VaultCreate)', () => {
  it('yields word-word-word-word-NN<symbol> with an injected rng', () => {
    expect(generatePassphrase(() => 0)).toBe('anker-anker-anker-anker-00!')
  })
  it('always matches the passphrase shape with a real rng', () => {
    for (let i = 0; i < 20; i++) {
      expect(generatePassphrase()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d\d[!?#$%]$/)
    }
  })
  it('is non-constant across draws (sanity, not a randomness test)', () => {
    const draws = new Set(Array.from({ length: 10 }, () => generatePassphrase()))
    expect(draws.size).toBeGreaterThan(1)
  })
})
