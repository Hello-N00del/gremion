import { describe, test, expect } from 'vitest'
import {
  NAV_BREAKPOINT_RAIL,
  NAV_BREAKPOINT_EXPANDED,
  NAV_STORAGE_KEY
} from './nav-constants'
import { bandForWidth, effectiveNavMode, parseNavPref, createNavPrefStore, applyNavPrefClass } from './nav-state'

/** A Storage double that records every write. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const writes: [string, string][] = []
  const storage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      writes.push([k, v])
      data.set(k, v)
    },
    removeItem: (k: string) => void data.delete(k)
  }
  return { storage, writes, data }
}

const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {
    throw new Error('SecurityError')
  }
}

describe('nav-state: range defaults (nothing stored)', () => {
  test('drawer below the rail breakpoint, rail up to the expanded breakpoint, expanded from it', () => {
    expect(NAV_BREAKPOINT_RAIL).toBe(768)
    expect(NAV_BREAKPOINT_EXPANDED).toBe(1280)
    expect(effectiveNavMode(320, null)).toBe('drawer')
    expect(effectiveNavMode(767, null)).toBe('drawer')
    expect(effectiveNavMode(768, null)).toBe('rail')
    expect(effectiveNavMode(1279, null)).toBe('rail')
    expect(effectiveNavMode(1280, null)).toBe('expanded')
    expect(effectiveNavMode(2560, null)).toBe('expanded')
  })

  test('bandForWidth names the three ranges', () => {
    expect([767, 768, 1279, 1280].map(bandForWidth)).toEqual(['narrow', 'mid', 'mid', 'wide'])
  })

  test('a stored choice wins at 768 px and above, never below', () => {
    expect(effectiveNavMode(767, 'expanded')).toBe('drawer')
    expect(effectiveNavMode(767, 'rail')).toBe('drawer')
    expect(effectiveNavMode(768, 'expanded')).toBe('expanded')
    expect(effectiveNavMode(1280, 'rail')).toBe('rail')
  })
})

describe('nav-state: parsing', () => {
  test('only the two literal values parse', () => {
    expect(parseNavPref('rail')).toBe('rail')
    expect(parseNavPref('expanded')).toBe('expanded')
  })

  test.each([null, undefined, '', 'Rail', 'drawer', ' rail', '1', '{"v":"rail"}'])('invalid %j is unset', (raw) => {
    expect(parseNavPref(raw as string | null)).toBeNull()
  })
})

describe('nav-state: the per-device store', () => {
  test('reads the stored key', () => {
    const { storage } = fakeStorage({ [NAV_STORAGE_KEY]: 'rail' })
    expect(createNavPrefStore(() => storage).read()).toBe('rail')
  })

  test('an invalid stored value reads as unset', () => {
    const { storage } = fakeStorage({ [NAV_STORAGE_KEY]: 'sideways' })
    expect(createNavPrefStore(() => storage).read()).toBeNull()
  })

  test('reading never writes (no write without a toggle)', () => {
    const { storage, writes } = fakeStorage()
    const store = createNavPrefStore(() => storage)
    store.read()
    store.read()
    expect(writes).toEqual([])
  })

  test('write persists under gremion.nav', () => {
    const { storage, writes } = fakeStorage()
    const store = createNavPrefStore(() => storage)
    store.write('expanded')
    expect(writes).toEqual([['gremion.nav', 'expanded']])
    expect(store.read()).toBe('expanded')
  })

  test('a throwing storage falls back to memory for the session', () => {
    const store = createNavPrefStore(() => throwingStorage)
    expect(store.read()).toBeNull()
    expect(() => store.write('rail')).not.toThrow()
    expect(store.read()).toBe('rail')
  })

  test('an unavailable storage (null accessor or throwing accessor) falls back to memory', () => {
    const a = createNavPrefStore(() => null)
    a.write('expanded')
    expect(a.read()).toBe('expanded')
    const b = createNavPrefStore(() => {
      throw new Error('SecurityError')
    })
    expect(b.read()).toBeNull()
    b.write('rail')
    expect(b.read()).toBe('rail')
  })
})

describe('nav-state: the html class the pre-paint script also sets', () => {
  test('applyNavPrefClass sets exactly one of nav-rail / nav-expanded, or neither', () => {
    const el = document.createElement('html')
    applyNavPrefClass(el, 'rail')
    expect([...el.classList]).toEqual(['nav-rail'])
    applyNavPrefClass(el, 'expanded')
    expect([...el.classList]).toEqual(['nav-expanded'])
    applyNavPrefClass(el, null)
    expect([...el.classList]).toEqual([])
  })
})
