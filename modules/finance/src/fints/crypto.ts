// services/finance/src/fints/crypto.ts
// #383 Lane E, (e) — AES-256-GCM at-rest crypto for the FinTS password column.
//
// Ported from the native oracle gremion-ui/.../services/money/fints-crypto.ts. The
// finance leaf is a plain node service (no SvelteKit $env), so the key is read from
// process.env or passed explicitly; the algorithm + envelope are byte-identical to
// the native so a password encrypted by either side decrypts under the same key.
//
// Envelope on the wire: base64([ IV(12) | ciphertext(N) | authTag(16) ]).
//
// Why AES-256-GCM (not a KDF): the FinTS sync pipeline must DECRYPT the password to
// hand it to the FinTS client — a one-way hash cannot recover the plaintext. AES-GCM
// with a random per-message IV gives AEAD (secrecy + tamper-evidence).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16

/**
 * Resolve the 32-byte AES key. Prefer an explicit key (tests pass one); otherwise
 * FINANCE_FINTS_PASSWORD_KEY, then FINTS_PASSWORD_KEY (parity with the native env
 * name), each a 64-char hex string. Throws if unset or not exactly 32 bytes.
 */
export function loadFintsKey(explicit?: string): Buffer {
  const raw = explicit ?? process.env.FINANCE_FINTS_PASSWORD_KEY ?? process.env.FINTS_PASSWORD_KEY
  if (!raw) {
    throw new Error('FINANCE_FINTS_PASSWORD_KEY env var is not set')
  }
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== 32) {
    throw new Error('FINANCE_FINTS_PASSWORD_KEY must be 32 bytes (64 hex chars)')
  }
  return buf
}

function resolveKey(key: string | Buffer | undefined): Buffer {
  return Buffer.isBuffer(key) ? key : loadFintsKey(key)
}

export function encryptFintsPassword(plain: string, key?: string | Buffer): string {
  const k = resolveKey(key)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

export function decryptFintsPassword(envelope: string, key?: string | Buffer): string {
  const k = resolveKey(key)
  const buf = Buffer.from(envelope, 'base64')
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('FinTS ciphertext envelope is too short')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAuthTag(tag)
  // .final() throws on AEAD mismatch (tampered ciphertext or wrong key).
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}
