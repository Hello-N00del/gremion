import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'

import Page from './+page.svelte'

// The member count above the rows is German grammar: 1 Mitglied, 2 Mitglieder.

function member(n: number) {
  return { id: `m${n}`, email: `person${n}@example.org`, name: null, source: 'manual' }
}

function renderList(count: number) {
  return render(Page, {
    props: {
      data: { list: { id: 'l1', name: 'Verteiler' }, members: Array.from({ length: count }, (_, i) => member(i + 1)) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
}

describe('distribution list member count', () => {
  it('reads "1 Mitglied" for one recipient', () => {
    const { getByRole } = renderList(1)
    expect(getByRole('heading', { level: 2 }).textContent?.trim()).toBe('1 Mitglied')
  })

  it('reads "2 Mitglieder" for two recipients', () => {
    const { getByRole } = renderList(2)
    expect(getByRole('heading', { level: 2 }).textContent?.trim()).toBe('2 Mitglieder')
  })

  it('reads "0 Mitglieder" for an empty list', () => {
    const { getByRole } = renderList(0)
    expect(getByRole('heading', { level: 2 }).textContent?.trim()).toBe('0 Mitglieder')
  })
})
