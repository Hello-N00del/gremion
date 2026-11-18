/**
 * The rail's section and item labels in the person's locale (locale-en unit).
 *
 * The labels are German literals shipped as data: the kernel template in
 * nav-schema.ts and the nav fragments of the module manifests. They stay
 * literals on purpose: nav-schema.test.ts pins them as a golden tree and
 * retermNav() swaps them for a tenant's own wording before the tree leaves the
 * server. They are therefore translated where they are shown, by looking the
 * German label up in the catalogue:
 *
 *   - German locale: the label as it is (the catalogue's German text equals the
 *     literal, nav-localize.test.ts proves it);
 *   - any other locale: the catalogue message, when the label has one;
 *   - a label with no entry (a tenant's re-termed wording, a module that adds a
 *     rail entry without a message) stays as written, never a raw key.
 *
 * Client-safe and free of `$lib/i18n`: callers pass their translate function,
 * as nav-labels.ts does.
 */
import type { NavItem } from './nav-schema'

/** German source label -> catalogue key. nav-localize.test.ts fails for a label of the rail that is missing here. */
export const NAV_LABEL_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  // sections
  Arbeitsbereich: 'nav.section.workspace',
  Gremien: 'nav.section.committees',
  Öffentlichkeit: 'nav.section.public',
  Verwaltung: 'nav.section.administration',
  // items
  Übersicht: 'nav.item.overview',
  Kalender: 'nav.item.calendar',
  Aufgaben: 'nav.item.tasks',
  Dokumente: 'nav.item.documents',
  'Matrix · Chat': 'nav.item.chat',
  'Gremien & Referate': 'nav.item.committees',
  'Protokolle & Beschlüsse': 'nav.item.minutes',
  'Abstimmungen & Wahlen': 'nav.item.votesElections',
  Abstimmungen: 'nav.item.votes',
  'Portal-Verwaltung': 'nav.item.portal',
  Inhalte: 'nav.item.content',
  Mitglieder: 'nav.item.members',
  Räume: 'nav.item.rooms',
  Newsletter: 'nav.item.newsletter',
  Tresor: 'nav.item.vault',
  Einstellungen: 'nav.item.settings',
  Systemstatus: 'nav.item.systemStatus'
}

/** The language the rail's label literals are written in. */
export const NAV_SOURCE_LANG = 'de'

/** The catalogue message for `label` in `tr`'s language, or null: no entry, or a catalogue without the message. */
function catalogueText(label: string, tr: (key: string) => string): string | null {
  const key = Object.hasOwn(NAV_LABEL_MESSAGE_KEYS, label) ? NAV_LABEL_MESSAGE_KEYS[label] : undefined
  if (!key) return null
  const text = tr(key)
  // translate() answers with the key itself for a message the catalogue lacks.
  return text === key ? null : text
}

/** One label in `locale`: German stays, otherwise the catalogue message when there is one. */
export function localizeNavLabel(label: string, locale: string, tr: (key: string) => string): string {
  if (locale === NAV_SOURCE_LANG) return label
  return catalogueText(label, tr) ?? label
}

/**
 * The nav tree with every label in `locale`. Same shape; a new tree only where something changed.
 *
 * A label the translation does not reach (a tenant's re-termed wording, a module entry without a
 * message) stays German, so it is marked `lang: 'de'` and sits inside the localized column as such
 * (WCAG 3.1.2) instead of passing for English.
 */
export function localizeNav(nav: NavItem[], locale: string, tr: (key: string) => string): NavItem[] {
  if (locale === NAV_SOURCE_LANG) return nav
  return nav.map((item) => {
    const text = catalogueText(item.label, tr)
    const label = text ?? item.label
    const lang = text === null ? NAV_SOURCE_LANG : undefined
    if (item.kind === 'section') return { ...item, label, lang, children: localizeNav(item.children, locale, tr) }
    return { ...item, label, lang }
  })
}
