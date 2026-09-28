// test/fints.crypto.test.ts — the FinTS at-rest crypto primitive (#383 Lane E, (e)).
//
// The finance leaf must DECRYPT a stored FinTS password at sync time to hand it to
// the FinTS client, so a one-way KDF is unusable — AES-256-GCM (AEAD) with a random
// per-message IV is the right primitive (ported verbatim from the native oracle
// gremion-ui/.../services/money/fints-crypto.ts, minus the SvelteKit $env coupling so
// the leaf reads process.env / an explicit key instead).
//
// Envelope on the wire: base64([ IV(12) | ciphertext(N) | authTag(16) ]).

import { describe, it, expect } from 'vitest'
import {
  encryptFintsPassword,
  decryptFintsPassword,
  loadFintsKey,
} from '../src/fints/crypto.ts'

// A deterministic 32-byte test key (64 hex chars) — the "test key" the round-trip runs under.
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const OTHER = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'

describe('fints/crypto — AES-256-GCM at-rest', () => {
  it('encrypt→decrypt round-trips the plaintext with a test key', () => {
    const plain = 'hunter2-Ünïcödé-🔐'
    const envelope = encryptFintsPassword(plain, KEY)
    expect(decryptFintsPassword(envelope, KEY)).toBe(plain)
  })

  it('the ciphertext envelope is base64 and never equals the plaintext', () => {
    const plain = 'super-secret-banking-pin'
    const envelope = encryptFintsPassword(plain, KEY)
    expect(envelope).not.toContain(plain)
    // Valid base64 (re-encoding the decoded bytes is stable).
    expect(Buffer.from(envelope, 'base64').toString('base64')).toBe(envelope)
  })

  it('is non-deterministic — two encryptions of the same plaintext differ (random IV)', () => {
    const a = encryptFintsPassword('same', KEY)
    const b = encryptFintsPassword('same', KEY)
    expect(a).not.toBe(b)
    expect(decryptFintsPassword(a, KEY)).toBe('same')
    expect(decryptFintsPassword(b, KEY)).toBe('same')
  })

  it('round-trips an empty string', () => {
    expect(decryptFintsPassword(encryptFintsPassword('', KEY), KEY)).toBe('')
  })

  it('decrypting under the WRONG key throws (AEAD auth-tag mismatch)', () => {
    const envelope = encryptFintsPassword('secret', KEY)
    expect(() => decryptFintsPassword(envelope, OTHER)).toThrow()
  })

  it('decrypting a TAMPERED envelope throws (auth-tag mismatch)', () => {
    const buf = Buffer.from(encryptFintsPassword('secret', KEY), 'base64')
    buf[buf.length - 1] ^= 0xff // flip a byte in the auth tag
    expect(() => decryptFintsPassword(buf.toString('base64'), KEY)).toThrow()
  })

  it('rejects a truncated envelope shorter than IV+tag', () => {
    expect(() => decryptFintsPassword(Buffer.alloc(4).toString('base64'), KEY)).toThrow()
  })

  it('loadFintsKey rejects a key that is not exactly 32 bytes', () => {
    expect(() => loadFintsKey('00')).toThrow(/32 bytes/)
    expect(() => loadFintsKey(KEY)).not.toThrow()
  })

  it('loadFintsKey falls back to FINANCE_FINTS_PASSWORD_KEY from the environment', () => {
    const prev = process.env.FINANCE_FINTS_PASSWORD_KEY
    process.env.FINANCE_FINTS_PASSWORD_KEY = KEY
    try {
      const envelope = encryptFintsPassword('via-env')
      expect(decryptFintsPassword(envelope)).toBe('via-env')
    } finally {
      if (prev === undefined) delete process.env.FINANCE_FINTS_PASSWORD_KEY
      else process.env.FINANCE_FINTS_PASSWORD_KEY = prev
    }
  })
})
