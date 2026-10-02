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

import Page from './+page.svelte'

const DATA = {
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
})
