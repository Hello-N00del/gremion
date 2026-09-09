/**
 * Self-contained modal a11y action (no external focus-trap dependency).
 *
 * Applied to the dialog container element while a modal dialog is open, it:
 *  - moves focus into the dialog on open (first focusable element, else the
 *    container itself) and restores focus to the previously focused element
 *    (the trigger) on close/unmount;
 *  - traps Tab / Shift+Tab within the dialog so keyboard focus cannot escape
 *    to the page behind it;
 *  - locks background scrolling: it freezes the document body and the app's
 *    main scroll container, and swallows wheel/touchmove that would otherwise
 *    bleed through to content behind the scrim.
 *
 * Multiple stacked modals are reference-counted so the scroll lock is only
 * released once the last one closes.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isVisible(el: HTMLElement): boolean {
  // Skip elements explicitly hidden via the `hidden` attribute or display/visibility.
  // (offsetParent / getClientRects aren't reliable in jsdom, so we read computed style.)
  if (el.hidden || el.closest('[hidden]')) return false
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  return true
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
}

// Reference-count the scroll lock so stacked dialogs don't clobber each other's
// restore values.
let scrollLockCount = 0
let savedBodyOverflow = ''
let savedMainOverflow = ''
let mainScroller: HTMLElement | null = null

function preventScroll(event: Event) {
  event.preventDefault()
}

function lockScroll() {
  scrollLockCount += 1
  if (scrollLockCount > 1) return

  savedBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'

  // The app's actual scroll container is <main id="main-content">; freeze it too
  // so the content behind the scrim cannot scroll.
  mainScroller = document.getElementById('main-content')
  if (mainScroller) {
    savedMainOverflow = mainScroller.style.overflow
    mainScroller.style.overflow = 'hidden'
  }

  // Belt-and-braces: stop wheel/touch from reaching elements behind the scrim
  // (e.g. when the pointer is over the scrim itself rather than the dialog).
  document.addEventListener('wheel', preventScroll, { passive: false })
  document.addEventListener('touchmove', preventScroll, { passive: false })
}

function unlockScroll() {
  scrollLockCount -= 1
  if (scrollLockCount > 0) return
  scrollLockCount = 0

  document.body.style.overflow = savedBodyOverflow
  if (mainScroller) {
    mainScroller.style.overflow = savedMainOverflow
    mainScroller = null
  }
  document.removeEventListener('wheel', preventScroll)
  document.removeEventListener('touchmove', preventScroll)
}

export interface ModalActionOptions {
  /** When false the action is inert (no focus trap / scroll lock). Default true. */
  enabled?: boolean
}

/**
 * Svelte action: use:modal on the dialog container.
 *
 * The container is only mounted while the dialog is open, so the action's
 * lifecycle (mount -> destroy) maps directly onto open -> close.
 */
export function modal(node: HTMLElement, options: ModalActionOptions = {}) {
  let enabled = options.enabled ?? true
  let active = false
  // Element that had focus before the dialog opened — restored on close.
  const previouslyFocused = document.activeElement as HTMLElement | null

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const focusable = getFocusable(node)
    if (focusable.length === 0) {
      // Nothing focusable inside — keep focus on the container itself.
      event.preventDefault()
      node.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement

    if (event.shiftKey) {
      if (current === first || current === node || !node.contains(current)) {
        event.preventDefault()
        last.focus()
      }
    } else {
      if (current === last || current === node || !node.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  function activate() {
    if (active) return
    active = true
    lockScroll()
    node.addEventListener('keydown', onKeydown)
    // Move focus into the dialog: first focusable element, else the container.
    const focusable = getFocusable(node)
    const target = focusable[0] ?? node
    // Defer to ensure the element is laid out and focusable.
    queueMicrotask(() => target.focus())
  }

  function deactivate() {
    if (!active) return
    active = false
    node.removeEventListener('keydown', onKeydown)
    unlockScroll()
    // Restore focus to the trigger if it's still in the DOM.
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus()
    }
  }

  if (enabled) activate()

  return {
    update(newOptions: ModalActionOptions = {}) {
      enabled = newOptions.enabled ?? true
      if (enabled && !active) activate()
      else if (!enabled && active) deactivate()
    },
    destroy() {
      deactivate()
    },
  }
}
