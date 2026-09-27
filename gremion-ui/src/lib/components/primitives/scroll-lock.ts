/**
 * Reference-counted scroll lock for the app's real scroll container,
 * `<main id="main-content">` (TASK-082, modal.ts parity).
 *
 * Bits UI's Dialog locks `<body>` itself, but the shell scrolls inside
 * `#main-content`, so the content behind the scrim would still scroll. This
 * freezes that container while at least one primitive dialog is open and
 * restores its previous inline overflow only when the LAST one closes, the
 * same contract `actions/modal.ts` gives the legacy dialog.
 */

let count = 0
let saved = ''
let locked: HTMLElement | null = null

/** Lock #main-content; returns the matching release (idempotent). */
export function lockMainContent(): () => void {
  count += 1
  if (count === 1) {
    locked = typeof document === 'undefined' ? null : document.getElementById('main-content')
    if (locked) {
      saved = locked.style.overflow
      locked.style.overflow = 'hidden'
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    count -= 1
    if (count > 0) return
    count = 0
    if (locked) {
      locked.style.overflow = saved
      locked = null
    }
  }
}

/** Test seam: how many primitive dialogs currently hold the lock. */
export function mainContentLockCount(): number {
  return count
}
