import { describe, test, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

// gremion#22 / B8 (design-review 2026-07 T5, ported from PR #18): client
// preference keys are namespaced `gremion.*` — the product layer is
// instance-agnostic, so `stura-*` must not be hardcoded into every visitor's
// localStorage. The legacy `stura-*` keys are still READ once as a fallback
// so existing staging users keep their prefs (the hit is migrated by writing
// the new key), but nothing ever writes a `stura-*` key again. This
// migration/read path ($lib/stores/theme.ts readPref) shipped in PR #18 with
// no direct unit coverage — this file closes that gap.
//
// The stores gate every localStorage touch on `browser`; force the browser
// path (inverse of the hooks tests' `building: true` mock).
vi.mock('$app/environment', () => ({ browser: true }))

// jsdom's localStorage is not wired in this vitest config (known quirk — see
// the notes in CommandPalette.test.ts): the global accessor yields undefined.
// Stub a spec-sufficient in-memory Storage; the store references the bare
// `localStorage` global, so this is what it hits.
function makeStorageStub(): Storage {
	const store = new Map<string, string>()
	return {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(String(k), String(v)),
		removeItem: (k: string) => void store.delete(k),
		clear: () => void store.clear(),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size
		}
	} as Storage
}
vi.stubGlobal('localStorage', makeStorageStub())

/** Fresh module instance so each test re-runs the import-time initial reads. */
async function freshTheme() {
	vi.resetModules()
	return await import('./theme')
}

beforeEach(() => {
	localStorage.clear()
	document.documentElement.className = ''
	document.documentElement.removeAttribute('style')
})

describe('theme stores — namespaced gremion.* keys with one-time stura-* fallback', () => {
	test('legacy stura-* values are honored as initial store values', async () => {
		localStorage.setItem('stura-theme', 'dark')
		localStorage.setItem('stura-colorblind', 'by')
		localStorage.setItem('stura-font-size', 'large')
		localStorage.setItem('stura-reduced-motion', 'true')
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('dark')
		expect(get(m.colorblind)).toBe('by')
		expect(get(m.fontSize)).toBe('large')
		expect(get(m.reducedMotion)).toBe(true)
	})

	test('a legacy hit is migrated: the gremion.* key is written on first read', async () => {
		localStorage.setItem('stura-theme', 'dark')
		localStorage.setItem('stura-colorblind', 'by')
		localStorage.setItem('stura-font-size', 'large')
		localStorage.setItem('stura-reduced-motion', 'true')
		await freshTheme()
		expect(localStorage.getItem('gremion.theme')).toBe('dark')
		expect(localStorage.getItem('gremion.colorblind')).toBe('by')
		expect(localStorage.getItem('gremion.font-size')).toBe('large')
		expect(localStorage.getItem('gremion.reduced-motion')).toBe('true')
	})

	test('a migrated legacy key is removed so the fallback fires at most once', async () => {
		localStorage.setItem('stura-theme', 'dark')
		await freshTheme()
		expect(localStorage.getItem('stura-theme')).toBeNull()
	})

	test('the gremion.* key wins over a stale legacy value', async () => {
		localStorage.setItem('gremion.theme', 'light')
		localStorage.setItem('stura-theme', 'dark')
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('light')
		// The stale legacy key is left untouched — it was never consulted.
		expect(localStorage.getItem('stura-theme')).toBe('dark')
	})

	test('neither key present falls back to defaults without creating keys', async () => {
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('light')
		expect(get(m.colorblind)).toBe('none')
		expect(get(m.fontSize)).toBe('normal')
		expect(get(m.reducedMotion)).toBe(false)
		expect(localStorage.getItem('gremion.theme')).toBeNull()
		expect(localStorage.getItem('stura-theme')).toBeNull()
	})

	test('setters write ONLY gremion.* keys — never stura-* (acceptance)', async () => {
		localStorage.setItem('stura-theme', 'dark')
		const m = await freshTheme()
		const spy = vi.spyOn(localStorage, 'setItem')
		m.themeMode.set('light')
		m.colorblind.set('rg')
		m.fontSize.set('xlarge')
		m.reducedMotion.set(true)
		const keys = spy.mock.calls.map(([k]) => k)
		spy.mockRestore()
		expect(keys).toContain('gremion.theme')
		expect(keys).toContain('gremion.colorblind')
		expect(keys).toContain('gremion.font-size')
		expect(keys).toContain('gremion.reduced-motion')
		expect(keys.filter((k) => k.startsWith('stura-'))).toEqual([])
		expect(localStorage.getItem('gremion.theme')).toBe('light')
	})

	test('initTheme() itself falls back to legacy keys, applies them, and migrates', async () => {
		localStorage.setItem('stura-theme', 'dark')
		localStorage.setItem('stura-colorblind', 'by')
		localStorage.setItem('stura-font-size', 'large')
		localStorage.setItem('stura-reduced-motion', 'true')
		const m = await freshTheme()
		// Drop the import-time migration so initTheme must do its own fallback.
		localStorage.removeItem('gremion.theme')
		localStorage.removeItem('gremion.colorblind')
		localStorage.removeItem('gremion.font-size')
		localStorage.removeItem('gremion.reduced-motion')
		// The import-time readPref migration already deleted the legacy keys
		// after honoring them, so re-seed them for initTheme's own fallback path.
		localStorage.setItem('stura-theme', 'dark')
		localStorage.setItem('stura-colorblind', 'by')
		localStorage.setItem('stura-font-size', 'large')
		localStorage.setItem('stura-reduced-motion', 'true')
		m.initTheme()
		const h = document.documentElement
		expect(h.classList.contains('dark')).toBe(true)
		expect(h.classList.contains('cb-by')).toBe(true)
		expect(h.classList.contains('reduce-motion')).toBe(true)
		expect(h.style.getPropertyValue('--base-font-size')).toBe('16px')
		expect(localStorage.getItem('gremion.theme')).toBe('dark')
		expect(localStorage.getItem('gremion.reduced-motion')).toBe('true')
	})
})
