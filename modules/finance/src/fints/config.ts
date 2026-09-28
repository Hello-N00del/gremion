// services/finance/src/fints/config.ts
// #383 Lane E3 — configureFints (leaf side). Ported from the native oracle
// gremion-ui/.../services/money/fints-config.ts. Upserts a finance.fints_config row,
// encrypting the password via AES-256-GCM (fints/crypto.ts) before INSERT. The
// UNIQUE (bank_account_id) constraint drives the ON CONFLICT branch.
//
// The returned FintsConfig DTO NEVER exposes password_encrypted (write-only at the
// API surface). Shape is byte-identical to the native configureFints return + the ACL
// client's FintsConfig contract (stufis-client.ts FintsConfigSchema).
import type { Sql } from '../tenant-store.js'
import { encryptFintsPassword } from './crypto.js'

export interface FintsConfigDto {
  id: number
  bank_account_id: number
  fints_url: string
  bank_code: string
  username: string
  last_sync_at: string | null
  last_sync_status: 'ok' | 'failed' | null
  last_sync_error: string | null
}

/** Thrown when fints_url is not https:// (route → 400). Mirrors the native
 *  `fints_url must be https://` throw. */
export class FintsConfigValidationError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'FintsConfigValidationError'
  }
}

interface FintsConfigUpsertRow {
  id: string
  bank_account_id: string
  fints_url: string
  bank_code: string
  username: string
  last_sync_at: Date | null
  last_sync_status: 'ok' | 'failed' | null
  last_sync_error: string | null
}

export async function configureFints(
  sql: Sql,
  bankAccountId: number,
  input: { fints_url: string; bank_code: string; username: string; password: string },
): Promise<FintsConfigDto> {
  if (!input.fints_url.startsWith('https://')) {
    throw new FintsConfigValidationError('fints_url must be https://')
  }
  const passwordEncrypted = encryptFintsPassword(input.password)
  const rows = await sql<FintsConfigUpsertRow[]>`
    INSERT INTO finance.fints_config
      (bank_account_id, fints_url, bank_code, username, password_encrypted)
    VALUES (${bankAccountId}, ${input.fints_url}, ${input.bank_code},
            ${input.username}, ${passwordEncrypted})
    ON CONFLICT (bank_account_id) DO UPDATE
      SET fints_url = EXCLUDED.fints_url,
          bank_code = EXCLUDED.bank_code,
          username = EXCLUDED.username,
          password_encrypted = EXCLUDED.password_encrypted
    RETURNING id, bank_account_id, fints_url, bank_code, username,
              last_sync_at, last_sync_status, last_sync_error`
  const r = rows[0]!
  return {
    id: Number(r.id),
    bank_account_id: Number(r.bank_account_id),
    fints_url: r.fints_url,
    bank_code: r.bank_code,
    username: r.username,
    last_sync_at: r.last_sync_at == null ? null : r.last_sync_at.toISOString(),
    last_sync_status: r.last_sync_status ?? null,
    last_sync_error: r.last_sync_error ?? null,
  }
}
