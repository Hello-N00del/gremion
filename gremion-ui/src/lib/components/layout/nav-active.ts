/**
 * The current-page rule (TASK-208, UX-071a AC-6): exactly one nav link carries
 * aria-current="page". The LONGEST nav href that equals the path or is a
 * whole-segment prefix of it wins, so /messages/manage marks only the manage
 * entry, never /messages as well. Aliases (routes that live under another
 * entry, e.g. the merged /beschluesse under Protokolle) are consulted only when
 * no nav href matches at all.
 */
import type { NavItem } from './nav-schema'

/** Routes that have no rail entry of their own, keyed by the entry they belong to. */
export const NAV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '/protokolle': ['/beschluesse']
}

export function navHrefs(nav: NavItem[]): string[] {
  return nav.flatMap((n) => (n.kind === 'section' ? navHrefs(n.children) : [n.href]))
}

function normalise(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path
}

function under(path: string, href: string): boolean {
  if (href === '/') return path === '/'
  return path === href || path.startsWith(href + '/')
}

function longest(candidates: string[]): string | null {
  return candidates.reduce<string | null>((best, h) => (best === null || h.length > best.length ? h : best), null)
}

export function resolveActiveHref(
  hrefs: readonly string[],
  path: string,
  aliases: Readonly<Record<string, readonly string[]>> = NAV_ALIASES
): string | null {
  const p = normalise(path)
  const direct = longest(hrefs.filter((h) => under(p, h)))
  if (direct !== null) return direct
  const viaAlias = hrefs.filter((h) => (aliases[h] ?? []).some((a) => under(p, a)))
  return longest(viaAlias)
}
