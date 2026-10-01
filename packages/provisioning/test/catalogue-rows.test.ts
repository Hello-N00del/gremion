// Q20 catalogue rows (TASK-043): planCatalogueRows routes every mismatch with
// the SCHEMA checks to `undecided` with a reason, BEFORE any INSERT -- a
// version module_version_semver_check would refuse included (review B1, r2:
// it aborted `init` mid-loop with a raw 23514).
import { describe, expect, it } from 'vitest'
import { planCatalogueRows, type CatalogueModule } from '../src/catalogue-rows.ts'

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
