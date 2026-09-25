/**
 * Nav icon guard helpers (TASK-208, UX-071a AC-5). The rail shows only the
 * glyph, so every nav icon must exist in Icon.svelte's map (which otherwise
 * draws a 2 px dot) and no two items may share one.
 */
import type { NavItem } from './nav-schema'

type Leaf = Extract<NavItem, { kind: 'item' }>

/** Keys of the `icons` record in Icon.svelte, read from its source. */
export function iconNamesFromSource(src: string): Set<string> {
  const start = src.indexOf('const icons')
  const end = src.indexOf('\n  }\n', start)
  if (start < 0 || end < 0) return new Set()
  const body = src.slice(start, end)
  const names = [...body.matchAll(/^\s{4}(?:'([\w-]+)'|([\w-]+)):\s*`/gm)].map((m) => m[1] ?? m[2])
  return new Set(names)
}

function leaves(nav: NavItem[]): Leaf[] {
  return nav.flatMap((n) => (n.kind === 'section' ? leaves(n.children) : [n]))
}

export function navIconNames(nav: NavItem[]): string[] {
  return leaves(nav).map((l) => l.icon)
}

/** `name (href)` for every item whose icon is not in the map. */
export function missingNavIcons(nav: NavItem[], known: Set<string>): string[] {
  return leaves(nav)
    .filter((l) => !known.has(l.icon))
    .map((l) => `${l.icon} (${l.href})`)
}

/** `name: href, href` for every glyph used by more than one item. */
export function duplicateNavIcons(nav: NavItem[]): string[] {
  const by = new Map<string, string[]>()
  for (const l of leaves(nav)) by.set(l.icon, [...(by.get(l.icon) ?? []), l.href])
  return [...by].filter(([, hrefs]) => hrefs.length > 1).map(([icon, hrefs]) => `${icon}: ${hrefs.join(', ')}`)
}
