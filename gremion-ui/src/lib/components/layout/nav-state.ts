/**
 * Navigation shell state (TASK-208): which form the navigation takes at a given
 * viewport width, and the per-device rail/expanded choice.
 *
 * The choice is written ONLY when the user activates the sidebar toggle — never
 * on load, never as a side effect of a resize — so a device with nothing stored
 * keeps following the range defaults. Storage that throws (private mode,
 * blocked site data, quota) degrades to an in-memory value for the session.
 */
import {
  NAV_BREAKPOINT_EXPANDED,
  NAV_BREAKPOINT_RAIL,
  NAV_CLASS_EXPANDED,
  NAV_CLASS_RAIL,
  NAV_STORAGE_KEY
} from './nav-constants'

export type NavPref = 'rail' | 'expanded'
export type NavMode = 'drawer' | NavPref
export type NavBand = 'narrow' | 'mid' | 'wide'

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>

export function bandForWidth(width: number): NavBand {
  if (width < NAV_BREAKPOINT_RAIL) return 'narrow'
  if (width < NAV_BREAKPOINT_EXPANDED) return 'mid'
  return 'wide'
}

/** The stored value, or null when absent or anything but the two literals. */
export function parseNavPref(raw: string | null | undefined): NavPref | null {
  return raw === 'rail' || raw === 'expanded' ? raw : null
}

/** Drawer below the rail breakpoint whatever is stored; else the choice, else the range default. */
export function effectiveNavMode(width: number, pref: NavPref | null): NavMode {
  const band = bandForWidth(width)
  if (band === 'narrow') return 'drawer'
  return pref ?? (band === 'mid' ? 'rail' : 'expanded')
}

export function createNavPrefStore(getStorage: () => PrefStorage | null) {
  let memory: NavPref | null = null
  let useMemory = false

  function storage(): PrefStorage | null {
    try {
      return getStorage()
    } catch {
      return null
    }
  }

  return {
    read(): NavPref | null {
      if (useMemory) return memory
      const s = storage()
      if (!s) return memory
      try {
        return parseNavPref(s.getItem(NAV_STORAGE_KEY))
      } catch {
        useMemory = true
        return memory
      }
    },
    /** Only the toggle calls this. */
    write(pref: NavPref): void {
      memory = pref
      const s = storage()
      if (!s) {
        useMemory = true
        return
      }
      try {
        s.setItem(NAV_STORAGE_KEY, pref)
      } catch {
        useMemory = true
      }
    }
  }
}

/** Mirror of the pre-paint line in app.html: at most one of the two classes. */
export function applyNavPrefClass(root: Element, pref: NavPref | null): void {
  root.classList.toggle(NAV_CLASS_RAIL, pref === 'rail')
  root.classList.toggle(NAV_CLASS_EXPANDED, pref === 'expanded')
}
