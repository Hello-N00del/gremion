/**
 * Measurement helpers for the responsive-shell browser suite (TASK-208).
 * Everything here reads real layout from Chromium; nothing is mocked.
 */
import type { NavItem } from '../nav-schema'

export const FIXTURE_NAV: NavItem[] = [
  { kind: 'section', label: 'Arbeitsbereich', children: [
    { kind: 'item', href: '/', label: 'Übersicht', icon: 'home' },
    { kind: 'item', href: '/messages', label: 'Nachrichten', icon: 'mail', badge: 'unread' },
    { kind: 'item', href: '/messages/manage', label: 'Nachrichten verwalten', icon: 'sliders' }
  ] },
  { kind: 'section', label: 'Gremien', children: [
    { kind: 'item', href: '/committees', label: 'Gremien & Referate', icon: 'users' },
    { kind: 'item', href: '/protokolle', label: 'Protokolle & Beschlüsse', icon: 'file', badge: 'count' }
  ] },
  { kind: 'section', label: 'Verwaltung', children: [
    { kind: 'item', href: '/members', label: 'Mitglieder', icon: 'badge' },
    { kind: 'item', href: '/settings', label: 'Einstellungen', icon: 'settings' }
  ] }
]

export const FIXTURE_ROUTES = ['/', '/messages', '/messages/manage', '/committees', '/protokolle', '/members', '/settings']

export function shellRoot(): HTMLElement {
  const fixture = document.querySelector<HTMLElement>('[data-shell-fixture]')
  if (!fixture) throw new Error('fixture not mounted')
  return fixture.querySelector<HTMLElement>('.app-shell') ?? (fixture.firstElementChild as HTMLElement)
}

export function mainContent(): HTMLElement {
  const m = document.getElementById('main-content')
  if (!m) throw new Error('#main-content missing')
  return m
}

/** The navigation column (the <aside> of the shell). */
export function navColumn(): HTMLElement {
  const a = shellRoot().querySelector<HTMLElement>('aside')
  if (!a) throw new Error('no navigation column')
  return a
}

export function columnWidth(): number {
  const col = navColumn()
  return getComputedStyle(col).display === 'none' ? 0 : col.getBoundingClientRect().width
}

export interface ReflowReport {
  sidebarWidth: number
  documentOverflow: number
  mainOverflow: number
  offenders: string[]
}

function describe(el: Element): string {
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`
}

/** UX-071a AC-1: the three clauses, measured separately so each can go RED alone. */
export function reflow(): ReflowReport {
  const doc = document.documentElement
  const limit = doc.clientWidth + 0.5
  const main = mainContent()
  const offenders: string[] = []
  for (const el of shellRoot().querySelectorAll('*')) {
    if (main.contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (r.right > limit) offenders.push(`${describe(el)} right=${r.right.toFixed(1)} > ${limit}`)
  }
  return {
    sidebarWidth: columnWidth(),
    documentOverflow: doc.scrollWidth - doc.clientWidth,
    mainOverflow: main.scrollWidth - main.clientWidth,
    offenders
  }
}

/** #main-content's content box: clientWidth minus horizontal padding. */
export function mainContentBox(): number {
  const m = mainContent()
  const cs = getComputedStyle(m)
  return m.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
}

export function isFocusable(el: Element): boolean {
  const h = el as HTMLElement
  if (h.matches(':disabled')) return false
  if (h.closest('[inert]')) return false
  const cs = getComputedStyle(h)
  if (cs.display === 'none' || cs.visibility === 'hidden') return false
  if (h.getClientRects().length === 0) return false
  return h.tabIndex >= 0 && h.matches('a[href], button, input, select, textarea, [tabindex], summary, [contenteditable="true"]')
}

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
