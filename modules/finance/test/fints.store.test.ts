// test/fints.store.test.ts — mocked-PG unit test for the FinTS status read
// domain (#383 R10 scope-forwarding). Mirrors read/fints.ts + dto-map.ts#
// toFintsStatusDto AND the native visibility gate: a non-visible bank account →
// null (route 404), then the config read; no fints_config row →
// { configured:false, …nulls }; a config row → { configured:true, … } with the
// timestamptz coerced to ISO-Z.
//
// R10: getFintsStatus now takes a ScopeContext. Visibility gate — auditor: the
// account need only EXIST; non-auditor: must own a ledger on it (org_unit ∈ scope),
// else the G-019 anti-probing null even for an EXISTING account; empty scope → null.
// DIVERGENCE (native quirk): gated on isAuditor ONLY — a superuser-not-auditor is
// STILL org-unit-scoped here (unlike expense/receipt).

import { describe, it, expect } from 'vitest'
import { getFintsStatus, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// account 5 → OU_A (configured); account 9 → OU_B (no config); 999 → does not exist.
const OWNER: Record<string, string> = { '5': OU_A, '9': OU_B }
const CONFIG: Record<string, Record<string, unknown>> = {
  '5': { bank_code: '37040044', username: 'stura', last_sync_at: new Date('2026-03-01T12:00:00.000Z'), last_sync_status: 'ok', last_sync_error: null },
}

/** Query-aware fake: routes the existence check / scoped-visibility JOIN / config
 *  read to a tiny two-org-unit fixture and records every issued query. */
function fakeSql() {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/FROM finance\.fints_config/.test(q)) {
      const cfg = CONFIG[String(values[0])]
      return Promise.resolve(cfg ? [cfg] : [])
    }
    if (/JOIN finance\.ledger_account/.test(q)) {
      const id = String(values[0])
      const scope = (values[values.length - 1] ?? []) as string[]
      return Promise.resolve(OWNER[id] && scope.includes(OWNER[id]!) ? [{ id }] : [])
    }
    if (/FROM finance\.bank_account WHERE id/.test(q)) {
      const id = String(values[0])
      return Promise.resolve(OWNER[id] ? [{ id }] : [])
    }
    return Promise.resolve([])
  }) as unknown as Sql
  return { fn, calls }
}

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
const CONFIGURED_DTO = {
  configured: true,
  bank_code: '37040044',
  username: 'stura',
  last_sync_at: '2026-03-01T12:00:00.000Z',
  last_sync_status: 'ok',
  last_sync_error: null,
}
const EMPTY_DTO = {
  configured: false,
  bank_code: null,
  username: null,
  last_sync_at: null,
  last_sync_status: null,
  last_sync_error: null,
}

describe('fints store — getFintsStatus DTO mapping (auditor path)', () => {
  it('returns null when the bank account does not exist (→ route 404)', async () => {
    const { fn } = fakeSql()
    expect(await getFintsStatus(fn, 999, AUDITOR)).toBeNull()
  })

  it('returns { configured:false, …nulls } when no fints_config row exists', async () => {
    const { fn } = fakeSql()
    expect(await getFintsStatus(fn, 9, AUDITOR)).toEqual(EMPTY_DTO)
  })

  it('returns the configured status with the timestamptz coerced to ISO-Z', async () => {
    const { fn } = fakeSql()
    expect(await getFintsStatus(fn, 5, AUDITOR)).toEqual(CONFIGURED_DTO)
  })
})

describe('fints store — getFintsStatus visibility gate (R10, four lenses + divergence)', () => {
  it('scoped non-auditor whose ledger owns the account sees its status', async () => {
    const { fn, calls } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    expect(await getFintsStatus(fn, 5, scoped)).toEqual(CONFIGURED_DTO)
    expect(calls.some((c) => /JOIN finance\.ledger_account/.test(c.q))).toBe(true) // scoped visibility JOIN
  })

  // G-019 ORDERING (both sub-cases): the visibility gate runs BEFORE the config
  // read, so an out-of-scope-but-EXISTING account 404s regardless of whether a
  // fints_config row exists — the config query must never run (no existence leak).
  it('out-of-scope-but-EXISTING account WITHOUT config → null (no {configured:false} leak; config never read)', async () => {
    const { fn, calls } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    expect(await getFintsStatus(fn, 9, scoped)).toBeNull() // account 9 exists (OU_B, no config), out of scope
    expect(calls.some((c) => /FROM finance\.fints_config/.test(c.q))).toBe(false) // gate short-circuits before the config read
  })

  it('out-of-scope-but-EXISTING account WITH config → null (no {configured:true} leak; config never read)', async () => {
    const { fn, calls } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B] }
    // account 5 exists (OU_A) and HAS a fints_config, but is out of THIS actor's scope.
    expect(await getFintsStatus(fn, 5, scoped)).toBeNull()
    expect(calls.some((c) => /FROM finance\.fints_config/.test(c.q))).toBe(false) // config for account 5 is NEVER read
  })

  it('empty scope + not see-all → null WITHOUT issuing a query (short-circuit)', async () => {
    const { fn, calls } = fakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    expect(await getFintsStatus(fn, 5, empty)).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('DIVERGENCE: superuser-not-auditor is STILL org-unit-scoped — out-of-scope account → null', async () => {
    const { fn, calls } = fakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    // account 9 (OU_B) is out of the superuser's scope → still 404, NOT see-all.
    expect(await getFintsStatus(fn, 9, superuser)).toBeNull()
    expect(calls.some((c) => /JOIN finance\.ledger_account/.test(c.q))).toBe(true) // scoped path taken
    // and it DOES see its own in-scope account.
    const two = fakeSql()
    expect(await getFintsStatus(two.fn, 5, superuser)).toEqual(CONFIGURED_DTO)
  })
})
