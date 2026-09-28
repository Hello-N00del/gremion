// services/vault/test/crypto.test.ts
// Unit contract for the vault leaf's at-rest secret crypto (src/crypto.ts).
// AES-256-GCM: authenticated encryption. Proves (1) a round-trip recovers the
// exact plaintext, (2) any tamper of the stored blob makes decrypt THROW (GCM
// auth-tag failure — never silently returns corrupted plaintext), (3) each
// encryption uses a fresh IV (identical plaintext → distinct ciphertext), and
// (4) the key loader validates a 32-byte (64-hex) key.
import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret, resolveKey } from '../src/crypto.ts'

const KEY = Buffer.from('0'.repeat(64), 'hex') // 32 bytes
const OTHER_KEY = Buffer.from('f'.repeat(64), 'hex') // 32 bytes, different

describe('encryptSecret / decryptSecret — AES-256-GCM round-trip', () => {
  it('round-trips an ASCII secret', () => {
    const secret = 'hunter2-correct-horse'
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret)
  })

  it('round-trips a unicode + multi-line secret', () => {
    const secret = 'pä$$wörd\nline2\t🔐 end'
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret)
  })

  it('round-trips an empty string', () => {
    expect(decryptSecret(encryptSecret('', KEY), KEY)).toBe('')
  })

  it('uses a fresh IV each call — same plaintext yields distinct ciphertext', () => {
    const a = encryptSecret('same', KEY)
    const b = encryptSecret('same', KEY)
    expect(a).not.toBe(b)
    // …yet both decrypt back to the same plaintext.
    expect(decryptSecret(a, KEY)).toBe('same')
    expect(decryptSecret(b, KEY)).toBe('same')
  })
})

describe('decryptSecret — tamper THROWS (authenticated)', () => {
  it('throws when a byte of the ciphertext blob is flipped', () => {
    const blob = encryptSecret('do-not-corrupt-me', KEY)
    const raw = Buffer.from(blob, 'base64')
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff // flip the last byte (ciphertext/tag)
    const tampered = raw.toString('base64')
    expect(() => decryptSecret(tampered, KEY)).toThrow()
  })

  it('throws when decrypted with the wrong key', () => {
    const blob = encryptSecret('secret', KEY)
    expect(() => decryptSecret(blob, OTHER_KEY)).toThrow()
  })

  it('throws on a structurally too-short blob', () => {
    expect(() => decryptSecret(Buffer.from('short').toString('base64'), KEY)).toThrow()
  })
})

describe('resolveKey — 32-byte (64-hex) key loader', () => {
  it('parses an explicit 64-hex string into a 32-byte Buffer', () => {
    const key = resolveKey('0'.repeat(64), 'VAULT_ENCRYPTION_KEY')
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it('reads from the named env var when no explicit value is passed', () => {
    const prev = process.env['VAULT_ENCRYPTION_KEY']
    process.env['VAULT_ENCRYPTION_KEY'] = 'a'.repeat(64)
    try {
      expect(resolveKey(undefined, 'VAULT_ENCRYPTION_KEY').length).toBe(32)
    } finally {
      if (prev === undefined) delete process.env['VAULT_ENCRYPTION_KEY']
      else process.env['VAULT_ENCRYPTION_KEY'] = prev
    }
  })

  it('throws when the key is unset', () => {
    const prev = process.env['VAULT_ENCRYPTION_KEY']
    delete process.env['VAULT_ENCRYPTION_KEY']
    try {
      expect(() => resolveKey(undefined, 'VAULT_ENCRYPTION_KEY')).toThrow(/VAULT_ENCRYPTION_KEY/)
    } finally {
      if (prev !== undefined) process.env['VAULT_ENCRYPTION_KEY'] = prev
    }
  })

  it('throws when the key is not 32 bytes (wrong length)', () => {
    expect(() => resolveKey('abcd', 'VAULT_ENCRYPTION_KEY')).toThrow(/32 bytes/)
  })
})
