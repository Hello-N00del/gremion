// R27-SIGNIN-LEGAL-K TDD: /auth/login must link to the three public legal
// routes (Impressum, Datenschutz, Barrierefreiheit) so an anonymous visitor
// -- and a URL-rating crawler that never runs JS -- can reach them from the
// server-rendered HTML, before onMount's signIn() call bounces the browser
// to Keycloak (section 5 DDG "easily recognisable, directly reachable" /
// Art. 13 GDPR at the point of data collection / BITV 2.0 / EN 301 549).
// The page renders three branches (forbidden / loggedOut / default-redirect)
// gated on $app/state's `page.url` search params; both fixtures below are
// covered because the default branch is the one a real anonymous visitor
// and an un-JS'd crawler actually see.
const { mockPage } = vi.hoisted(() => ({
  mockPage: { url: new URL('http://localhost/auth/login'), data: {} as Record<string, unknown> }
}))

vi.mock('$app/state', () => ({ page: mockPage }))
// The real signIn() would call the Auth.js client, which has no network/DOM
// double in jsdom; the default branch's onMount calls it unconditionally, so
// it is stubbed for every test here regardless of which branch is asserted.
vi.mock('@auth/sveltekit/client', () => ({ signIn: vi.fn() }))

import { describe, test, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import Page from './+page.svelte'

const EXPECTED_HREFS = ['/legal/impressum', '/legal/datenschutz', '/legal/barrierefreiheit']
const EXPECTED_LABELS = ['Impressum', 'Datenschutz', 'Barrierefreiheit']
// R27-SIGNIN-LEGAL-K round 2 (house review HIGH): /auth/login is the one route
// content-locale.ts proves translated (i18n-handle.test.ts:148 -- an en-US
// visitor gets <html lang="en">, not the German-with-data-ui-locale fallback),
// so an English visitor must see English vernacular here, not the German
// words parked in the EN catalogue (WCAG 2.2 SC 3.1.2 Language of Parts).
const EXPECTED_LABELS_EN = ['Legal notice', 'Privacy', 'Accessibility']

afterEach(() => {
  document.documentElement.lang = ''
})

describe('/auth/login legal links (R27-SIGNIN-LEGAL-K)', () => {
  test('the default (redirecting) branch -- what an anonymous visitor and a JS-less crawler see -- renders all three links in a footer landmark', () => {
    mockPage.url = new URL('http://localhost/auth/login')
    const { container } = render(Page)

    const footer = container.querySelector('footer')
    expect(footer).not.toBeNull()

    const anchors = Array.from(footer!.querySelectorAll('a'))
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(EXPECTED_HREFS)
    expect(anchors.map((a) => a.textContent?.trim())).toEqual(EXPECTED_LABELS)
    // The targets are German pages regardless of the visitor's locale.
    expect(anchors.map((a) => a.getAttribute('hreflang'))).toEqual(['de', 'de', 'de'])
    // WCAG 2.2 SC 2.5.8 (target size, min 24x24 CSS px) is met by the
    // `.signin-legal a { min-height: 24px }` rule in +page.svelte (mirroring
    // LegalMenu's `.legal-list a`, same 24px floor) -- jsdom's getComputedStyle
    // does not run real layout/cascade, so the 24px floor is verified by code
    // inspection rather than asserted here.
  })

  test('the forbidden branch (an authenticated user bounced by a role guard) also renders all three links', () => {
    mockPage.url = new URL('http://localhost/auth/login?error=forbidden')
    const { container, getByText } = render(Page)

    const footer = container.querySelector('footer')
    expect(footer).not.toBeNull()
    expect(getByText('Kein Zugriff')).toBeTruthy() // sanity: the forbidden branch, not the default one

    const impressum = getByText('Impressum')
    const datenschutz = getByText('Datenschutz')
    const barrierefreiheit = getByText('Barrierefreiheit')
    expect(impressum.closest('footer')).toBe(footer)
    expect(impressum.getAttribute('href')).toBe('/legal/impressum')
    expect(datenschutz.getAttribute('href')).toBe('/legal/datenschutz')
    expect(barrierefreiheit.getAttribute('href')).toBe('/legal/barrierefreiheit')
  })

  test('the loggedOut branch also renders all three links', () => {
    mockPage.url = new URL('http://localhost/auth/login?loggedOut=1')
    const { container, getByText } = render(Page)

    expect(getByText('Sie wurden abgemeldet')).toBeTruthy() // sanity: the loggedOut branch
    const hrefs = Array.from(container.querySelectorAll('footer a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(EXPECTED_HREFS)
  })

  test('an en-US visitor (<html lang="en">, the server-decided content locale) sees English labels, same hrefs', () => {
    document.documentElement.lang = 'en'
    mockPage.url = new URL('http://localhost/auth/login')
    const { container } = render(Page)

    const footer = container.querySelector('footer')
    expect(footer).not.toBeNull()
    const anchors = Array.from(footer!.querySelectorAll('a'))
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(EXPECTED_HREFS)
    expect(anchors.map((a) => a.textContent?.trim())).toEqual(EXPECTED_LABELS_EN)
    expect(anchors.map((a) => a.getAttribute('hreflang'))).toEqual(['de', 'de', 'de'])
  })
})
