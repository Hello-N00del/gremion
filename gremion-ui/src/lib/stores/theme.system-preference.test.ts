import { describe, test, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

// Finding 18b: the theme follows prefers-color-scheme until the person picks
// one explicitly. An explicit stored choice always wins.
vi.mock('$app/environment', () => ({ browser: true }))

function makeStorageStub(): Storage {
	const store = new Map<string, string>()
	return {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => void store.set(String(k), String(v)),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size
		}
	} as Storage
}
vi.stubGlobal('localStorage', makeStorageStub())

type Listener = (e: { matches: boolean }) => void
let listeners: Listener[] = []

function mockSystem(dark: boolean | 'absent') {
	listeners = []
	if (dark === 'absent') {
		vi.stubGlobal('matchMedia', undefined)
		return
	}
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: query.includes('prefers-color-scheme: dark') && dark,
		addEventListener: (_: string, l: Listener) => void listeners.push(l),
		removeEventListener: (_: string, l: Listener) => void (listeners = listeners.filter((x) => x !== l))
	}))
}

async function freshTheme() {
	vi.resetModules()
	return await import('./theme')
}

beforeEach(() => {
	localStorage.clear()
	document.documentElement.className = ''
	document.documentElement.removeAttribute('style')
})

describe('theme defaults to the system preference', () => {
	test('no stored choice and a dark system: the store starts dark', async () => {
		mockSystem(true)
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('dark')
	})

	test('no stored choice and a light system: the store starts light', async () => {
		mockSystem(false)
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('light')
	})

	test('no matchMedia at all: light', async () => {
		mockSystem('absent')
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('light')
	})

	test('a stored explicit light wins over a dark system (store and html root)', async () => {
		mockSystem(true)
		localStorage.setItem('gremion.theme', 'light')
		const m = await freshTheme()
		expect(get(m.themeMode)).toBe('light')
		m.initTheme()
		expect(document.documentElement.classList.contains('dark')).toBe(false)
	})

	test('a stored explicit dark applies on a light system', async () => {
		mockSystem(false)
		localStorage.setItem('gremion.theme', 'dark')
		const m = await freshTheme()
		m.initTheme()
		expect(get(m.themeMode)).toBe('dark')
		expect(document.documentElement.classList.contains('dark')).toBe(true)
	})

	test('initTheme applies the system preference to the html root without storing it', async () => {
		mockSystem(true)
		const m = await freshTheme()
		m.initTheme()
		expect(document.documentElement.classList.contains('dark')).toBe(true)
		expect(localStorage.getItem('gremion.theme')).toBeNull()
	})
})

describe('following the system live', () => {
	test('while no choice is stored a system change re-themes the page', async () => {
		mockSystem(false)
		const m = await freshTheme()
		m.initTheme()
		expect(document.documentElement.classList.contains('dark')).toBe(false)
		listeners.forEach((l) => l({ matches: true }))
		expect(document.documentElement.classList.contains('dark')).toBe(true)
		expect(get(m.themeMode)).toBe('dark')
		expect(localStorage.getItem('gremion.theme')).toBeNull()
	})

	test('once the person picks a theme, a system change no longer overrides it', async () => {
		mockSystem(false)
		const m = await freshTheme()
		m.initTheme()
		m.themeMode.set('light')
		listeners.forEach((l) => l({ matches: true }))
		expect(document.documentElement.classList.contains('dark')).toBe(false)
		expect(get(m.themeMode)).toBe('light')
		expect(localStorage.getItem('gremion.theme')).toBe('light')
	})

	test('a stored choice at init registers no system listener', async () => {
		mockSystem(true)
		localStorage.setItem('gremion.theme', 'light')
		const m = await freshTheme()
		m.initTheme()
		expect(listeners).toHaveLength(0)
	})
})
