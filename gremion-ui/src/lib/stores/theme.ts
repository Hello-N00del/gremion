import { browser } from '$app/environment'
import { writable } from 'svelte/store'
import { fontSizePx } from './font-size'

export { fontSizePx } from './font-size'

// B8 (design-review 2026-07 T5): preference keys are namespaced `gremion.*` —
// the product layer is instance-agnostic, so `stura-*` must not be hardcoded
// into every visitor's localStorage. The legacy `stura-*` keys are read ONCE
// as a fallback (value honored + migrated to the new key by readPref) so
// existing staging users keep their prefs; writes go ONLY to the new keys.
const THEME_KEY = 'gremion.theme'
const COLORBLIND_KEY = 'gremion.colorblind'
const FONT_SIZE_KEY = 'gremion.font-size'
const REDUCED_MOTION_KEY = 'gremion.reduced-motion'

const LEGACY_KEYS: Record<string, string> = {
	[THEME_KEY]: 'stura-theme',
	[COLORBLIND_KEY]: 'stura-colorblind',
	[FONT_SIZE_KEY]: 'stura-font-size',
	[REDUCED_MOTION_KEY]: 'stura-reduced-motion'
}

export type ColorblindType = 'none' | 'rg' | 'by'

/**
 * Read a preference from its namespaced key, falling back to the legacy
 * `stura-*` key. A legacy hit is migrated by writing the namespaced key, so
 * the fallback fires at most once per preference.
 */
function readPref(key: string): string | null {
	const raw = localStorage.getItem(key)
	if (raw !== null) return raw
	const legacy = localStorage.getItem(LEGACY_KEYS[key])
	if (legacy !== null) {
		localStorage.setItem(key, legacy)
		localStorage.removeItem(LEGACY_KEYS[key])
	}
	return legacy
}

function getInitial<T>(key: string, fallback: T, parse: (v: string) => T): T {
	if (!browser) return fallback
	const raw = readPref(key)
	return raw !== null ? parse(raw) : fallback
}

function applyToHtml(mode: 'light' | 'dark', cb: ColorblindType) {
	if (!browser) return
	const h = document.documentElement
	h.classList.toggle('dark', mode === 'dark')
	h.classList.toggle('cb-rg', cb === 'rg')
	h.classList.toggle('cb-by', cb === 'by')
}

const modeStore = writable<'light' | 'dark'>(
	getInitial(THEME_KEY, 'light', (v) => v as 'light' | 'dark')
)

const colorblindStore = writable<ColorblindType>(
	getInitial(COLORBLIND_KEY, 'none', (v) => v as ColorblindType)
)

export const themeMode = {
	subscribe: modeStore.subscribe,
	set(mode: 'light' | 'dark') {
		modeStore.set(mode)
		if (browser) {
			localStorage.setItem(THEME_KEY, mode)
			colorblindStore.subscribe((cb) => applyToHtml(mode, cb))()
		}
	}
}

export const colorblind = {
	subscribe: colorblindStore.subscribe,
	set(type: ColorblindType) {
		colorblindStore.set(type)
		if (browser) {
			localStorage.setItem(COLORBLIND_KEY, type)
			modeStore.subscribe((m) => applyToHtml(m, type))()
		}
	}
}

const fontSizeStore = writable<string>(
	getInitial(FONT_SIZE_KEY, 'normal', (v) => v)
)

export const fontSize = {
	subscribe: fontSizeStore.subscribe,
	set(key: string) {
		fontSizeStore.set(key)
		if (browser) {
			localStorage.setItem(FONT_SIZE_KEY, key)
			document.documentElement.style.setProperty('--base-font-size', fontSizePx(key))
		}
	}
}

const reducedMotionStore = writable<boolean>(
	getInitial(REDUCED_MOTION_KEY, false, (v) => v === 'true')
)

export const reducedMotion = {
	subscribe: reducedMotionStore.subscribe,
	set(val: boolean) {
		reducedMotionStore.set(val)
		if (browser) {
			localStorage.setItem(REDUCED_MOTION_KEY, String(val))
			document.documentElement.classList.toggle('reduce-motion', val)
		}
	}
}

/**
 * Apply every persisted client appearance/accessibility preference to the
 * document root. Called once from the root +layout on app load/hydration so the
 * choices take effect app-wide (mirrors how the theme toggle applies on change),
 * not only on the pages whose components happen to import this store.
 */
export function initTheme() {
	if (!browser) return
	const h = document.documentElement
	const mode = (readPref(THEME_KEY) as 'light' | 'dark' | null) ?? 'light'
	const cb = (readPref(COLORBLIND_KEY) as ColorblindType | null) ?? 'none'
	applyToHtml(mode, cb)
	h.style.setProperty('--base-font-size', fontSizePx(readPref(FONT_SIZE_KEY) ?? 'normal'))
	h.classList.toggle('reduce-motion', readPref(REDUCED_MOTION_KEY) === 'true')
}
