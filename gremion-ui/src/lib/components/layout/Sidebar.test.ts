import { describe, test, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import Sidebar from './Sidebar.svelte'
import type { NavItem } from './nav-schema'

const minimalNav: NavItem[] = [
  { kind: 'item', href: '/', label: 'Home' },
  { kind: 'item', href: '/calendar', label: 'Kalender' },
  {
    kind: 'section',
    label: 'Finanzen',
    children: [
      { kind: 'item', href: '/finance', label: 'Übersicht' },
      { kind: 'item', href: '/finance/approvals', label: 'Freigaben', badge: 'count' }
    ]
  }
]

describe('Sidebar', () => {
  // getByText throws if the element is absent, so finding it is itself the
  // assertion; we use core matchers (jest-dom's custom matchers don't register
  // cleanly under the browser resolve condition this repo needs for mounting).
  test('renders top-level items', () => {
    const { getByText } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/', counts: { approvals: 3, liveVotes: 1, unread: 0 } }
    })
    expect(getByText('Home')).toBeTruthy()
    expect(getByText('Kalender')).toBeTruthy()
  })

  test('renders section header + children', () => {
    const { getByText } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 0 } }
    })
    expect(getByText('Finanzen')).toBeTruthy()
    expect(getByText('Übersicht')).toBeTruthy()
  })

  test('shows count badge on Freigaben when counts.approvals > 0', () => {
    const { getByText } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/', counts: { approvals: 3, liveVotes: 0, unread: 0 } }
    })
    expect(getByText('3')).toBeTruthy()
  })

  test('omits count badge when 0', () => {
    const { queryByText } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 0 } }
    })
    expect(queryByText('0')).toBeNull()
  })

  test('renders live badge from counts.liveVotes', () => {
    const navWithVotes: NavItem[] = [
      { kind: 'item', href: '/votes', label: 'Abstimmungen', badge: 'live' }
    ]
    const { getByText } = render(Sidebar, {
      props: { nav: navWithVotes, activeHref: '/', counts: { approvals: 0, liveVotes: 2, unread: 0 } }
    })
    expect(getByText('2')).toBeTruthy()
  })

  test('renders the neutral unread badge from counts.unread, distinct from .live', () => {
    const navWithMessages: NavItem[] = [
      { kind: 'item', href: '/messages', label: 'Matrix · Chat', badge: 'unread' }
    ]
    const { getByText } = render(Sidebar, {
      props: { nav: navWithMessages, activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 7 } }
    })
    const badge = getByText('7')
    expect(badge).toBeTruthy()
    // Neutral count badge — must NOT carry the .live (pine pulse) modifier.
    expect(badge.classList.contains('sb-badge')).toBe(true)
    expect(badge.classList.contains('live')).toBe(false)
  })

  test('omits the unread badge when counts.unread is 0', () => {
    const navWithMessages: NavItem[] = [
      { kind: 'item', href: '/messages', label: 'Matrix · Chat', badge: 'unread' }
    ]
    const { container } = render(Sidebar, {
      props: { nav: navWithMessages, activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 0 } }
    })
    expect(container.querySelector('.sb-badge')).toBeNull()
  })

  test('highlights active item via active class', () => {
    const { container } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/calendar', counts: { approvals: 0, liveVotes: 0, unread: 0 } }
    })
    const active = container.querySelector('.sb-item.active')
    expect(active?.textContent).toContain('Kalender')
  })
})

describe('Sidebar footer — friendly role pills only (WP-2 identity-leakage fix)', () => {
  const footerProps = {
    nav: minimalNav,
    activeHref: '/',
    counts: { approvals: 0, liveVotes: 0, unread: 0 },
    userName: 'Dev Admin'
  }

  test('renders the FRIENDLY role label, never the raw realm-role key', () => {
    const { getByText, queryByText } = render(Sidebar, {
      props: { ...footerProps, roles: ['it-admin'] }
    })
    // roleLabels maps 'it-admin' → 'IT-Administration'; the raw key never leaks.
    expect(getByText('IT-Administration')).toBeTruthy()
    expect(queryByText('it-admin')).toBeNull()
  })

  test('never renders Keycloak GROUP pills (the group-pill loop is gone)', () => {
    const { getByText, queryByText } = render(Sidebar, {
      props: { ...footerProps, roles: ['it-admin'], groups: ['mitglied', 'admin', 'ref-finanzen-kv'] }
    })
    // Roles still render as friendly labels…
    expect(getByText('IT-Administration')).toBeTruthy()
    // …but no group label (friendly OR raw) surfaces in the footer anymore.
    expect(queryByText('Administration')).toBeNull()
    expect(queryByText('Kassenverwaltung')).toBeNull()
    expect(queryByText('admin')).toBeNull()
    expect(queryByText('mitglied')).toBeNull()
    expect(queryByText('ref-finanzen-kv')).toBeNull()
  })

  test('caps the visible role pills at two', () => {
    const { getByText, queryByText } = render(Sidebar, {
      props: {
        ...footerProps,
        roles: ['it-admin', 'council-admin', 'member']
      }
    })
    expect(getByText('IT-Administration')).toBeTruthy()
    expect(getByText('Gremienverwaltung')).toBeTruthy()
    // Third role is sliced off.
    expect(queryByText('Mitglied')).toBeNull()
  })

  test('renders no role wrapper when there are no friendly roles to show', () => {
    const { container } = render(Sidebar, {
      props: { ...footerProps, roles: [] }
    })
    expect(container.querySelector('.role-pill')).toBeNull()
  })
})

describe('Sidebar brand mark — per-tenant logo (P2.2-data)', () => {
  const baseProps = {
    nav: minimalNav,
    activeHref: '/',
    counts: { approvals: 0, liveVotes: 0, unread: 0 }
  }

  test('renders the letter mark when brand.logoUrl is null (default — byte-identical)', () => {
    const { container } = render(Sidebar, {
      props: { ...baseProps, brand: { logoLetter: 'S', logoUrl: null } }
    })
    const mark = container.querySelector('.sb-logo')
    expect(mark?.tagName).toBe('DIV')
    expect(mark?.textContent).toBe('S')
    expect(container.querySelector('img.sb-logo')).toBeNull()
  })

  test('renders an <img> with the same .sb-logo box when brand.logoUrl is set', () => {
    const { container } = render(Sidebar, {
      props: { ...baseProps, brand: { orgShort: 'Stadt WR', logoUrl: 'https://cdn.example.org/logo.svg' } }
    })
    const img = container.querySelector('img.sb-logo')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe('https://cdn.example.org/logo.svg')
    expect(img?.getAttribute('alt')).toBe('Stadt WR')
    // The letter-mark div is replaced, not duplicated.
    expect(container.querySelectorAll('.sb-logo').length).toBe(1)
  })
})

describe('Sidebar legal block', () => {
  test('renders Impressum, Datenschutz and Barrierefreiheit links at the sidebar bottom', () => {
    const { getByText } = render(Sidebar, {
      props: { nav: minimalNav, activeHref: '/', counts: { approvals: 0, liveVotes: 0, unread: 0 } }
    })
    const impressum = getByText('Impressum')
    const datenschutz = getByText('Datenschutz')
    const barrierefreiheit = getByText('Barrierefreiheit')
    expect(impressum.getAttribute('href')).toBe('/legal/impressum')
    expect(datenschutz.getAttribute('href')).toBe('/legal/datenschutz')
    expect(barrierefreiheit.getAttribute('href')).toBe('/legal/barrierefreiheit')
  })
})
