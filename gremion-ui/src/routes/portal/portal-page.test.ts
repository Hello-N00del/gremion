import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'

// F1-FIX-10-K / K2#2: the Portal-Verwaltung page was a facade. Its section
// toggles are persisted as config.org.portal_sections, but NOTHING reads that
// value (gremion-public never consults it), and its status/compliance lines
// ("Portal ist öffentlich", "Cookie-Banner aktiv", "TLS 1.3", ...) were hard-coded
// claims. Until gremion-public reads the flags the page must not offer a control
// that does nothing, and must not assert facts it does not know.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('http://localhost/portal'), data: {} }) }
})
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/portal'), data: {} } }))

import Page from './+page.svelte'

const DATA = { domain: 'stura.example.edu', portalSections: { news: true, board: true, budget: false } }

describe('portal page (K2#2)', () => {
  it('renders no toggle, radio or segmented control that nothing reads', () => {
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(container.querySelectorAll('input[type="checkbox"], input[type="radio"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Veröffentlichen/ })).toBeNull()
  })

  it('asserts no hard-coded compliance or status facts', () => {
    const { container } = render(Page, { props: { data: DATA } as never })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/Cookie-Banner aktiv/)
    expect(text).not.toMatch(/Keine Drittanbieter-Tracker/)
    expect(text).not.toMatch(/Datenschutzerklärung verlinkt/)
    expect(text).not.toMatch(/Portal ist öffentlich/)
    expect(text).not.toMatch(/TLS 1\.3/)
  })

  it('says plainly that portal sections are not controllable yet and still shows the domain', () => {
    render(Page, { props: { data: DATA } as never })
    expect(screen.getByTestId('portal-not-wired').textContent).toMatch(/noch nicht/)
    expect(screen.getAllByText(/stura\.example\.edu/).length).toBeGreaterThan(0)
  })

  it('with no domain says plainly that no portal is set up, links to the setting and shows no sample domain', () => {
    const { container } = render(Page, { props: { data: { ...DATA, domain: '' } } as never })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/example\.edu/)
    expect(text).not.toMatch(/localhost/i)
    expect(screen.getByTestId('portal-not-set-up').textContent).toMatch(/kein öffentliches Portal/)
    expect(container.querySelector('a[href="/settings/dienste"]')).not.toBeNull()
    // no preview link to a made-up address
    expect(container.querySelector('a[href^="https://"]')).toBeNull()
  })

  it('with a domain set shows it and the preview link', () => {
    const { container } = render(Page, { props: { data: { ...DATA, domain: 'stura.example.org' } } as never })
    expect(container.textContent).toMatch(/stura\.example\.org/)
    expect(container.querySelector('a[href="https://stura.example.org"]')).not.toBeNull()
    expect(screen.queryByTestId('portal-not-set-up')).toBeNull()
  })
})
