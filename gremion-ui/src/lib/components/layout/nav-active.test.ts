import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import type { NavItem } from './nav-schema'
import { resolveActiveHref, navHrefs } from './nav-active'

// Fixture navigation: /messages and /messages/manage both exist (a module's
// member view and its admin view), which the old prefix rule marked together.
const nav: NavItem[] = [
  { kind: 'section', label: 'Arbeitsbereich', children: [
    { kind: 'item', href: '/', label: 'Übersicht', icon: 'home' },
    { kind: 'item', href: '/messages', label: 'Nachrichten', icon: 'mail' },
    { kind: 'item', href: '/messages/manage', label: 'Nachrichten verwalten', icon: 'sliders' },
  ] },
  { kind: 'section', label: 'Gremien', children: [
    { kind: 'item', href: '/protokolle', label: 'Protokolle & Beschlüsse', icon: 'file' },
  ] },
]
const hrefs = navHrefs(nav)

describe('resolveActiveHref: longest match', () => {
  test.each([
    ['/', '/'],
    ['/messages', '/messages'],
    ['/messages/42', '/messages'],
    ['/messages/manage', '/messages/manage'],
    ['/messages/manage/rooms/7', '/messages/manage'],
    ['/protokolle/2026-09', '/protokolle'],
  ])('%s -> %s', (path, want) => {
    expect(resolveActiveHref(hrefs, path)).toBe(want)
  })

  test('a segment prefix is not a match (/messagesx is not under /messages)', () => {
    expect(resolveActiveHref(hrefs, '/messagesx')).toBeNull()
  })

  test('/ matches only itself', () => {
    expect(resolveActiveHref(hrefs, '/unknown')).toBeNull()
  })

  test('a trailing slash is the same route', () => {
    expect(resolveActiveHref(hrefs, '/messages/manage/')).toBe('/messages/manage')
  })
})

describe('resolveActiveHref: aliases only when nothing matches', () => {
  const aliases = { '/protokolle': ['/beschluesse'], '/messages': ['/messages/manage'] }

  test('the merged Beschlüsse route marks the Protokolle entry', () => {
    expect(resolveActiveHref(hrefs, '/beschluesse/12', aliases)).toBe('/protokolle')
  })

  test('a real match wins over an alias', () => {
    expect(resolveActiveHref(hrefs, '/messages/manage', aliases)).toBe('/messages/manage')
  })

  test('an alias to an href that is not in the nav is ignored', () => {
    expect(resolveActiveHref(['/'], '/beschluesse', aliases)).toBeNull()
  })
})

describe('Sidebar: exactly one aria-current link', () => {
  test.each(['/messages', '/messages/manage', '/messages/manage/rooms', '/', '/protokolle', '/beschluesse'])(
    'at %s',
    (path) => {
      const { container } = render(Sidebar, { props: { nav, activeHref: path } })
      const current = container.querySelectorAll('[aria-current="page"]')
      expect(current.length).toBe(1)
    }
  )

  test('at /messages/manage the current link is the manage entry', () => {
    const { container } = render(Sidebar, { props: { nav, activeHref: '/messages/manage' } })
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/messages/manage')
  })
})
