/**
 * Responsive navigation shell — every tunable value in ONE module (TASK-208,
 * UX-071a [D-nc] defaults). Change a number here and the shell follows: the
 * breakpoints feed both the CSS media queries (navShellCss, rendered into
 * <head> by AppShell so the first paint already has them) and the matchMedia
 * logic in nav-state.ts; the sizes become the --nav-* custom properties.
 */

/** Below this width the navigation is an off-canvas drawer; from it, a column. */
export const NAV_BREAKPOINT_RAIL = 768
/** From this width the column defaults to the expanded sidebar (below: icon rail). */
export const NAV_BREAKPOINT_EXPANDED = 1280

/** Icon-rail width in CSS px, per density level. */
export const NAV_RAIL_WIDTH = { normal: 64, gross: 80 } as const
/** Expanded-sidebar width in CSS px, per density level. */
export const NAV_SIDEBAR_WIDTH = { normal: 232, gross: 290 } as const
/** Hamburger / toggle / close-button size in CSS px, per density level. */
export const NAV_CONTROL_SIZE = { normal: 44, gross: 56 } as const
/** Drawer open/close and rail/expanded motion, ms (none under reduced motion). */
export const NAV_MOTION_MS = 220

/** Upper bound of the drawer panel width, CSS px (it never covers the whole phone). */
export const NAV_DRAWER_MAX_WIDTH = 320
/** #main-content keeps at least this content-box width at every column width. */
export const NAV_MAIN_MIN_CONTENT = 390

/** localStorage key of the per-device rail/expanded choice ('rail' | 'expanded'). */
export const NAV_STORAGE_KEY = 'gremion.nav'
/** html classes the pre-paint script (app.html) and the toggle set from that key. */
export const NAV_CLASS_RAIL = 'nav-rail'
export const NAV_CLASS_EXPANDED = 'nav-expanded'

/** Media query strings, derived from the breakpoints above. */
export const MQ_COLUMN = `(min-width: ${NAV_BREAKPOINT_RAIL}px)`
export const MQ_DRAWER = `(max-width: ${NAV_BREAKPOINT_RAIL - 0.02}px)`
export const MQ_WIDE = `(min-width: ${NAV_BREAKPOINT_EXPANDED}px)`
const MQ_MID = `${MQ_COLUMN} and (max-width: ${NAV_BREAKPOINT_EXPANDED - 0.02}px)`

/**
 * The layout-critical shell CSS. Global on purpose: it is keyed on the html
 * class set before first paint, and it must apply before hydration. Cosmetic
 * rules stay scoped in the components.
 */
export function navShellCss(): string {
  const rail = `
    .nav-col { width: var(--nav-rail-w); }
    .nav-col .nav-rail-hide { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
    .nav-col .nav-rail-only { display: flex !important; }
    .nav-col .nav-expanded-only { display: none !important; }
    .nav-col .legal-list:not(.open) { display: none !important; }
    .nav-col .legal-list.open { position: fixed; z-index: 60; left: calc(var(--nav-rail-w) + 4px); bottom: 8px; flex-direction: column; align-items: stretch; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm); box-shadow: var(--sh-2); padding: 6px; }
    .nav-col .sb-item { justify-content: center; padding: 0; width: var(--nav-control); min-height: var(--nav-control); margin-inline: auto; }
    .nav-col .sb-brand { flex-direction: column; padding: 10px 0; gap: 8px; }
    .nav-col .sb-nav { padding: 0 0 8px; }
    .nav-col .sb-badge { position: absolute; top: 1px; right: 1px; padding: 0 4px; font-size: 9px; line-height: 14px; }
    .nav-col .sb-item.active::before { left: -10px; }
    .nav-col .sb-foot, .nav-col .sb-legal-wrap { padding-inline: 0; }`
  const expanded = `
    .nav-col { width: var(--nav-sidebar-w); }`
  return `
:root, html.density-compact {
  --nav-rail-w: ${NAV_RAIL_WIDTH.normal}px;
  --nav-sidebar-w: ${NAV_SIDEBAR_WIDTH.normal}px;
  --nav-control: ${NAV_CONTROL_SIZE.normal}px;
  --nav-motion: ${NAV_MOTION_MS}ms;
  --nav-drawer-max: ${NAV_DRAWER_MAX_WIDTH}px;
}
html.density-gross {
  --nav-rail-w: ${NAV_RAIL_WIDTH.gross}px;
  --nav-sidebar-w: ${NAV_SIDEBAR_WIDTH.gross}px;
  --nav-control: ${NAV_CONTROL_SIZE.gross}px;
}
.nav-rail-only { display: none !important; }
.app-shell { display: flex; width: 100%; height: 100vh; height: 100dvh; overflow: hidden; }
.app-shell-body { display: flex; flex: 1 1 0%; min-width: 0; flex-direction: column; overflow: hidden; }
html.density-gross { --nav-font: 16px; }
.app-main { flex: 1 1 0%; min-width: 0; overflow: auto; display: flex; flex-direction: column; padding: 24px; }
@media ${MQ_DRAWER} {
  .nav-col, .nav-column-only { display: none !important; }
  .app-main { padding: 16px; }
  html .topbar { padding: 0 8px; gap: 8px; }
  html .topbar .crumbs > :not(:last-child) { display: none; }
  html .topbar .search { flex: 0 0 auto; width: var(--nav-control); height: var(--nav-control); max-width: none; padding: 0; justify-content: center; }
  html .topbar .search > span { display: none; }
  html .topbar .topbar-status.inst { min-width: var(--nav-control); min-height: var(--nav-control); padding: 0; justify-content: center; border-radius: var(--r-sm); }
  html .topbar .inst-txt { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  html .topbar .topbar-bell :is(a, button) { min-width: var(--nav-control); min-height: var(--nav-control); display: inline-grid; place-items: center; }
  html .topbar .topbar-live { max-width: 96px; overflow: hidden; }
}
@media ${MQ_COLUMN} {
  .nav-drawer-only { display: none !important; }
}
@media ${MQ_MID} {
  html:not(.${NAV_CLASS_EXPANDED}) {${rail}
  }
  html.${NAV_CLASS_EXPANDED} {${expanded}
  }
}
@media ${MQ_WIDE} {
  html:not(.${NAV_CLASS_RAIL}) {${expanded}
  }
  html.${NAV_CLASS_RAIL} {${rail}
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --nav-motion: 0ms; }
}
`
}
