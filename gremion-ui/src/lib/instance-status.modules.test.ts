// src/lib/instance-status.modules.test.ts
// Guard: the Systemstatus module catalog is DERIVED, never hand-listed.
//
// The hand-written catalog outlived the modules it named — it advertised
// finance, elections, a calendar, documents, chat and tasks as this instance's
// modules long after the carve removed every one of them. The page whose job is
// to report what runs was the app's least accurate page. These assertions fail
// the moment a name appears in the catalog that no manifest registers.
import { describe, it, expect } from 'vitest'
import { PLUGGABLE_MODULES, CORE_MODULES, CORE_MODULE_LABELS } from './instance-status'
import { MODULE_MANIFESTS } from './modules/registry'

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort()

describe('Systemstatus module catalog', () => {
  it('scans a non-empty manifest set (a vacuous catalog would pass everything)', () => {
    expect(MODULE_MANIFESTS.length).toBeGreaterThan(0)
  })

  it('lists exactly the registered toggleable modules as pluggable', () => {
    expect(ids(PLUGGABLE_MODULES)).toEqual(ids(MODULE_MANIFESTS.filter((m) => m.toggleable)))
  })

  it('lists exactly the registered always-on modules as core', () => {
    expect(ids(CORE_MODULES)).toEqual(ids(MODULE_MANIFESTS.filter((m) => !m.toggleable)))
  })

  it('shows every registered module in one list or the other, and in only one', () => {
    const shown = [...PLUGGABLE_MODULES, ...CORE_MODULES]
    expect(ids(shown)).toEqual(MODULE_MANIFESTS.map((m) => m.id).sort())
    expect(new Set(shown.map((m) => m.id)).size).toBe(shown.length)
  })

  it('names no module the kernel does not register', () => {
    const registered = new Set(MODULE_MANIFESTS.map((m) => m.id))
    const strays = [...PLUGGABLE_MODULES, ...CORE_MODULES].filter((m) => !registered.has(m.id))
    expect(
      strays.map((m) => `${m.id} (${m.label})`),
      'The Systemstatus catalog names a module no manifest registers. Register the ' +
        'module or remove the entry — do not hand-list it here.',
    ).toEqual([])
  })

  it('labels every registered module (falling back to its id, never to an invented name)', () => {
    for (const m of [...PLUGGABLE_MODULES, ...CORE_MODULES]) {
      const manifest = MODULE_MANIFESTS.find((x) => x.id === m.id)!
      expect(m.label).toBe(manifest.status?.label ?? manifest.id)
    }
  })

  it('keeps CORE_MODULE_LABELS in step with CORE_MODULES', () => {
    expect([...CORE_MODULE_LABELS]).toEqual(CORE_MODULES.map((m) => m.label))
  })
})
