// src/lib/server/module-karenz/retained/crypto.ts
// Module Karenz (phase 2, Task 10): sealing of the retained copies.
//
// Layout:
//   data key    32 random bytes, one active key per tenant database (karenz_data_key), stored only
//               WRAPPED: AES-256-GCM under a key-encryption key (KEK);
//   KEK         HKDF-SHA256(AUTH_SECRET, salt = tenant id, info = 'gremion/karenz/kek/v1');
//   record      AES-256-GCM under the data key, a fresh 12-byte nonce, AAD = tenantId|karenzId|extractorId,
//               plaintext = the NDJSON of the lines. The ciphertext column holds ciphertext || 16-byte tag.
//
// The AAD binds a record to its tenant, its Karenz row and its extractor: a row moved or relabelled in
// the database no longer opens. The stored plaintext_sha256 is checked again on open.
//
// Writes go through ../retained-guard.ts only (insertRetainedRecord, insertDataKey, rewrapDataKey): they
// refuse unless the append-only guard is in place for the current role. Nothing here issues INSERT or
// UPDATE itself.
//
// AUTH_SECRET rotation (plan Open Decision 9): rewrapDataKeys() re-wraps the data keys under the new
// secret and must run as part of the rotation; the sealed records themselves are never rewritten. A
// rotation without it leaves every copy unreadable, and also stops the redaction of earlier erasures
// (subjectRef hashes are keyed with the same secret).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import { insertDataKey, insertRetainedRecord, rewrapDataKey, type RetainedGuardDeps } from '../retained-guard'
import type { RetainedLine } from './extractors'
import { activeDataKey, getDataKey, getRetainedRecord, listDataKeys, type DataKeyRow } from './store'

const KEK_INFO = 'gremion/karenz/kek/v1'
const WRAP_AAD_PREFIX = 'gremion/karenz/key-wrap/v1|'
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class RetainedCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetainedCryptoError'
  }
}

/** The id names no sealed copy (the route answers 404). */
export class RetainedNotFoundError extends Error {
  constructor(id: string) {
    super(`retained record ${id} does not exist`)
    this.name = 'RetainedNotFoundError'
  }
}

export interface SealMeta {
  /** The module catalogue id the lines come from. */
  catalogueId: string
  retentionClass: string
  /** YYYY-MM-DD, or null/omitted for no automatic deletion. */
  holdUntil?: string | null
}

export interface CryptoDeps extends RetainedGuardDeps {
  /** The deployment secret; defaults to process.env.AUTH_SECRET. An empty value is refused. */
  secret?: string
}

function requireSecret(secret: string | undefined): string {
  const s = secret ?? process.env.AUTH_SECRET
  if (!s) throw new RetainedCryptoError('AUTH_SECRET must be set to seal or open retained copies')
  return s
}

/** The tenant-bound key-encryption key. */
function deriveKek(tenantId: string, secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, tenantId, KEK_INFO, 32))
}

function wrapDataKey(dataKey: Buffer, kek: Buffer, tenantId: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, nonce)
  cipher.setAAD(Buffer.from(WRAP_AAD_PREFIX + tenantId))
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()])
}

function unwrapDataKey(wrapped: Buffer, kek: Buffer, tenantId: string): Buffer {
  if (wrapped.length < NONCE_BYTES + TAG_BYTES + 1) throw new RetainedCryptoError('the wrapped data key is malformed')
  const nonce = wrapped.subarray(0, NONCE_BYTES)
  const tag = wrapped.subarray(wrapped.length - TAG_BYTES)
  const ct = wrapped.subarray(NONCE_BYTES, wrapped.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce)
  decipher.setAAD(Buffer.from(WRAP_AAD_PREFIX + tenantId))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new RetainedCryptoError('the data key does not unwrap (wrong AUTH_SECRET or tenant)')
  }
}

const recordAad = (tenantId: string, karenzId: string, extractorId: string): Buffer => Buffer.from(`${tenantId}|${karenzId}|${extractorId}`)

/** The NDJSON of the lines: one JSON object per line, each terminated by a newline. */
export function toNdjson(lines: readonly RetainedLine[]): string {
  return lines.map((l) => JSON.stringify(l) + '\n').join('')
}

function parseNdjson(text: string): RetainedLine[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RetainedLine)
}

const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/**
 * Seal `lines` as one retained copy and store it. Mints the tenant's data key on first use, reuses
 * the active one afterwards. Run it inside the caller's transaction (write.ts does): a record that
 * fails to insert then leaves no key row behind either.
 */
export async function sealLines(
  db: Sql,
  tenantId: string,
  karenzId: string,
  extractorId: string,
  lines: readonly RetainedLine[],
  meta: SealMeta,
  deps: CryptoDeps = {},
): Promise<{ id: string; lineCount: number; sha256: string }> {
  const secret = requireSecret(deps.secret)
  const kek = deriveKek(tenantId, secret)
  const plaintext = Buffer.from(toNdjson(lines), 'utf8')
  const sha256 = sha256Hex(plaintext)
  // the hashed reference of every person named, never the id: the reader redacts against these
  const subjectRefs = [...new Set(lines.flatMap((l) => l.persons.map((p) => subjectRef(tenantId, p.id, secret))))].toSorted()

  let keyId: string
  let dataKey: Buffer
  const existing = await activeDataKey(db)
  if (existing) {
    // a key that does not unwrap means the secret changed: say so, never mint a second key beside it
    dataKey = unwrapDataKey(existing.wrapped, kek, tenantId)
    keyId = existing.keyId
  } else {
    dataKey = randomBytes(32)
    keyId = await insertDataKey(db, wrapDataKey(dataKey, kek, tenantId), 1, deps)
  }

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce)
  cipher.setAAD(recordAad(tenantId, karenzId, extractorId))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const id = await insertRetainedRecord(
    db,
    {
      karenzId,
      catalogueId: meta.catalogueId,
      retentionClass: meta.retentionClass,
      extractorId,
      lineCount: lines.length,
      plaintextSha256: sha256,
      keyId,
      nonce,
      ciphertext,
      subjectRefs,
      holdUntil: meta.holdUntil ?? null,
    },
    deps,
  )
  return { id, lineCount: lines.length, sha256 }
}

/**
 * Open one sealed copy to its lines, UNREDACTED (the reader redacts: serve.ts, Task 11). Throws
 * RetainedNotFoundError for an unknown id and RetainedCryptoError for a copy that does not verify.
 */
export async function openLines(db: Sql, tenantId: string, id: string, deps: Pick<CryptoDeps, 'secret'> = {}): Promise<RetainedLine[]> {
  const secret = requireSecret(deps.secret)
  const rec = await getRetainedRecord(db, id)
  if (!rec) throw new RetainedNotFoundError(id)
  const key = await getDataKey(db, rec.keyId)
  if (!key) throw new RetainedCryptoError(`the data key of retained record ${id} is missing`)
  const dataKey = unwrapDataKey(key.wrapped, deriveKek(tenantId, secret), tenantId)

  if (rec.ciphertext.length < TAG_BYTES) throw new RetainedCryptoError(`retained record ${id} is malformed`)
  const decipher = createDecipheriv('aes-256-gcm', dataKey, rec.nonce)
  decipher.setAAD(recordAad(tenantId, rec.karenzId, rec.extractorId))
  decipher.setAuthTag(rec.ciphertext.subarray(rec.ciphertext.length - TAG_BYTES))
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(rec.ciphertext.subarray(0, rec.ciphertext.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new RetainedCryptoError(`retained record ${id} does not verify (tampered, or sealed for another tenant or Karenz row)`)
  }
  if (sha256Hex(plaintext) !== rec.plaintextSha256) throw new RetainedCryptoError(`retained record ${id}: the plaintext hash does not match the stored hash`)
  const lines = parseNdjson(plaintext.toString('utf8'))
  if (lines.length !== rec.lineCount) throw new RetainedCryptoError(`retained record ${id}: the line count does not match`)
  return lines
}

function opensUnder(key: DataKeyRow, kek: Buffer, tenantId: string): boolean {
  try {
    unwrapDataKey(key.wrapped, kek, tenantId)
    return true
  } catch {
    return false
  }
}

/**
 * The AUTH_SECRET rotation step: re-wrap every data key of the tenant from the old to the new secret
 * (compare-and-swap through rewrapDataKey, so a concurrent run cannot clobber it). Returns how many
 * keys were re-wrapped. Safe to run again: a key that already opens under the new secret is skipped;
 * a key that opens under neither stops the run (nothing is guessed).
 */
export async function rewrapDataKeys(db: Sql, tenantId: string, oldSecret: string, newSecret: string): Promise<number> {
  // both secrets are explicit here: an empty one never falls back to the environment
  if (!oldSecret || !newSecret) throw new RetainedCryptoError('AUTH_SECRET: both the old and the new secret are required to re-wrap the data keys')
  const oldKek = deriveKek(tenantId, oldSecret)
  const newKek = deriveKek(tenantId, newSecret)
  let rewrapped = 0
  for (const key of await listDataKeys(db)) {
    if (opensUnder(key, newKek, tenantId)) continue
    if (!opensUnder(key, oldKek, tenantId)) throw new RetainedCryptoError(`data key ${key.keyId} opens under neither the old nor the new secret`)
    const dataKey = unwrapDataKey(key.wrapped, oldKek, tenantId)
    if (await rewrapDataKey(db, key.keyId, key.kekVersion, wrapDataKey(dataKey, newKek, tenantId))) {
      rewrapped++
      continue
    }
    // someone else changed the row first: fine when it is now under the new secret, an error otherwise
    const now = await getDataKey(db, key.keyId)
    if (!now || !opensUnder(now, newKek, tenantId)) throw new RetainedCryptoError(`data key ${key.keyId} changed while it was re-wrapped; run the rotation again`)
  }
  return rewrapped
}
