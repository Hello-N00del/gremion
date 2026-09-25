// TASK-009 lane C, fix round 1 (review r1-finance-C1C2, LOW/lang:sql):
// getFinanzordnungProfile used `SELECT *` + `{ ...r }` to build the DTO. The
// leaf's HTTP surface serves this row directly (getFinanzordnungProfileHandler),
// so any column beyond FinanzordnungProfileDto — including the JSONB
// signer_stages / decision_authority_tiers columns, which are NOT part of the
// public DTO — silently joined the HTTP response. This pins that the DTO
// contains ONLY its declared fields, even when the row carries extra columns.
import { describe, it, expect } from 'vitest'
import { getFinanzordnungProfile } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const RAW_ROW = {
  id: '1',
  bundesland: 'Sachsen',
  deckungsfaehigkeit_pct: '20',
  reserve_base: 'contribution_income',
  reserve_frei_amount_cents: '100000',
  reserve_frei_bound: 'floor',
  reserve_betriebsmittel_amount_cents: '200000',
  reserve_betriebsmittel_bound: 'floor',
  reserve_zweckgebunden_amount_cents: '300000',
  reserve_zweckgebunden_bound: 'ceiling',
  carry_over_central: 'to_reserves',
  carry_over_fachschaft: 'carry_forward',
  retention_years: 10,
  retention_from: 'entlastung',
  inventar_threshold_cents: '50000',
  handkasse_cap_cents: null,
  majority_haushalt: 'simple',
  majority_nachtrag: 'simple',
  majority_entlastung: 'two-thirds',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  // Extra columns a `SELECT *` would surface — must NOT reach the DTO.
  signer_stages: [{ role: 'KV', required_group: 'ref-finanzen-kv', certifies: ['sachlich'] }],
  decision_authority_tiers: [{ max_amount_cents: null, required_group: 'ref-finanzen-hv' }],
}

function fakeSql(row: Record<string, unknown> | null) {
  const fn = (() => Promise.resolve(row ? [row] : [])) as unknown as Sql
  return fn
}

describe('getFinanzordnungProfile — explicit column list (fix round 1)', () => {
  it('maps the DTO fields correctly (numeric casts, retention passthrough)', async () => {
    const dto = await getFinanzordnungProfile(fakeSql(RAW_ROW))
    expect(dto).toMatchObject({
      id: 1,
      bundesland: 'Sachsen',
      deckungsfaehigkeit_pct: 20,
      retention_years: 10,
      retention_from: 'entlastung',
      handkasse_cap_cents: null,
    })
  })

  it('never leaks signer_stages / decision_authority_tiers into the DTO', async () => {
    const dto = await getFinanzordnungProfile(fakeSql(RAW_ROW))
    expect(dto).not.toHaveProperty('signer_stages')
    expect(dto).not.toHaveProperty('decision_authority_tiers')
  })

  it('returns null when there is no profile row', async () => {
    expect(await getFinanzordnungProfile(fakeSql(null))).toBeNull()
  })
})
