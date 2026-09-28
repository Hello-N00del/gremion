// services/vault/src/crypto.ts
//
// Authenticated at-rest encryption for vault secrets. AES-256-GCM: a fresh random
// 96-bit IV per encryption, a 128-bit auth tag. The stored blob is
//   base64( iv(12) || tag(16) || ciphertext )
// GCM is authenticated, so ANY tamper of the stored blob (or the wrong key) makes
// decryptSecret THROW at decipher.final() — it never returns corrupted plaintext.
//
// The key is a raw 32-byte value supplied as 64 hex chars (VAULT_ENCRYPTION_KEY);
// it lives only in the leaf process, never in the database.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`[vault:crypto] key must be a ${KEY_BYTES}-byte Buffer, got ${Buffer.isBuffer(key) ? key.length + ' bytes' : typeof key}`)
  }
}

/** Encrypt a plaintext secret → base64(iv || tag || ciphertext). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/** Decrypt a base64(iv || tag || ciphertext) blob. THROWS on any tamper, the
 *  wrong key, or a structurally malformed (too-short) blob. */
export function decryptSecret(blob: string, key: Buffer): string {
  assertKey(key)
  const raw = Buffer.from(blob, 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('[vault:crypto] ciphertext blob is too short to be valid')
  }
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  // final() raises on a failed GCM tag check (tamper / wrong key).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Resolve the 32-byte AES key from an explicit hex string or the named env var
 * (default VAULT_ENCRYPTION_KEY). Fails closed: throws when unset/empty or when
 * the decoded key is not exactly 32 bytes (64 hex chars).
 */
export function resolveKey(explicit: string | undefined, envName = 'VAULT_ENCRYPTION_KEY'): Buffer {
  const hex = explicit ?? process.env[envName]
  if (!hex) {
    throw new Error(`[vault:crypto] no encryption key configured — set ${envName} to 64 hex chars (32 bytes).`)
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== KEY_BYTES) {
    throw new Error(`[vault:crypto] ${envName} must decode to ${KEY_BYTES} bytes (64 hex chars); got ${key.length} bytes.`)
  }
  return key
}
