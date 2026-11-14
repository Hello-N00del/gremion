import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'

const { state } = vi.hoisted(() => ({ state: { data: {} as Record<string, unknown> } }))
vi.mock('$app/state', () => ({
  page: {
    get data() {
      return state.data
    },
  },
}))

import PageTitle from './PageTitle.svelte'
import { documentTitle } from './page-title'

afterEach(() => {
  cleanup()
  state.data = {}
  document.title = ''
})

describe('documentTitle', () => {
  it('puts the page first, then the organisation, then the product', () => {
    expect(documentTitle('Kalender', { orgName: 'Studierendenrat Musterstadt', product: 'Gremion' })).toBe(
      'Kalender – Studierendenrat Musterstadt – Gremion',
    )
  })

  it('names the organisation on a page without a segment (the sign-in screen)', () => {
    expect(documentTitle(undefined, { orgName: 'Studierendenrat Musterstadt', product: 'Gremion' })).toBe(
      'Studierendenrat Musterstadt – Gremion',
    )
  })

  it('says a name once when the organisation and the product are the same', () => {
    expect(documentTitle('Kalender', { orgName: 'Gremion', product: 'gremion ' })).toBe('Kalender – Gremion')
    expect(documentTitle(undefined, { orgName: 'Portal', product: 'Portal' })).toBe('Portal')
  })

  it('leaves out a blank segment instead of printing a stray separator', () => {
    expect(documentTitle('   ', { orgName: 'Studierendenrat Musterstadt', product: 'Gremion' })).toBe(
      'Studierendenrat Musterstadt – Gremion',
    )
  })
})

describe('PageTitle', () => {
  it('writes the organisation name from the layout brand into the tab title', () => {
    state.data = { brand: { product: 'Gremion', orgName: 'Studierendenrat Musterstadt' } }
    render(PageTitle, { props: { title: 'Protokolle' } })
    expect(document.title).toBe('Protokolle – Studierendenrat Musterstadt – Gremion')
  })

  it('falls back to the neutral product when no brand is loaded', () => {
    render(PageTitle, { props: { title: 'Protokolle' } })
    expect(document.title).toBe('Protokolle – Portal')
  })
})
