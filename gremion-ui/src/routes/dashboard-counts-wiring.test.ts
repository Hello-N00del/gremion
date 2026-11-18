import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'

// The page must show the counts the server computed over the whole 30-day window, not
// re-count the six-row preview list it also receives. Here the preview holds no "mine"
// row and only six rows, while the server says 2 of 8; the tile and the head sentence
// must read 2 and 8.
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/'), data: { brand: { domain: '' } } },
}))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('http://localhost/'), data: {} }) }
})

import Page from './+page.svelte'

const preview = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `ev-${n}`,
  startIso: new Date(Date.UTC(2099, 0, n)).toISOString(),
  title: `Sitzung ${n}`,
  where: '',
  mine: false,
  hue: 252,
}))

const DATA = {
  session: { user: { id: 'u-1', name: 'Vera Vorstand', email: 'v@example.org', roles: [], groups: [] } },
  unplaced: false,
  counts: {},
  upcomingEvents: preview,
  upcomingCount: 8,
  myEventCount: 2,
  nextMeeting: null,
  budgetSummary: null,
  myApprovals: [],
  myApprovalsCount: 0,
}

function tile(container: HTMLElement, label: RegExp): string | undefined {
  const kpi = Array.from(container.querySelectorAll('.kpi')).find((k) =>
    label.test(k.querySelector('.label')?.textContent ?? ''),
  )
  return kpi?.querySelector('.val')?.textContent?.trim()
}

describe('dashboard counts come from the server, not the preview list', () => {
  it('shows the window counts in the KPI tiles', () => {
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(tile(container, /Anstehende Termine/)).toBe('8')
    expect(tile(container, /In meinen/)).toBe('2')
  })

  it('shows the window count of "mine" in the head sentence', () => {
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(container.querySelector('.page-sub')?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^2 Termine in deinen /,
    )
  })
})
