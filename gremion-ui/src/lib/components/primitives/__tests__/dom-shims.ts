// jsdom gaps Bits UI touches. jsdom has no layout engine, so these are inert
// stand-ins; none of them implements behaviour under test.
//
// getClientRects: jsdom returns an empty list for every element, and the
// `tabbable` library Bits UI's focus scope uses reads an empty list as
// "not rendered", so it would find no tabbable element and silently skip the
// Tab wrap. The shim reports one zero-size box for an attached element with no
// display:none on itself or an ancestor, i.e. what a browser's layout would
// report. The focus trap itself stays Bits UI's code: remove it (trapFocus
// false) and the Tab test goes RED (guard efficacy, TASK-082 section 7 c).
export function installDomShims(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  if (typeof proto.scrollIntoView !== 'function') proto.scrollIntoView = function scrollIntoView() {}
  const w = window as unknown as Record<string, unknown>
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  const el = window.Element.prototype as unknown as Record<string, unknown>
  if (typeof el.hasPointerCapture !== 'function') el.hasPointerCapture = () => false
  if (typeof el.releasePointerCapture !== 'function') el.releasePointerCapture = () => {}
  if (typeof el.setPointerCapture !== 'function') el.setPointerCapture = () => {}

  if (!(el as { __gpRects?: boolean }).__gpRects) {
    ;(el as { __gpRects?: boolean }).__gpRects = true
    el.getClientRects = function getClientRects(this: Element) {
      if (!this.isConnected) return [] as unknown as DOMRectList
      if (window.getComputedStyle(this).display === 'none') return [] as unknown as DOMRectList
      for (let n = this.parentElement; n; n = n.parentElement) {
        if (window.getComputedStyle(n).display === 'none') return [] as unknown as DOMRectList
      }
      return [new DOMRect(0, 0, 0, 0)] as unknown as DOMRectList
    }
  }
}
