import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: () => Promise.resolve() }))

import Page from './+page.svelte'

beforeEach(() => { vi.stubGlobal('confirm', () => true) })
afterEach(() => { vi.unstubAllGlobals() })

describe('Verteilerlisten — deleteList error feedback (#183)', () => {
  it('surfaces an error when the DELETE fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { getByText, findByText } = render(Page, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { lists: [{ id: 1, name: 'Test-Liste' }] } } as any,
    })
    await fireEvent.click(getByText('Löschen'))
    expect(await findByText('Liste konnte nicht gelöscht werden.')).toBeTruthy()
  })

  it('shows no error when the DELETE succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    const { getByText, queryByText } = render(Page, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { data: { lists: [{ id: 1, name: 'Test-Liste' }] } } as any,
    })
    await fireEvent.click(getByText('Löschen'))
    await new Promise((r) => setTimeout(r, 0))
    expect(queryByText('Liste konnte nicht gelöscht werden.')).toBeNull()
  })
})
