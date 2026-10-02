// test/fints.service.test.ts — mocked-PG unit tests for configureFints + syncFints
// (#383 Lane E3, R6). Mirrors the native oracle:
//   fints-config.ts  — https:// gate, AES-256-GCM encrypt-before-INSERT (write-only
//                      column — the DTO NEVER carries password_encrypted), upsert DTO.
//   fints-sync.ts    — missing config/account → typed NotFound (route 404); statement
//                      fetch via the injectable FintsClient; per-row dedup inserts in
//                      ONE transaction; last_sync_status ok/failed bookkeeping.
//   G-019b ZKA posture — the DEFAULT ProdFintsClient throws the native
//                      FINTS_PRODUCT_ID-unset FintsTransportError, which sync records
//                      as a failed attempt + returns { imported:0, skipped:0,
//                      errors:[msg] } — IDENTICAL to native-unconfigured.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configureFints, FintsConfigValidationError } from '../src/fints/config.ts'
import { syncFints, FintsSyncNotFoundError } from '../src/fints/sync.ts'
import { FakeFintsClient } from '../src/fints/client.ts'
import { decryptFintsPassword } from '../src/fints/crypto.ts'
import type { BankStatementRow } from '../src/bank/types.ts'
import type { Sql } from '../src/tenant-store.ts'

const TEST_KEY = 'a'.repeat(64) // 32-byte hex test key

let envBackup: { key?: string; alt?: string; product?: string }
beforeEach(() => {
  envBackup = {
    key: process.env.FINANCE_FINTS_PASSWORD_KEY,
    alt: process.env.FINTS_PASSWORD_KEY,
    product: process.env.FINTS_PRODUCT_ID,
  }
  process.env.FINANCE_FINTS_PASSWORD_KEY = TEST_KEY
  delete process.env.FINTS_PRODUCT_ID
})
afterEach(() => {
  if (envBackup.key === undefined) delete process.env.FINANCE_FINTS_PASSWORD_KEY
  else process.env.FINANCE_FINTS_PASSWORD_KEY = envBackup.key
  if (envBackup.alt === undefined) delete process.env.FINTS_PASSWORD_KEY
  else process.env.FINTS_PASSWORD_KEY = envBackup.alt
  if (envBackup.product === undefined) delete process.env.FINTS_PRODUCT_ID
  else process.env.FINTS_PRODUCT_ID = envBackup.product
})

// ── configureFints ─────────────────────────────────────────────────────────────

function fakeConfigSql() {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/INSERT INTO finance\.fints_config/.test(q)) {
      return Promise.resolve([{
        id: '3', bank_account_id: String(values[0]), fints_url: values[1],
        bank_code: values[2], username: values[3],
        last_sync_at: null, last_sync_status: null, last_sync_error: null,
      }])
    }
    return Promise.resolve([])
  }) as unknown as Sql
  return { fn, calls }
}

describe('fints config — configureFints', () => {
  it('rejects a non-https fints_url (FintsConfigValidationError → route 400) before ANY query', async () => {
    const { fn, calls } = fakeConfigSql()
    await expect(
      configureFints(fn, 5, { fints_url: 'http://insecure.example', bank_code: 'b', username: 'u', password: 'p' }),
    ).rejects.toBeInstanceOf(FintsConfigValidationError)
    expect(calls).toHaveLength(0)
  })

  it('encrypts the password BEFORE the INSERT (decryptable envelope; plaintext never bound)', async () => {
    const { fn, calls } = fakeConfigSql()
    await configureFints(fn, 5, { fints_url: 'https://fints.example', bank_code: '37040044', username: 'stura', password: 'geheim!' })
    const insert = calls.find((c) => /INSERT INTO finance\.fints_config/.test(c.q))!
    const bound = insert.values.map(String)
    expect(bound).not.toContain('geheim!') // plaintext never reaches the driver
    const envelope = insert.values[4] as string
    expect(decryptFintsPassword(envelope, TEST_KEY)).toBe('geheim!')
  })

  it('returns the FintsConfig DTO with numeric ids and NO password field', async () => {
    const { fn } = fakeConfigSql()
    const dto = await configureFints(fn, 5, { fints_url: 'https://fints.example', bank_code: '37040044', username: 'stura', password: 'p' })
    expect(dto).toEqual({
      id: 3, bank_account_id: 5, fints_url: 'https://fints.example', bank_code: '37040044',
      username: 'stura', last_sync_at: null, last_sync_status: null, last_sync_error: null,
    })
    expect(Object.keys(dto).some((k) => /password/.test(k))).toBe(false)
  })

  it('upserts via ON CONFLICT (bank_account_id) — the UNIQUE-driven branch is in the SQL', async () => {
    const { fn, calls } = fakeConfigSql()
    await configureFints(fn, 5, { fints_url: 'https://fints.example', bank_code: 'b', username: 'u', password: 'p' })
    expect(calls[0]!.q).toMatch(/ON CONFLICT \(bank_account_id\) DO UPDATE/)
  })
})

// ── syncFints ──────────────────────────────────────────────────────────────────

interface SyncFixture {
  hasConfig: boolean
  hasAccount: boolean
  encryptedPassword?: string
  lastSyncAt?: Date | null
  duplicateHashes?: Set<string>
}

function fakeSyncSql(fx: SyncFixture) {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const inserts: unknown[][] = []
  const updates: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/SELECT id, fints_url.*FROM finance\.fints_config/.test(q)) {
      return Promise.resolve(fx.hasConfig ? [{
        id: '3', fints_url: 'https://fints.example', bank_code: '37040044', username: 'stura',
        password_encrypted: fx.encryptedPassword ?? '', last_sync_at: fx.lastSyncAt ?? null,
      }] : [])
    }
    if (/SELECT iban FROM finance\.bank_account/.test(q)) {
      return Promise.resolve(fx.hasAccount ? [{ iban: 'DE12500105170648489890' }] : [])
    }
    if (/INSERT INTO finance\.bank_transaction/.test(q)) {
      const hash = values[9] as string
      if (fx.duplicateHashes?.has(hash)) return Promise.resolve([])
      inserts.push(values)
      return Promise.resolve([{ id: String(inserts.length) }])
    }
    if (/UPDATE finance\.fints_config/.test(q)) {
      updates.push({ q, values })
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }) as unknown as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }
  fn.begin = (async (cb: (tx: unknown) => unknown) => cb(fn)) as never
  return { fn: fn as Sql, calls, inserts, updates }
}

const ROW: BankStatementRow = {
  bookingDate: '2026-05-01', valutaDate: null, counterpartyName: 'Acme',
  counterpartyIban: null, amountCents: -100, saldoCents: null, purpose: 'x', bankReference: 'R1',
}

import { encryptFintsPassword } from '../src/fints/crypto.ts'

describe('fints sync — syncFints', () => {
  it('missing fints_config → FintsSyncNotFoundError (route 404), native message', async () => {
    const { fn } = fakeSyncSql({ hasConfig: false, hasAccount: true })
    await expect(syncFints(fn, 7)).rejects.toBeInstanceOf(FintsSyncNotFoundError)
    await expect(syncFints(fn, 7)).rejects.toThrow('fints_config for bank_account#7 missing')
  })

  it('missing bank_account → FintsSyncNotFoundError (route 404), native message', async () => {
    const { fn } = fakeSyncSql({ hasConfig: true, hasAccount: false, encryptedPassword: encryptFintsPassword('p', TEST_KEY) })
    await expect(syncFints(fn, 7)).rejects.toThrow('bank_account#7 not found')
  })

  it('happy path: staged statements insert in ONE tx; last_sync_status=ok', async () => {
    const { fn, inserts, updates } = fakeSyncSql({ hasConfig: true, hasAccount: true, encryptedPassword: encryptFintsPassword('p', TEST_KEY) })
    const fake = new FakeFintsClient()
    fake.stageStatements([ROW, { ...ROW, bankReference: 'R2' }])
    const res = await syncFints(fn, 7, fake)
    expect(res).toEqual({ imported: 2, skipped: 0, errors: [] })
    expect(inserts).toHaveLength(2)
    const ok = updates.find((u) => /last_sync_status = 'ok'/.test(u.q))
    expect(ok).toBeDefined()
  })

  it('dedup: an ON CONFLICT no-op counts as skipped', async () => {
    const { computeImportHash } = await import('../src/bank/import-hash.ts')
    const dupHash = computeImportHash(ROW)
    const { fn } = fakeSyncSql({
      hasConfig: true, hasAccount: true,
      encryptedPassword: encryptFintsPassword('p', TEST_KEY),
      duplicateHashes: new Set([dupHash]),
    })
    const fake = new FakeFintsClient()
    fake.stageStatements([ROW, { ...ROW, bankReference: 'R2', amountCents: -200 }])
    const res = await syncFints(fn, 7, fake)
    expect(res).toEqual({ imported: 1, skipped: 1, errors: [] })
  })

  it('a client auth error is RECORDED (failed + last_sync_error), not thrown', async () => {
    const { fn, updates } = fakeSyncSql({ hasConfig: true, hasAccount: true, encryptedPassword: encryptFintsPassword('p', TEST_KEY) })
    const fake = new FakeFintsClient()
    fake.stageAuthError()
    const res = await syncFints(fn, 7, fake)
    expect(res.imported).toBe(0)
    expect(res.errors).toEqual(['FinTS auth error: staged auth error'])
    const failed = updates.find((u) => /last_sync_status = 'failed'/.test(u.q))
    expect(failed).toBeDefined()
    expect(failed!.values).toContain('FinTS auth error: staged auth error')
  })

  it('G-019b ZKA POSTURE: the DEFAULT client without FINTS_PRODUCT_ID → recorded failed sync + the NATIVE unconfigured message (op stays LIVE, answers identically to native-unconfigured)', async () => {
    const { fn, updates } = fakeSyncSql({ hasConfig: true, hasAccount: true, encryptedPassword: encryptFintsPassword('p', TEST_KEY) })
    const res = await syncFints(fn, 7) // default ProdFintsClient
    expect(res.imported).toBe(0)
    expect(res.skipped).toBe(0)
    expect(res.errors).toHaveLength(1)
    // Byte-identical to the native LibFintsClient FINTS_PRODUCT_ID gate message.
    expect(res.errors[0]).toBe(
      'FinTS transport error: FINTS_PRODUCT_ID env var is not set — register at ' +
        'fints.org/de/hersteller/produktregistrierung before enabling FinTS sync',
    )
    expect(updates.some((u) => /last_sync_status = 'failed'/.test(u.q))).toBe(true)
  })

  it('F1-FIX-05-K (K4#13): a failed sync never advances last_sync_at (the unfetched window is retried)', async () => {
    const { fn, updates } = fakeSyncSql({ hasConfig: true, hasAccount: true, encryptedPassword: encryptFintsPassword('p', TEST_KEY) })
    const fake = new FakeFintsClient()
    fake.stageAuthError()
    await syncFints(fn, 7, fake)
    const failed = updates.find((u) => /last_sync_status = 'failed'/.test(u.q))
    expect(failed).toBeDefined()
    expect(failed!.q).not.toMatch(/last_sync_at\s*=/)
  })

  it('a corrupt stored envelope is RECORDED as a failed sync (never a 500)', async () => {
    const { fn, updates } = fakeSyncSql({ hasConfig: true, hasAccount: true, encryptedPassword: 'not-base64-envelope' })
    const fake = new FakeFintsClient()
    fake.stageStatements([ROW])
    const res = await syncFints(fn, 7, fake)
    expect(res.imported).toBe(0)
    expect(res.errors).toHaveLength(1)
    expect(updates.some((u) => /last_sync_status = 'failed'/.test(u.q))).toBe(true)
  })
})
