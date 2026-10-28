// @vitest-environment node
//
// TRD-196 — which modules an erasure walks, and the registry seam modules use.
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRuntimeRegistryForTests,
  getErasureHook,
  registerErasureHook,
} from '$lib/server/modules/runtime-registry'
import { enabledModuleIds } from './service'

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
