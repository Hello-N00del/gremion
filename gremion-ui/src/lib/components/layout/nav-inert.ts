/**
 * Makes everything outside an open modal drawer inert (TASK-208, UX-071a AC-2):
 * walking up from `keep` to <body>, every sibling at every level gets `inert`,
 * the skip link included. The app's status region (marked data-shell-status)
 * is left live so a status message is still announced while the drawer is
 * open: a sibling that IS it is skipped, a sibling that CONTAINS it is
 * descended into instead. Page-level live regions are inerted like the rest
 * (they may hold focusable content).
 *
 * Returns the release function. Callers release BEFORE focus returns to the
 * trigger — focus() on an element under an inert ancestor silently fails.
 */
const LIVE = '[data-shell-status]'

export function inertOutside(keep: Element): () => void {
  const touched: HTMLElement[] = []

  function inertSubtree(el: Element) {
    if (!(el instanceof HTMLElement)) return
    if (el.matches(LIVE)) return
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return
    if (el.querySelector(LIVE)) {
      for (const child of el.children) inertSubtree(child)
      return
    }
    if (el.inert) return
    el.inert = true
    touched.push(el)
  }

  let node: Element = keep
  while (node.parentElement && node.parentElement !== document.documentElement) {
    for (const sib of node.parentElement.children) if (sib !== node) inertSubtree(sib)
    node = node.parentElement
  }

  return () => {
    for (const el of touched) el.inert = false
    touched.length = 0
  }
}
