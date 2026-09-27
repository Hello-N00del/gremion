/**
 * The column's strings (TASK-208). Sidebar, NavToggle and LegalMenu take them
 * as a prop instead of importing $lib/i18n: that module reads localStorage at
 * import time, which jsdom suites (e.g. source-offer.test.ts) cannot provide.
 * AppShell passes navLabels($t); the default is the German dictionary.
 */
import de from '$lib/i18n/de'

export const NAV_LABEL_KEYS = ['nav.main', 'nav.sidebar', 'nav.sidebar.saved', 'nav.legal'] as const
export type NavLabels = Record<(typeof NAV_LABEL_KEYS)[number], string>

export function navLabels(t: (key: string) => string): NavLabels {
  return Object.fromEntries(NAV_LABEL_KEYS.map((k) => [k, t(k)])) as NavLabels
}

export const DEFAULT_NAV_LABELS: NavLabels = navLabels((k) => de[k] ?? k)
