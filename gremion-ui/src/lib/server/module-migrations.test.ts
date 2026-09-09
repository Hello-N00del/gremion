import { describe, it, expect } from 'vitest'
import { disabledModuleMigrationFiles, moduleReenableCatchup } from './module-migrations'
import type { ModuleManifest } from '$lib/modules/types'

const finance: ModuleManifest = {
  id: 'finance', toggleable: true, pages: [], routePrefixes: [],
  migrations: ['013_finance_schema', '028_approval_unified'],
}
const core: ModuleManifest = { id: 'core', toggleable: false, pages: [], routePrefixes: [], migrations: [] }
const cfg = (finance: boolean) => ({ modules: { finance, elections: true } }) as any

describe('disabledModuleMigrationFiles', () => {
  it('returns the .sql files of disabled toggleable modules', () => {
    expect(disabledModuleMigrationFiles(cfg(false), [core, finance]))
      .toEqual(new Set(['013_finance_schema.sql', '028_approval_unified.sql']))
  })
  it('returns empty when the module is enabled', () => {
    expect(disabledModuleMigrationFiles(cfg(true), [core, finance])).toEqual(new Set())
  })
  it('never skips a non-toggleable (core) module even if config says false', () => {
    const c = { modules: { finance: true, core: false } } as any
    expect(disabledModuleMigrationFiles(c, [core, finance])).toEqual(new Set())
  })
  it('contributes nothing for a disabled module with no migrations key (the ?? [] prod path)', () => {
    const noMigs: ModuleManifest = { id: 'newsletter', toggleable: true, pages: [], routePrefixes: [] }
    const c = { modules: { newsletter: false } } as any
    expect(disabledModuleMigrationFiles(c, [noMigs])).toEqual(new Set())
  })
  it('unions the files of multiple disabled toggleable modules', () => {
    const elections: ModuleManifest = {
      id: 'elections', toggleable: true, pages: [], routePrefixes: [],
      migrations: ['004_committee_elections'],
    }
    const c = { modules: { finance: false, elections: false } } as any
    expect(disabledModuleMigrationFiles(c, [core, finance, elections]))
      .toEqual(new Set(['013_finance_schema.sql', '028_approval_unified.sql', '004_committee_elections.sql']))
  })
})

describe('moduleReenableCatchup', () => {
  it('plans the catch-up files of a true OFF→ON re-enable (module ON, non-fresh DB, NONE of its migrations applied), in filename order', () => {
    expect(
      moduleReenableCatchup({ isFreshDb: false, applied: new Set(['001_governance_schema.sql']), config: cfg(true), manifests: [finance] }),
    ).toEqual([{ moduleId: 'finance', files: ['013_finance_schema.sql', '028_approval_unified.sql'] }])
  })
  it('returns [] on a forward migration (module ON, base applied, a NEW migration appended, non-fresh DB) — normal forward apply, NOT catch-up', () => {
    const financeWithNew: ModuleManifest = {
      ...finance,
      migrations: ['013_finance_schema', '028_approval_unified', '037_finance_new'],
    }
    expect(
      moduleReenableCatchup({
        isFreshDb: false,
        applied: new Set(['013_finance_schema.sql', '028_approval_unified.sql']), // base applied (appliedOfModule.length>0); 037 not yet
        config: cfg(true),
        manifests: [financeWithNew],
      }),
    ).toEqual([])
  })
  it('returns [] on a fresh DB (normal finance-ON init — the forward apply loop handles it, not catch-up)', () => {
    expect(
      moduleReenableCatchup({ isFreshDb: true, applied: new Set(), config: cfg(true), manifests: [finance] }),
    ).toEqual([])
  })
  it('returns [] when the module is disabled (cfg false)', () => {
    expect(
      moduleReenableCatchup({ isFreshDb: false, applied: new Set(), config: cfg(false), manifests: [finance] }),
    ).toEqual([])
  })
  it('returns [] when all the enabled module migrations are already applied', () => {
    expect(
      moduleReenableCatchup({ isFreshDb: false, applied: new Set(['013_finance_schema.sql', '028_approval_unified.sql']), config: cfg(true), manifests: [finance] }),
    ).toEqual([])
  })
  it('ON→OFF retain: a now-disabled previously-initialized module returns [] — retain is the policy (no drop, no schema_migrations removal)', () => {
    // The module ran ON (its finance files ARE in this non-fresh DB) and is now
    // turned OFF (cfg false). moduleReenableCatchup plans NOTHING: it neither
    // drops the module's schema nor removes its schema_migrations rows. The
    // data-at-rest policy for ON→OFF is RETAIN — the rows stay so a later
    // OFF→ON is a no-op (already-applied), and disabledModuleMigrationFiles
    // merely skips forward application. No re-enable catch-up is owed here.
    expect(
      moduleReenableCatchup({
        isFreshDb: false,
        applied: new Set(['013_finance_schema.sql', '028_approval_unified.sql']),
        config: cfg(false),
        manifests: [finance],
      }),
    ).toEqual([])
  })
})
