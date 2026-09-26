/**
 * The drawer's dialog behaviour as one Svelte action (TASK-208, UX-071a AC-2):
 * actions/modal.ts supplies focus-in, the Tab/Shift+Tab wrap and the scroll
 * lock; this adds inert on everything outside the drawer (nav-inert.ts).
 *
 * Teardown order matters: inert is released FIRST, then modal deactivates, so
 * that when the shell returns focus to the hamburger nothing around it is
 * still inert. The shell blurs the hamburger before opening, so modal's own
 * restore target is <body> and the shell alone decides where focus goes
 * (hamburger on Escape/scrim/close, nowhere on a route change, the rail when
 * a rotation or resize closes the drawer).
 */
import { modal } from '$lib/actions/modal'
import { inertOutside } from './nav-inert'

export function navDrawer(node: HTMLElement) {
  const release = inertOutside(node.parentElement ?? node)
  const trap = modal(node)
  return {
    destroy() {
      release()
      trap.destroy()
    }
  }
}
