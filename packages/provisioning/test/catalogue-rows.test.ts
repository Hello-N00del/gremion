// Q20 catalogue rows (TASK-043): planCatalogueRows routes every mismatch with
// the SCHEMA checks to `undecided` with a reason, BEFORE any INSERT -- a
// version module_version_semver_check would refuse included (review B1, r2:
// it aborted `init` mid-loop with a raw 23514).
import { describe, expect, it } from 'vitest'
import { PROVISIONAL_RETENTION_PROFILES, planCatalogueRows, provisionalNote, type CatalogueModule } from '../src/catalogue-rows.ts'

const mod = (id: string, version: string, rp: string | null = 'rp-cal-events-default'): CatalogueModule => ({
  id,
  moduleJson: { runtime: { version, export: rp ? { retentionProfile: rp } : null } },
})

describe('planCatalogueRows', () => {
  it('loads a module whose id, version and retention profile fit the SCHEMA checks', () => {
    const p = planCatalogueRows([mod('calendar', '1.2.3'), mod('vault', '0.1.0-rc.1', 'rp-pwd-vault-default')])
    expect(p.load.map((r) => `${r.moduleKey}@${r.semver}/${r.owningContext}`)).toEqual(['calendar@1.2.3/cal', 'vault@0.1.0-rc.1/pwd'])
    expect(p.undecided).toEqual([])
  })

  it.each([
    ['a leading v', 'v1.2.3'],
    ['build metadata', '1.2.3+build.5'],
    ['a leading zero', '01.2.3'],
    ['a prerelease over 40 characters', `1.0.0-${'a'.repeat(41)}`],
    ['two parts', '1.2'],
  ])('a version with %s is undecided with a reason, never an INSERT', (_what, version) => {
    const p = planCatalogueRows([mod('calendar', version)])
    expect(p.load).toEqual([])
    expect(p.undecided).toEqual([{ moduleKey: 'calendar', reason: expect.stringMatching(/semver/) }])
  })
})

// R29-I24: a module with no runtime.export takes its profile from the
// provisional table, flagged provisional; anything else stays loud.
describe('planCatalogueRows: provisional retention profiles (R29-I24)', () => {
  const table = { probe: 'rp-gov-module-data', badctx: 'rp-zzz-module-data' }

  it('a declared export profile loads as not provisional', () => {
    const p = planCatalogueRows([mod('calendar', '1.0.0')], table)
    expect(p.load).toEqual([{ moduleKey: 'calendar', semver: '1.0.0', retentionProfile: 'rp-cal-events-default', owningContext: 'cal', provisional: false }])
  })

  it('a module with no export and a table entry loads with the table id and provisional: true', () => {
    const p = planCatalogueRows([mod('probe', '1.0.0', null)], table)
    expect(p.undecided).toEqual([])
    expect(p.load).toEqual([{ moduleKey: 'probe', semver: '1.0.0', retentionProfile: 'rp-gov-module-data', owningContext: 'gov', provisional: true }])
  })

  it('a declared export always wins over a table entry', () => {
    const p = planCatalogueRows([mod('probe', '1.0.0', 'rp-cal-events-default')], table)
    expect(p.load).toEqual([{ moduleKey: 'probe', semver: '1.0.0', retentionProfile: 'rp-cal-events-default', owningContext: 'cal', provisional: false }])
  })

  it('a module with neither an export nor a table entry stays undecided with the Q20 reason', () => {
    const p = planCatalogueRows([mod('unlisted', '1.0.0', null)], table)
    expect(p.load).toEqual([])
    expect(p.undecided).toEqual([{ moduleKey: 'unlisted', reason: expect.stringMatching(/no runtime\.export\.retentionProfile.*Q20/) }])
  })

  it('the context check applies to a table id exactly as to a declared one', () => {
    const p = planCatalogueRows([mod('badctx', '1.0.0', null)], table)
    expect(p.load).toEqual([])
    expect(p.undecided).toEqual([{ moduleKey: 'badctx', reason: expect.stringMatching(/rp-zzz-module-data names no SCHEMA context code/) }])
  })

  it('the init log line names the module, the profile and the pending DPO answer', () => {
    const [row] = planCatalogueRows([mod('votes', '1.0.0', null)]).load
    expect(provisionalNote(row!)).toBe('votes loaded with provisional retention profile rp-gov-module-data (R29-I24, pending the DPO)')
  })

  it('the shipped table is frozen and holds exactly the five assignments', () => {
    expect(Object.isFrozen(PROVISIONAL_RETENTION_PROFILES)).toBe(true)
    expect(PROVISIONAL_RETENTION_PROFILES).toEqual({
      elections: 'rp-ele-module-data',
      files: 'rp-fil-module-data',
      handover: 'rp-hnd-module-data',
      messaging: 'rp-msg-module-data',
      votes: 'rp-gov-module-data',
    })
  })
})
