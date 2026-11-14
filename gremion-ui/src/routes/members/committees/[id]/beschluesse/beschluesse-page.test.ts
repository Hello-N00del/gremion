import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'

// F1-FIX-10-K / K2#5: "CSV Export" fetched /api/committees/:id/beschluesse?format=csv,
// but that endpoint ignores `format` and answers JSON, so the button saved JSON
// under a .csv name (and swallowed any failure). Until a real text/csv branch
// exists the page must not offer the button.
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: readable({
      url: new URL('http://localhost/members/committees/c1/beschluesse'),
      data: { user: { roles: ['council-admin', 'it-admin'] } },
    }),
  }
})

// The committee comes from the parent layout's load; <PageTitle> reads the brand from $app/state.
vi.mock('$app/state', () => ({ page: { data: {} } }))

import Page from './+page.svelte'

const DATA = {
  committee: { id: 'c1', name: 'Finanzausschuss' },
  committeeId: 'c1',
  entries: [
    { global_nr: 1, type: 'beschluss', text: 'Haushalt 2026', meeting_date: '2026-03-01', result: 'passed', protocol_id: 'p1' },
  ],
}

describe('Beschlussregister page (K2#5)', () => {
  it('offers no CSV export that downloads JSON, even to a CouncilAdmin', () => {
    render(Page, { props: { data: DATA } as never })
    expect(screen.queryByRole('button', { name: /CSV/i })).toBeNull()
  })

  it('still lists the register entries', () => {
    render(Page, { props: { data: DATA } as never })
    expect(screen.getByText('Haushalt 2026')).toBeTruthy()
  })

  it('sets a browser title that names the committee', () => {
    render(Page, { props: { data: DATA } as never })
    expect(document.title).toBe('Beschlüsse – Finanzausschuss – Portal')
  })
})

// A resolution nobody voted on (marked by the register API) is not a decision:
// the register must not print the rule engine's placeholder "Abgelehnt" for it.
describe('Beschlussregister page: a resolution nobody voted on', () => {
  const entry = (over: Record<string, unknown>) => ({
    global_nr: 'B-2026-002', type: 'beschluss', text: 'Antrag ohne Abstimmung', meeting_date: '2026-03-01',
    result: 'rejected', protocol_id: 'p1', untallied: false, ...over,
  })
  const rowText = (text: string) => screen.getByText(text).closest('tr')!.textContent ?? ''

  it('shows "keine Abstimmung" instead of "Abgelehnt"', () => {
    render(Page, { props: { data: { committeeId: 'c1', entries: [entry({ untallied: true })] } } as never })
    expect(rowText('Antrag ohne Abstimmung')).toMatch(/keine Abstimmung/)
    expect(rowText('Antrag ohne Abstimmung')).not.toMatch(/Abgelehnt|Angenommen/)
  })

  it('still shows a counted rejection as "Abgelehnt"', () => {
    render(Page, { props: { data: { committeeId: 'c1', entries: [entry({ text: 'Abgelehnter Antrag' })] } } as never })
    expect(rowText('Abgelehnter Antrag')).toMatch(/Abgelehnt/)
    expect(rowText('Abgelehnter Antrag')).not.toMatch(/keine Abstimmung/)
  })
})
