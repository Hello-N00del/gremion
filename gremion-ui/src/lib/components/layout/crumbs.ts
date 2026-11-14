// The top bar's section names (breadcrumbs), as a pure function of the URL.
//
// Each path segment becomes one crumb. Its name comes from, in this order:
//   1. the page's own `crumbOverrides` (a server load names an entity, e.g. the
//      committee or the minutes; `null` drops the segment),
//   2. the per-tenant term for 'committees',
//   3. CRUMB_LABELS, the German name of a route folder,
//   4. nothing: a segment that is the value of a route parameter (an id) and has
//      no name is dropped, so the bar never shows a raw id,
//   5. the segment itself, URL-decoded (a folder name under /files).
//
// route-titles.test.ts walks every routed page and fails when a route folder has
// no entry in CRUMB_LABELS.
import { termFor } from '$lib/terms'

/** German names of the route folders. Keys are URL segments. */
export const CRUMB_LABELS: Readonly<Record<string, string>> = {
  calendar: 'Kalender',
  files: 'Dokumente',
  finance: 'Finanzen',
  votes: 'Abstimmungen',
  elections: 'Wahlen',
  polls: 'Umfragen',
  members: 'Mitglieder',
  committees: 'Gremien',
  messages: 'Nachrichten',
  settings: 'Einstellungen',
  portal: 'Portal-Verwaltung',
  news: 'Neuigkeiten',
  users: 'Nutzer',
  editor: 'Editor',
  protokolle: 'Protokolle',
  beschluesse: 'Beschlüsse',
  new: 'Neu',
  edit: 'Bearbeiten',
  manage: 'Verwalten',
  preview: 'Vorschau',
  lists: 'Verteilerlisten',
  groups: 'Gruppen',
  invite: 'Einladung',
  unsubscribe: 'Abmelden',
  tasks: 'Aufgaben',
  content: 'Inhalte',
  newsletter: 'Newsletter',
  vault: 'Tresor',
  'vault-extern': 'Passwort-Tresor',
  systemstatus: 'Systemstatus',
  'module-off': 'Modul nicht aktiv',
  // Finance sub-pages
  budget: 'Haushaltsplan',
  projects: 'Projekte',
  expenses: 'Ausgaben',
  bookings: 'Buchungen',
  'bank-accounts': 'Konten',
  approvals: 'Freigaben',
  'sub-organisations': 'Suborganisationen',
  // Settings sections (canonical keys of settings/[section])
  profil: 'Profil',
  darstellung: 'Darstellung',
  organisation: 'Organisation',
  module: 'Module',
  dienste: 'Dienste & Portal',
  rechtliches: 'Rechtliches',
  datenschutz: 'Datenschutz',
  sicherungen: 'Sicherungen',
  loeschfristen: 'Löschfristen',
  gefahrenzone: 'Gefahrenzone',
  zugriffsprotokoll: 'Zugriffsprotokoll',
  print: 'Druckansicht',
  'verzeichnis-print': 'Verarbeitungsverzeichnis',
  // Settings sections (legacy sub-route names, still resolved as aliases)
  general: 'Allgemein',
  email: 'E-Mail',
  services: 'Dienste',
  legal: 'Rechtliches',
  backups: 'Sicherungen',
  retention: 'Löschfristen',
  compliance: 'Datenschutz',
  accessibility: 'Barrierefreiheit',
  danger: 'Gefahrenzone',
}

/** Per-segment names a page's server load supplies; `null` or '' drops the segment. */
export type CrumbOverrides = Readonly<Record<string, string | null>>

export interface CrumbInput {
  pathname: string
  /** The matched route (`page.route.id`), e.g. '/polls/[id]'; null on an unmatched path. */
  routeId?: string | null
  /** The route parameters of the current page (`page.params`). */
  params?: Readonly<Record<string, string | undefined>>
  overrides?: CrumbOverrides
  terms?: Record<string, string>
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** `[id]`, `[[id]]` and `[id=matcher]`, but not the rest form `[...path]`. */
const SINGLE_PARAM = /\[\[?(?!\.\.\.)([^\]=]+)(?:=[^\]]+)?\]\]?/g

/**
 * The path segments that are the value of a single-segment route parameter. A
 * rest parameter (`[...path]`) is left out on purpose: its segments are folder
 * names a person chose, not ids.
 */
function idSegments(
  routeId: string | null | undefined,
  params: Readonly<Record<string, string | undefined>>,
): Set<string> {
  const ids = new Set<string>()
  for (const match of (routeId ?? '').matchAll(SINGLE_PARAM)) {
    const value = match[1] ? params[match[1]] : undefined
    if (!value) continue
    // SvelteKit hands out decoded parameter values; the path is still encoded.
    ids.add(value)
    ids.add(encodeURIComponent(value))
  }
  return ids
}

export function crumbsFor({ pathname, routeId, params = {}, overrides = {}, terms }: CrumbInput): string[] {
  const ids = idSegments(routeId, params)
  return pathname
    .split('/')
    .filter(Boolean)
    .map((seg): string | null => {
      if (Object.hasOwn(overrides, seg)) return overrides[seg] ?? null
      if (seg === 'committees') return termFor(terms, 'gremien', CRUMB_LABELS.committees ?? seg)
      if (Object.hasOwn(CRUMB_LABELS, seg)) return CRUMB_LABELS[seg] ?? null
      if (ids.has(seg)) return null
      return decoded(seg)
    })
    .filter((label): label is string => !!label)
}
