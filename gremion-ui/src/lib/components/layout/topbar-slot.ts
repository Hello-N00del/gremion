/**
 * The TopBar's module slot contract (TASK-208). A feature module (messages,
 * video) does not edit TopBar.svelte; it hands AppShell a TopbarModuleSlot and
 * the TopBar renders each part in a fixed place with fixed below-768 rules:
 *
 *  - chips     status chips (e.g. MATRIX · VERBUNDEN). Low priority: hidden
 *              below the rail breakpoint, where the width goes to the page.
 *  - liveCall  the live-call indicator. Kept below the breakpoint; the slot
 *              wrapper caps its width so a long label cannot push the bar wide.
 *  - bell      the notification bell (an icon link or button with its own
 *              accessible name). Kept; below the breakpoint the wrapper makes
 *              its target at least the shell control size (44 CSS px).
 */
import type { Snippet } from 'svelte'

export interface TopbarModuleSlot {
  chips?: Snippet
  liveCall?: Snippet
  bell?: Snippet
}

/** What each part does below the rail breakpoint (asserted by the browser suite). */
export const TOPBAR_SLOT_BELOW_RAIL = {
  chips: 'hidden',
  liveCall: 'kept',
  bell: 'kept'
} as const
