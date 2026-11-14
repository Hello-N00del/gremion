import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import Page from './+page.svelte'

// The source of a member address is shown in German: "(manuell)" for a hand-entered address and
// "(CSV)" for an imported one, never the raw column value "manual".

function renderWith(source: 'manual' | 'csv') {
  return render(Page, {
    props: {
      data: {
        list: { id: 'l1', name: 'Verteiler' },
        members: [{ id: 'm1', email: 'person1@example.org', name: null, source }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
}

describe('distribution list member source label', () => {
  it('shows "(manuell)" for a hand-entered address', () => {
    expect(renderWith('manual').container.querySelector('.src')?.textContent?.trim()).toBe('(manuell)')
  })

  it('shows "(CSV)" for an imported address', () => {
    expect(renderWith('csv').container.querySelector('.src')?.textContent?.trim()).toBe('(CSV)')
  })
})
