// @vitest-environment node
//
// TRD-196 — which modules an erasure walks, and the registry seam modules use.
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRuntimeRegistryForTests,
  getErasureHook,
  registerErasureHook,
} from '$lib/server/modules/runtime-registry'
import { CROSS_CUTTING_MIGRATIONS } from '$lib/modules/migration-ownership'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { CROSS_CUTTING_MIGRATION_OWNER, enabledModuleIds, erasureModuleIds } from './service'

afterEach(() => _resetRuntimeRegistryForTests())

describe('enabledModuleIds', () => {
  it('always starts with the kernel step and the identity step, then the modules the tenant turned on', () => {
    expect(enabledModuleIds({ calendar: true, board: false, files: true })).toEqual(['kernel', 'identity', 'calendar', 'files'])
  })

  it('does not drop a config-enabled id no manifest knows (it must surface as "no erasure hook")', () => {
    expect(enabledModuleIds({ somenewmodule: true })).toEqual(['kernel', 'identity', 'somenewmodule'])
  })

  it('an all-off tenant still runs the kernel and identity steps', () => {
    expect(enabledModuleIds({})).toEqual(['kernel', 'identity'])
  })
})

describe('erasureModuleIds: enabled OR holding data (migrations applied)', () => {
  it('adds a DISABLED module whose own migrations are applied (its data is still there)', () => {
    const applied = new Set(['0001_governance_schema.sql', 'x_newsletter_1.sql'])
    const manifests = [
      { id: 'core', toggleable: false },
      { id: 'newsletter', toggleable: true, migrations: ['x_newsletter_1'] },
      { id: 'votes', toggleable: true, migrations: ['x_votes_1'] },
    ]
    expect(erasureModuleIds({ newsletter: false, votes: false }, applied, manifests)).toEqual(['kernel', 'identity', 'newsletter'])
  })

  it('adds a disabled module that owns a kernel-applied (cross-cutting) migration once it is applied', () => {
    const applied = new Set(['0003_calendar_schema.sql', '0034_deck_board.sql'])
    const manifests = [
      { id: 'calendar', toggleable: true },
      { id: 'board', toggleable: true },
      { id: 'elections', toggleable: true },
    ]
    expect(erasureModuleIds({ calendar: false, board: false, elections: false }, applied, manifests)).toEqual([
      'kernel', 'identity', 'calendar', 'board',
    ])
  })

  it('keeps enabled modules first and never lists one twice', () => {
    const applied = new Set(['0003_calendar_schema.sql'])
    expect(erasureModuleIds({ calendar: true, files: true }, applied, [{ id: 'calendar', toggleable: true }])).toEqual([
      'kernel', 'identity', 'calendar', 'files',
    ])
  })

  it('the cross-cutting owner map covers exactly the kernel-applied module migrations', () => {
    expect(Object.keys(CROSS_CUTTING_MIGRATION_OWNER).sort()).toEqual(Object.keys(CROSS_CUTTING_MIGRATIONS).sort())
    const ids = new Set(MODULE_MANIFESTS.map((m) => m.id))
    for (const owner of Object.values(CROSS_CUTTING_MIGRATION_OWNER)) expect(ids.has(owner)).toBe(true)
  })
})

describe('erasure hook registry (runtime-registry section 10)', () => {
  it('returns undefined for a module without a hook', () => {
    expect(getErasureHook('calendar')).toBeUndefined()
  })

  it('a repeat registration under one module id replaces the prior hook', () => {
    const a = { moduleId: 'calendar', erase: async () => ({ status: 'erased' as const, counts: {} }) }
    const b = { moduleId: 'calendar', erase: async () => ({ status: 'erased' as const, counts: { n: 1 } }) }
    registerErasureHook(a)
    registerErasureHook(b)
    expect(getErasureHook('calendar')).toBe(b)
  })
})
