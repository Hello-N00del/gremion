// test/yearend-parity.test.ts — #435 PARITY GUARD for the FIN-52 closeBudget port.
//
// The year-end HGB retention + reserve-adjustment rules exist TWICE:
//
//   A) the original, gremion-ui/src/lib/server/finance/services/yearend/
//        · retention.ts#computeRetentionUntil  (HGB_RETENTION_YEARS = 10)
//        · reserves.ts#planReserveAdjustment   (master spec §3.5)
//   B) the FIN-52 leaf port, services/finance/src/store/index.ts (~:2843/:2885)
//
// Both encode statute (HGB §257 10-year floor) and Finanzordnung policy. Patching a
// future amendment on ONE side would silently diverge: the monolith and the leaf would
// stamp different retention_until values / different reserve deltas for the SAME close.
//
// #435 offered two remedies — extract a shared package under packages/, or guard the
// duplication with a parity test. We take the PARITY TEST: a new packages/ member
// collides head-on with the pending #453 kernel-first pull-in (which re-cuts what lives
// under packages/ and in which direction the dependency points), and #435's own triage
// recommends the test given that. The duplication is therefore DELIBERATE and this file
// is the thing that keeps it honest — it drives BOTH implementations over one fixture
// matrix and asserts byte-equal results.
//
// If this suite fails: you changed one side only. Either mirror the change on the other
// side, or — if the divergence is intentional — delete the duplicate and say so here.
//
// MUTATION-CHECKED: flipping HGB_RETENTION_YEARS on either side turns the retention
// matrix red (see the #435 commit message / issue thread for the recorded run).
//
// CI: .github/workflows/services.yml is path-filtered, so #435 also added
// `gremion-ui/src/lib/server/finance/services/yearend/**` to its triggers — otherwise an
// amendment landing ONLY on the monolith side would never run this file.

import { describe, it, expect } from 'vitest'

// ── side B: the finance leaf port ─────────────────────────────────────────────
import {
  computeRetentionUntil as leafComputeRetentionUntil,
  planReserveAdjustment as leafPlanReserveAdjustment,
  type ReserveProfileRow,
} from '../src/store/index.ts'

// ── side A: the gremion-ui original ───────────────────────────────────────────
// Reached by relative path ON PURPOSE. There is no shared package to import from
// (that is the whole point of #435), and a path alias would hide the cross-repo-
// boundary reach that makes this guard necessary. Both modules are pure: their only
// imports are `import type`, so nothing DB-ish is pulled into this dependency-free run.
import { computeRetentionUntil as uiComputeRetentionUntil } from '../../../gremion-ui/src/lib/server/finance/services/yearend/retention.ts'
import { planReserveAdjustment as uiPlanReserveAdjustment } from '../../../gremion-ui/src/lib/server/finance/services/yearend/reserves.ts'
import type { FinanzordnungProfile } from '../../../gremion-ui/src/lib/server/finance/repositories/types.ts'

// ═══════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════════

/** One profile literal, projected into BOTH sides' row shapes so neither
 *  implementation can be accused of getting a friendlier input. */
interface ProfileFixture {
  readonly reserve_frei_bound: 'ceiling' | 'floor'
  readonly reserve_frei_amount_cents: number
  readonly reserve_betriebsmittel_amount_cents: number
  readonly reserve_zweckgebunden_amount_cents: number
  readonly retention_years: number
  readonly retention_from: 'entlastung' | 'fiscal_year_end'
}

function asLeafRow(p: ProfileFixture): ReserveProfileRow {
  return {
    reserve_frei_bound: p.reserve_frei_bound,
    reserve_frei_amount_cents: p.reserve_frei_amount_cents,
    reserve_betriebsmittel_amount_cents: p.reserve_betriebsmittel_amount_cents,
    reserve_zweckgebunden_amount_cents: p.reserve_zweckgebunden_amount_cents,
    retention_years: p.retention_years,
    retention_from: p.retention_from,
  }
}

function asUiProfile(p: ProfileFixture): FinanzordnungProfile {
  return {
    id: 1,
    bundesland: 'BY',
    deckungsfaehigkeit_pct: 0,
    reserve_base: 'contribution_income',
    reserve_frei_amount_cents: p.reserve_frei_amount_cents,
    reserve_frei_bound: p.reserve_frei_bound,
    reserve_betriebsmittel_amount_cents: p.reserve_betriebsmittel_amount_cents,
    reserve_betriebsmittel_bound: 'ceiling',
    reserve_zweckgebunden_amount_cents: p.reserve_zweckgebunden_amount_cents,
    reserve_zweckgebunden_bound: 'ceiling',
    carry_over_central: 'to_reserves',
    carry_over_fachschaft: 'carry_forward',
    retention_years: p.retention_years,
    retention_from: p.retention_from,
    inventar_threshold_cents: 80000,
    handkasse_cap_cents: null,
    majority_haushalt: 'simple',
    majority_nachtrag: 'simple',
    majority_entlastung: 'simple',
    created_at: new Date(0),
    updated_at: new Date(0),
  }
}

const d = (iso: string): Date => new Date(iso)

// ═══════════════════════════════════════════════════════════════════════════════
// Retention parity — computeRetentionUntil
// ═══════════════════════════════════════════════════════════════════════════════

// Retention horizons that straddle the 10-year HGB floor from every side: shorter
// than the floor (floor must win), exactly at it (tie → floor), and longer (the
// Finanzordnung must win). 0 and 1 pin the degenerate ends.
const RETENTION_YEARS = [0, 1, 6, 9, 10, 11, 12, 30] as const
const RETENTION_FROM = ['entlastung', 'fiscal_year_end'] as const

// Fiscal-year ends: the ordinary 31 Dec, a mid-year end (fiscal ≠ calendar year),
// a leap-day end (setUTCFullYear on 29 Feb rolls to 1 Mar in non-leap targets — the
// single nastiest date-arithmetic edge in this function), an end landing ON a leap
// day ten years out, the 1 Jan / 31 Dec year boundaries, and a pre-1970 epoch-negative
// date to catch any getTime() sign assumption.
const FY_ENDS = [
  '2024-12-31T00:00:00.000Z', // ordinary FY end
  '2024-02-29T00:00:00.000Z', // leap day → +10y = 2034-03-01
  '2016-02-29T00:00:00.000Z', // leap day → +8y lands on 2024-02-29 (still leap)
  '2025-06-30T00:00:00.000Z', // mid-year FY end
  '2025-01-01T00:00:00.000Z', // year-start boundary
  '2025-12-31T23:59:59.999Z', // last instant of the year
  '2025-03-30T22:00:00.000Z', // Europe/Berlin DST spring-forward instant
  '2025-10-26T01:00:00.000Z', // Europe/Berlin DST fall-back instant
  '1969-07-20T20:17:00.000Z', // pre-epoch (negative getTime)
] as const

// Discharge (Entlastung) dates relative to each FY end: long before, just before,
// identical, just after, a plausible ~6 months after, and years after (a late
// Entlastung is the realistic worst case — it pushes the horizon out).
const DISCHARGE_OFFSETS_DAYS = [-400, -1, 0, 1, 180, 1500] as const

function shiftDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000)
}

describe('#435 parity: computeRetentionUntil (finance leaf ↔ gremion-ui)', () => {
  const cases: Array<{
    name: string
    profile: ProfileFixture
    discharge: Date
    fyEnd: Date
  }> = []

  for (const fyIso of FY_ENDS) {
    for (const years of RETENTION_YEARS) {
      for (const from of RETENTION_FROM) {
        for (const off of DISCHARGE_OFFSETS_DAYS) {
          const fyEnd = d(fyIso)
          const discharge = shiftDays(fyEnd, off)
          cases.push({
            name: `fy=${fyIso} years=${years} from=${from} discharge=${off >= 0 ? '+' : ''}${off}d`,
            profile: {
              reserve_frei_bound: 'ceiling',
              reserve_frei_amount_cents: 0,
              reserve_betriebsmittel_amount_cents: 0,
              reserve_zweckgebunden_amount_cents: 0,
              retention_years: years,
              retention_from: from,
            },
            discharge,
            fyEnd,
          })
        }
      }
    }
  }

  it(`covers a non-trivial matrix (${cases.length} fixtures)`, () => {
    // Guards the guard: a refactor that empties the matrix must not read as green.
    expect(cases.length).toBe(
      FY_ENDS.length * RETENTION_YEARS.length * RETENTION_FROM.length * DISCHARGE_OFFSETS_DAYS.length,
    )
    expect(cases.length).toBeGreaterThan(500)
  })

  it('both implementations agree on every fixture', () => {
    const divergences: string[] = []
    for (const c of cases) {
      const leaf = leafComputeRetentionUntil(asLeafRow(c.profile), c.discharge, c.fyEnd)
      const ui = uiComputeRetentionUntil(asUiProfile(c.profile), c.discharge, c.fyEnd)
      if (leaf.getTime() !== ui.getTime()) {
        divergences.push(`${c.name}: leaf=${leaf.toISOString()} ui=${ui.toISOString()}`)
      }
    }
    expect(divergences).toEqual([])
  })

  it('the HGB 10-year floor is actually exercised (both sides, same anchor)', () => {
    // A short Finanzordnung horizon MUST be overridden by the statutory floor —
    // if this stops holding, the floor constant moved on one side.
    const profile: ProfileFixture = {
      reserve_frei_bound: 'ceiling',
      reserve_frei_amount_cents: 0,
      reserve_betriebsmittel_amount_cents: 0,
      reserve_zweckgebunden_amount_cents: 0,
      retention_years: 2,
      retention_from: 'fiscal_year_end',
    }
    const fyEnd = d('2024-12-31T00:00:00.000Z')
    const leaf = leafComputeRetentionUntil(asLeafRow(profile), fyEnd, fyEnd)
    const ui = uiComputeRetentionUntil(asUiProfile(profile), fyEnd, fyEnd)
    expect(leaf.toISOString()).toBe(ui.toISOString())
    expect(leaf.toISOString()).toBe('2034-12-31T00:00:00.000Z')
  })

  it('a longer Finanzordnung horizon wins on both sides', () => {
    const profile: ProfileFixture = {
      reserve_frei_bound: 'ceiling',
      reserve_frei_amount_cents: 0,
      reserve_betriebsmittel_amount_cents: 0,
      reserve_zweckgebunden_amount_cents: 0,
      retention_years: 15,
      retention_from: 'entlastung',
    }
    const fyEnd = d('2024-12-31T00:00:00.000Z')
    const discharge = d('2025-06-30T00:00:00.000Z')
    const leaf = leafComputeRetentionUntil(asLeafRow(profile), discharge, fyEnd)
    const ui = uiComputeRetentionUntil(asUiProfile(profile), discharge, fyEnd)
    expect(leaf.toISOString()).toBe(ui.toISOString())
    expect(leaf.toISOString()).toBe('2040-06-30T00:00:00.000Z')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Reserve parity — planReserveAdjustment
// ═══════════════════════════════════════════════════════════════════════════════

// Surplus/deficit values chosen around every cascade boundary of the bucket
// fixtures below: zero (no-op), ±1 cent, exact single-bucket exhaustion, exact
// two-bucket exhaustion, exact total exhaustion, and an over-run the cascade
// cannot cover (leaves an uncovered remainder).
const SURPLUSES = [
  0,
  1,
  -1,
  50_00,
  -50_00,
  100_00,
  -100_00,
  -300_00,
  -600_00,
  -1_000_00,
  -1_000_01,
  -9_999_999_00,
  2_147_483_647,
  -2_147_483_647,
] as const

// Bucket balances: all-zero (nothing to dissolve), a normal ladder, a negative
// balance (the Math.max(0, …) clamp), zero-in-the-middle (cascade must skip and
// continue), and everything-in-the-last-bucket.
const BUCKET_SETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [100_00, 200_00, 300_00],
  [-500_00, 200_00, 300_00],
  [100_00, 0, 300_00],
  [0, 0, 1_000_00],
  [1_000_00, 0, 0],
  [1, 1, 1],
  [Number.MAX_SAFE_INTEGER, 0, 0],
]

const BOUNDS = ['ceiling', 'floor'] as const

describe('#435 parity: planReserveAdjustment (finance leaf ↔ gremion-ui)', () => {
  const cases: Array<{ name: string; surplus: number; profile: ProfileFixture }> = []

  for (const [frei, betrieb, zweck] of BUCKET_SETS) {
    for (const bound of BOUNDS) {
      for (const surplus of SURPLUSES) {
        cases.push({
          name: `surplus=${surplus} bound=${bound} buckets=[${frei},${betrieb},${zweck}]`,
          surplus,
          profile: {
            reserve_frei_bound: bound,
            reserve_frei_amount_cents: frei,
            reserve_betriebsmittel_amount_cents: betrieb,
            reserve_zweckgebunden_amount_cents: zweck,
            retention_years: 10,
            retention_from: 'entlastung',
          },
        })
      }
    }
  }

  it(`covers a non-trivial matrix (${cases.length} fixtures)`, () => {
    expect(cases.length).toBe(BUCKET_SETS.length * BOUNDS.length * SURPLUSES.length)
    expect(cases.length).toBeGreaterThan(200)
  })

  it('both implementations agree on every fixture', () => {
    const divergences: string[] = []
    for (const c of cases) {
      // The leaf takes (surplus, row); the original takes a single object. Only the
      // CALLING CONVENTION is adapted — the inputs are the same numbers.
      const leaf = leafPlanReserveAdjustment(c.surplus, asLeafRow(c.profile))
      const ui = uiPlanReserveAdjustment({
        surplusCents: c.surplus,
        profile: asUiProfile(c.profile),
      })
      // Normalize to plain objects: the leaf returns a mutable array of mutable
      // objects, the original a readonly one — structurally identical.
      const norm = (ds: ReadonlyArray<{ type: string; delta_cents: number }>) =>
        ds.map((x) => ({ type: x.type, delta_cents: x.delta_cents }))
      const a = JSON.stringify(norm(leaf))
      const b = JSON.stringify(norm(ui))
      if (a !== b) divergences.push(`${c.name}: leaf=${a} ui=${b}`)
    }
    expect(divergences).toEqual([])
  })

  it('the surplus routing rule is actually exercised on both sides', () => {
    const base = {
      reserve_frei_amount_cents: 0,
      reserve_betriebsmittel_amount_cents: 0,
      reserve_zweckgebunden_amount_cents: 0,
      retention_years: 10,
      retention_from: 'entlastung',
    } as const
    const ceiling: ProfileFixture = { ...base, reserve_frei_bound: 'ceiling' }
    const floor: ProfileFixture = { ...base, reserve_frei_bound: 'floor' }

    expect(leafPlanReserveAdjustment(500, asLeafRow(ceiling))).toEqual([
      { type: 'frei', delta_cents: 500 },
    ])
    expect(uiPlanReserveAdjustment({ surplusCents: 500, profile: asUiProfile(ceiling) })).toEqual([
      { type: 'frei', delta_cents: 500 },
    ])
    expect(leafPlanReserveAdjustment(500, asLeafRow(floor))).toEqual([
      { type: 'betriebsmittel', delta_cents: 500 },
    ])
    expect(uiPlanReserveAdjustment({ surplusCents: 500, profile: asUiProfile(floor) })).toEqual([
      { type: 'betriebsmittel', delta_cents: 500 },
    ])
  })

  it('the deficit cascade is actually exercised on both sides', () => {
    const profile: ProfileFixture = {
      reserve_frei_bound: 'ceiling',
      reserve_frei_amount_cents: 100_00,
      reserve_betriebsmittel_amount_cents: 200_00,
      reserve_zweckgebunden_amount_cents: 300_00,
      retention_years: 10,
      retention_from: 'entlastung',
    }
    const expected = [
      { type: 'frei', delta_cents: -100_00 },
      { type: 'betriebsmittel', delta_cents: -200_00 },
      { type: 'zweckgebunden', delta_cents: -50_00 },
    ]
    expect(leafPlanReserveAdjustment(-350_00, asLeafRow(profile))).toEqual(expected)
    expect(
      uiPlanReserveAdjustment({ surplusCents: -350_00, profile: asUiProfile(profile) }),
    ).toEqual(expected)
  })

  it('a zero delta is a no-op on both sides', () => {
    const profile: ProfileFixture = {
      reserve_frei_bound: 'ceiling',
      reserve_frei_amount_cents: 100_00,
      reserve_betriebsmittel_amount_cents: 200_00,
      reserve_zweckgebunden_amount_cents: 300_00,
      retention_years: 10,
      retention_from: 'entlastung',
    }
    expect(leafPlanReserveAdjustment(0, asLeafRow(profile))).toEqual([])
    expect(uiPlanReserveAdjustment({ surplusCents: 0, profile: asUiProfile(profile) })).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Structural guard — the duplication must stay findable
// ═══════════════════════════════════════════════════════════════════════════════

describe('#435 parity: the duplicated constant is declared on both sides', () => {
  it('HGB_RETENTION_YEARS appears in both source files', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const leafSrc = readFileSync(
      fileURLToPath(new URL('../src/store/index.ts', import.meta.url)),
      'utf8',
    )
    const uiSrc = readFileSync(
      fileURLToPath(
        new URL(
          '../../../gremion-ui/src/lib/server/finance/services/yearend/retention.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    )
    // If either side stops declaring the constant (e.g. one was refactored into a
    // shared module — the #453-blocked option), this guard should be revisited
    // rather than silently kept green.
    expect(leafSrc).toMatch(/const HGB_RETENTION_YEARS = \d+/)
    expect(uiSrc).toMatch(/const HGB_RETENTION_YEARS = \d+/)
  })
})
