import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'

// Finding 9: with no public portal address configured the dashboard must not
// show a portal card that names "localhost". With an address it shows it.
const pageData: { brand: { domain: string } | undefined } = { brand: undefined }
vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/'),
    get data() {
      return pageData
    },
  },
}))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return { page: readable({ url: new URL('http://localhost/'), data: {} }) }
})

import Page from './+page.svelte'

const DATA = {
  session: { user: { id: 'u-1', name: 'Test Person', email: 't@example.org', roles: [], groups: [] } },
  unplaced: false,
  counts: {},
  upcomingEvents: [],
  nextMeeting: null,
  budgetSummary: null,
  myApprovals: [],
  myApprovalsCount: 0,
}

describe('dashboard portal card (finding 9)', () => {
  it('renders no portal card and no "localhost" when the portal domain is empty', () => {
    pageData.brand = { domain: '' }
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(container.textContent).not.toMatch(/localhost/i)
    expect(container.textContent).not.toMatch(/Öffentliches Portal/)
  })

  it('renders no portal card when the domain is the local placeholder', () => {
    pageData.brand = { domain: 'localhost' }
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(container.textContent).not.toMatch(/localhost/i)
    expect(container.textContent).not.toMatch(/Öffentliches Portal/)
  })

  it('shows the portal card with the domain when one is configured', () => {
    pageData.brand = { domain: 'stura.example.org' }
    const { container } = render(Page, { props: { data: DATA } as never })
    expect(container.textContent).toMatch(/Öffentliches Portal/)
    expect(container.textContent).toMatch(/stura\.example\.org/)
  })
})
